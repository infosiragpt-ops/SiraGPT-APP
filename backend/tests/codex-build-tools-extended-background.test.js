'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { TOOLS } = require('../src/services/codex/build-tools');
const {
  createBackgroundTaskService,
  validateBackgroundCommand,
  launchWithRunner,
} = require('../src/services/codex/background-tasks');
const { createRunnerClient, RunnerError } = require('../src/services/codex/runner-client');

test('background command validation mirrors the runner allowlist', () => {
  assert.equal(validateBackgroundCommand(['node', 'worker.js']).ok, true);
  assert.equal(validateBackgroundCommand(['git', 'status']).ok, true);
  assert.equal(validateBackgroundCommand(['sh', '-c', 'rm -rf /']).ok, false);
  assert.equal(validateBackgroundCommand(['bunx', 'create-vite']).ok, false);
  assert.equal(validateBackgroundCommand('node worker.js').ok, false);
});

test('background service enforces the per-workspace limit and exposes cleanup', async () => {
  const operations = [];
  const service = createBackgroundTaskService({
    controlImpl: async ({ op }) => {
      operations.push(op);
      if (op === 'list') return { active: 1, tasks: [] };
      return { active: 0, tasks: [] };
    },
    launchImpl: async ({ task }) => ({ ...task, pid: 321, status: 'starting' }),
  });
  const started = await service.start({
    runner: {},
    project: 'p1',
    cmd: ['node', 'worker.js'],
    env: { CODEX_BACKGROUND_TASKS_PER_WORKSPACE: '2' },
  });
  assert.match(started.taskId, /^task_[a-f0-9]{24}$/);
  assert.equal(started.pid, 321);

  const limited = createBackgroundTaskService({
    controlImpl: async () => ({ active: 2, tasks: [] }),
    launchImpl: async () => assert.fail('must not launch above the limit'),
  });
  await assert.rejects(
    limited.start({
      runner: {},
      project: 'p1',
      cmd: ['node', 'worker.js'],
      env: { CODEX_BACKGROUND_TASKS_PER_WORKSPACE: '2' },
    }),
    (error) => error.code === 'BACKGROUND_TASK_LIMIT',
  );

  await service.cleanup({ runner: {}, project: 'p1' });
  assert.deepEqual(operations, ['list', 'cleanup']);
});

test('concurrent starts are serialized per workspace before enforcing the limit', async () => {
  let active = 0;
  const service = createBackgroundTaskService({
    controlImpl: async () => ({ active, tasks: [] }),
    launchImpl: async ({ task }) => {
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      active += 1;
      return { ...task, pid: 100 + active };
    },
  });
  const input = {
    runner: {},
    project: 'same-workspace',
    cmd: ['node', 'worker.js'],
    env: { CODEX_BACKGROUND_TASKS_PER_WORKSPACE: '1' },
  };
  const settled = await Promise.allSettled([
    service.start(input),
    service.start(input),
  ]);
  assert.equal(settled.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal(settled.filter((entry) => entry.status === 'rejected').length, 1);
  assert.equal(settled.find((entry) => entry.status === 'rejected').reason.code, 'BACKGROUND_TASK_LIMIT');
});

test('quiesce stops only control-plane registered tasks and rejects forged metadata', async () => {
  let status = 'running';
  const controlCalls = [];
  const service = createBackgroundTaskService({
    launchImpl: async ({ task }) => ({
      ...task,
      pid: 901,
      processStart: '12345',
      status: 'starting',
    }),
    controlImpl: async (request) => {
      controlCalls.push(request);
      if (request.op === 'list') {
        return {
          active: status === 'running' ? 1 : 0,
          tasks: [{ taskId: request.taskId || startedId, status }],
        };
      }
      if (request.op === 'stop') {
        assert.equal(request.expectedPid, 901);
        assert.equal(request.expectedProcessStart, '12345');
        assert.match(request.controlToken, /^[a-f0-9]{64}$/);
        status = 'stopped';
        return { task: { taskId: request.taskId, status } };
      }
      return { active: 0, tasks: [] };
    },
  });
  let startedId = null;
  const started = await service.start({
    runner: {},
    project: 'p1',
    cmd: ['node', 'worker.js'],
    env: { CODEX_BACKGROUND_TASKS_PER_WORKSPACE: '2' },
  });
  startedId = started.taskId;
  assert.equal(Object.hasOwn(started, 'controlToken'), false);
  const quiet = await service.quiesce({ runner: {}, project: 'p1', waitMs: 500 });
  assert.deepEqual(quiet, { ok: true, stopped: 1 });
  assert.equal(controlCalls.some((call) => call.op === 'stop'), true);

  assert.throws(
    () => service.stop({
      runner: {},
      project: 'p1',
      taskId: 'task_ffffffffffffffffffffffff',
    }),
    (error) => error.code === 'BACKGROUND_TASK_UNTRUSTED',
  );
});

test('run_command background, task_logs and task_stop use the injected service', async () => {
  const calls = [];
  const backgroundTaskService = {
    async start(input) {
      calls.push(['start', input]);
      return { taskId: 'task_0123456789abcdef01234567', pid: 44, status: 'starting' };
    },
    async logs(input) {
      calls.push(['logs', input]);
      return {
        task: { taskId: input.taskId, status: 'running' },
        log: 'server ready',
      };
    },
    async stop(input) {
      calls.push(['stop', input]);
      return { task: { taskId: input.taskId, status: 'stopping' } };
    },
  };
  const ctx = { runner: {}, project: 'p1', backgroundTaskService, env: {} };
  const started = await TOOLS.run_command.execute({ cmd: ['node', 'server.js'], background: true }, ctx);
  assert.equal(started.isError, false);
  assert.match(started.observation, /task_0123456789abcdef01234567/);

  const logs = await TOOLS.task_logs.execute({ taskId: 'task_0123456789abcdef01234567' }, ctx);
  assert.equal(logs.isError, false);
  assert.match(logs.observation, /server ready/);

  const stopped = await TOOLS.task_stop.execute({ taskId: 'task_0123456789abcdef01234567' }, ctx);
  assert.equal(stopped.isError, false);
  assert.match(stopped.summary, /stopping/);
  assert.deepEqual(calls.map(([name]) => name), ['start', 'logs', 'stop']);
});

test('default launcher delegates to a fixed node supervisor without a shell', async () => {
  let command = null;
  const runner = {
    async exec(_project, cmd) {
      command = cmd;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          taskId: 'task_0123456789abcdef01234567',
          pid: 10,
          status: 'starting',
        }),
        stderr: '',
      };
    },
  };
  const result = await launchWithRunner({
    runner,
    project: 'p1',
    task: {
      taskId: 'task_0123456789abcdef01234567',
      cmd: ['node', 'worker.js', 'value with spaces'],
      startedAt: new Date(0).toISOString(),
      timeoutMs: 10_000,
    },
  });
  assert.equal(result.pid, 10);
  assert.equal(command[0], 'node');
  assert.equal(command[1], '-e');
  assert.equal(command.includes('sh'), false);
});

