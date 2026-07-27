'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const test = require('node:test');

const {
  MIGRATION_COMMAND_ABORTED_CODE,
  MIGRATION_COMMAND_TIMEOUT_CODE,
  clearStalePortProcess,
  prismaCommandExitStatus,
  runPrisma,
} = require('../scripts/start-with-migrations');

const DIRECT_URL = 'postgres://migration-user:migration-secret@db.internal/app';
const WRAPPER_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../scripts/start-with-migrations.js'),
  'utf8',
);

function isLiveNonZombie(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform !== 'linux') return true;
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.split(' ')[2] !== 'Z';
  } catch {
    return false;
  }
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

function waitForMessage(child, predicate, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for child IPC message'));
    }, timeoutMs);
    const onMessage = (message) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`child exited before IPC result: code=${code} signal=${signal}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('message', onMessage);
      child.removeListener('exit', onExit);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

test('migration wrapper contains no synchronous child-process execution', () => {
  assert.doesNotMatch(WRAPPER_SOURCE, /\bspawnSync\b/);
  assert.match(WRAPPER_SOURCE, /\bspawn\b/);
});

test('timed-out Prisma command kills a stubborn descendant process', {
  skip: process.platform === 'win32',
  timeout: 8_000,
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-tree-timeout-'));
  const pidFile = path.join(directory, 'descendant.pid');
  let descendantPid;
  t.after(() => {
    try {
      if (descendantPid) process.kill(descendantPid, 'SIGKILL');
    } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const leaderSource = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, ['-e',",
    "  \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"",
    "], { stdio: 'ignore' });",
    "fs.writeFileSync(process.argv[1], String(child.pid));",
    "process.on('SIGTERM', () => {});",
    "setInterval(() => {}, 1000);",
  ].join('\n');

  const result = await runPrisma(['-e', leaderSource, pidFile], {
    command: process.execPath,
    commandPrefix: [],
    cwd: __dirname,
    env: {
      ...process.env,
      DIRECT_DATABASE_URL: DIRECT_URL,
      DATABASE_URL: '',
      PRISMA_DATABASE_URL: '',
    },
    timeoutMs: 150,
    killGraceMs: 50,
    pipe: false,
  });

  assert.equal(result.migrationCode, MIGRATION_COMMAND_TIMEOUT_CODE);
  assert.equal(prismaCommandExitStatus(result), 124);
  descendantPid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
  assert.equal(
    await waitUntil(() => !isLiveNonZombie(descendantPid)),
    true,
    `descendant ${descendantPid} survived migration timeout`,
  );
});

test('SIGTERM stays responsive while Prisma runs and aborts its process group', {
  skip: process.platform === 'win32',
  timeout: 8_000,
}, async (t) => {
  const wrapperPath = path.resolve(__dirname, '../scripts/start-with-migrations.js');
  const harnessSource = `
    const { runPrisma, prismaCommandExitStatus } = require(${JSON.stringify(wrapperPath)});
    const controller = new AbortController();
    process.on('SIGTERM', () => controller.abort('SIGTERM'));
    process.send({ type: 'ready' }, async () => {
      const startedAt = Date.now();
      const result = await runPrisma(
        ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        {
          command: process.execPath,
          commandPrefix: [],
          cwd: ${JSON.stringify(__dirname)},
          env: {
            ...process.env,
            DIRECT_DATABASE_URL: ${JSON.stringify(DIRECT_URL)},
            DATABASE_URL: '',
            PRISMA_DATABASE_URL: '',
          },
          timeoutMs: 1200,
          killGraceMs: 50,
          pipe: false,
          signal: controller.signal,
        },
      );
      process.send({
        type: 'result',
        elapsedMs: Date.now() - startedAt,
        migrationCode: result.migrationCode,
        status: prismaCommandExitStatus(result),
      }, () => process.exit(0));
    });
  `;
  const harness = spawn(process.execPath, ['-e', harnessSource], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(() => {
    try { process.kill(-harness.pid, 'SIGKILL'); } catch {}
  });

  await waitForMessage(harness, (message) => message?.type === 'ready');
  const resultPromise = waitForMessage(harness, (message) => message?.type === 'result');
  process.kill(harness.pid, 'SIGTERM');
  const result = await resultPromise;

  assert.equal(result.migrationCode, MIGRATION_COMMAND_ABORTED_CODE);
  assert.equal(result.status, 143);
  assert.ok(result.elapsedMs < 750, `SIGTERM was blocked for ${result.elapsedMs}ms`);
  await once(harness, 'exit');
});

test('stale-port cleanup delegates to the bounded process runner', async () => {
  let invocation;
  const result = await clearStalePortProcess({
    env: { PORT: '5050', BOOT_COMMAND_TIMEOUT_MS: '321' },
    runProcessImpl: async (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.status, 0);
  assert.equal(invocation.command, 'fuser');
  assert.deepEqual(invocation.args, ['-k', '5050/tcp']);
  assert.equal(invocation.options.timeoutMs, 321);
});