test('real offline supervisor writes logs and task_stop terminates the process group', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-background-test-'));
  const runner = {
    async exec(_project, cmd) {
      return new Promise((resolve) => {
        // The bundled Codex runtime is invoked by absolute path and does not
        // necessarily expose a `node` shim in PATH. The real runner container
        // does; this offline adapter must resolve that same logical command to
        // the executable hosting the test. Leaving an ENOENT without an error
        // listener can also trip Node 24's test-runner async-id assertion on
        // macOS instead of reporting the actual spawn failure.
        const executable = cmd[0] === 'node' ? process.execPath : cmd[0];
        const proc = spawn(executable, cmd.slice(1), {
          cwd,
          env: {
            ...process.env,
            PATH: [path.dirname(process.execPath), process.env.PATH]
              .filter(Boolean)
              .join(path.delimiter),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        proc.stdout.on('data', (chunk) => { stdout += chunk; });
        proc.stderr.on('data', (chunk) => { stderr += chunk; });
        proc.on('error', (error) => finish({
          exitCode: 127,
          stdout,
          stderr: `${stderr}${error.message}`,
        }));
        proc.on('exit', (exitCode) => finish({ exitCode, stdout, stderr }));
      });
    },
  };
  const service = createBackgroundTaskService();
  let task = null;
  try {
    task = await service.start({
      runner,
      project: 'offline',
      cmd: ['node', '-e', "console.log('background-ready'); setInterval(() => console.log('tick'), 50)"],
      timeoutMs: 10_000,
      env: { CODEX_BACKGROUND_TASKS_PER_WORKSPACE: '1' },
    });
    await new Promise((resolve) => { setTimeout(resolve, 180); });
    const running = await service.logs({ runner, project: 'offline', taskId: task.taskId });
    assert.match(running.log, /background-ready/);
    assert.equal(['starting', 'running'].includes(running.task.status), true);

    await service.stop({ runner, project: 'offline', taskId: task.taskId });
    let final = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      final = await service.logs({ runner, project: 'offline', taskId: task.taskId });
      if (['stopped', 'failed', 'lost'].includes(final.task.status)) break;
    }
    assert.equal(final.task.status, 'stopped');
  } finally {
    if (task) {
      await service.stop({ runner, project: 'offline', taskId: task.taskId }).catch(() => {});
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runner client propagates cooperative cancellation to fetch', async () => {
  const controller = new AbortController();
  const fetchImpl = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const client = createRunnerClient({ fetchImpl, baseUrl: 'http://runner.test', timeoutMs: 10_000 });
  const pending = client.exec('p1', ['node', 'worker.js'], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof RunnerError && /runner unreachable/.test(error.message));
});
