'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');

const runner = require('../src/services/github/workspace-runner.service');
const { readWindowsProcessList } = require('../src/utils/windows-process-tree');

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sira-run-'));
}

function runIsolatedProbe(source, timeout = 10_000) {
  return spawnSync(process.execPath, ['-e', source], {
    encoding: 'utf8',
    timeout,
  });
}

test('importing workspace runner does not claim process signal ownership', () => {
  const servicePath = require.resolve('../src/services/github/workspace-runner.service');
  const probe = `
    const before = {
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
    };
    require(${JSON.stringify(servicePath)});
    const after = {
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
    };
    process.stdout.write(JSON.stringify({ before, after }));
  `;
  const result = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const counts = JSON.parse(result.stdout);
  assert.deepEqual(counts.after, counts.before);
});

test('workspace runner never exits the host process', () => {
  const source = fs.readFileSync(
    require.resolve('../src/services/github/workspace-runner.service'),
    'utf8',
  );

  assert.doesNotMatch(source, /\bprocess\.exit\s*\(/);
});

test('Windows tree tracker captures a late child while leader lives, then its reparented child', () => {
  const proc = { pid: 700, exitCode: null, signalCode: null };
  let processList = [
    { pid: 700, parentPid: 1 },
  ];
  const tracker = runner._createWindowsProcessTreeTracker(proc, {
    processListImpl: () => processList,
  });

  processList = [
    { pid: 700, parentPid: 1 },
    { pid: 701, parentPid: 700 },
  ];
  assert.equal(tracker.isAlive(), true);
  assert.deepEqual(Array.from(tracker.knownPids), [701]);

  proc.exitCode = 0;
  processList = [
    { pid: 701, parentPid: 1 },
    { pid: 702, parentPid: 701 },
  ];
  assert.equal(tracker.isAlive(), true);
  assert.deepEqual(Array.from(tracker.knownPids), [701, 702]);
  processList = [];
  assert.equal(tracker.isAlive(), false);
});

test('workspace tree waiter polls liveness before the leader exits', async () => {
  const proc = new EventEmitter();
  proc.pid = 750;
  proc.exitCode = null;
  proc.signalCode = null;
  let checks = 0;
  const scheduled = [];
  const waiting = runner._waitForProcessTreeQuiescence(proc, {
    isProcessTreeAlive: () => {
      checks += 1;
      return checks < 2;
    },
    pollIntervalMs: 10,
    setTimeoutFn: (callback) => {
      const timer = { callback };
      scheduled.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });

  await Promise.resolve();
  assert.equal(checks, 1);
  assert.equal(scheduled.length, 1);
  scheduled[0].callback();
  await waiting;
  assert.equal(checks, 2);
  assert.equal(proc.exitCode, null);
});

test('PowerShell process snapshots use a short bounded timeout and fail closed', () => {
  let receivedOptions;
  const error = new Error('PowerShell timed out');
  error.code = 'ETIMEDOUT';
  const processList = readWindowsProcessList({
    spawnSyncImpl: (_command, _args, options) => {
      receivedOptions = options;
      return { status: null, error };
    },
  });

  assert.equal(processList, null);
  assert.ok(receivedOptions.timeout > 0);
  assert.ok(receivedOptions.timeout <= 1000);
  assert.equal(receivedOptions.killSignal, 'SIGKILL');
});

test('Windows tracker refreshes known descendants after an initial snapshot failure', () => {
  const proc = { pid: 800, exitCode: null, signalCode: null };
  let callCount = 0;
  const tracker = runner._createWindowsProcessTreeTracker(proc, {
    processListImpl: () => {
      callCount += 1;
      if (callCount === 1) return null;
      return [{ pid: 801, parentPid: 800 }];
    },
  });

  proc.exitCode = 0;
  assert.equal(tracker.isAlive(), true, 'uncertain snapshot remains pending to deadline');
  assert.deepEqual(Array.from(tracker.knownPids), [801]);
});

test('shutdown atomically rejects a pending start and all later starts', () => {
  const servicePath = require.resolve('../src/services/github/workspace-runner.service');
  const probe = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const runner = require(${JSON.stringify(servicePath)});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-run-race-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>late</h1>');
    (async () => {
      const pendingStart = runner.start('late-start', dir);
      assert.equal(runner._pendingStarts.size, 1);
      const firstStop = runner.stopAll();
      assert.strictEqual(runner.stopAll(), firstStop);
      await assert.rejects(pendingStart, (error) => error && error.code === 'runner_stopping');
      await firstStop;
      await assert.rejects(
        runner.start('after-stop', dir),
        (error) => error && error.code === 'runner_stopping',
      );
      assert.equal(runner._runs.size, 0);
    })().then(
      () => { fs.rmSync(dir, { recursive: true, force: true }); },
      (error) => {
        fs.rmSync(dir, { recursive: true, force: true });
        console.error(error);
        process.exitCode = 1;
      },
    );
  `;
  const result = runIsolatedProbe(probe);

  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('stopAll waits for a real child to exit after graceful termination', () => {
  const servicePath = require.resolve('../src/services/github/workspace-runner.service');
  const probe = `
    const assert = require('node:assert/strict');
    const { once } = require('node:events');
    const { spawn } = require('node:child_process');
    const runner = require(${JSON.stringify(servicePath)});
    let child;
    (async () => {
      child = spawn(process.execPath, ['-e', [
        "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 120));",
        "if (process.send) process.send('ready');",
        "setInterval(() => {}, 1000);",
      ].join('')], {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      await once(child, 'message');
      runner._runs.set('real-child', {
        connectionId: 'real-child',
        status: 'ready',
        ready: true,
        proc: child,
        server: null,
        log: [],
        runtimeEnv: {},
      });
      const startedAt = Date.now();
      await runner.stopAll();
      const elapsedMs = Date.now() - startedAt;
      assert.notEqual(child.exitCode ?? child.signalCode, null);
      if (process.platform !== 'win32') assert.ok(elapsedMs >= 80, String(elapsedMs));
    })().catch((error) => {
      try {
        if (child && child.exitCode === null) {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        }
      } catch {}
      console.error(error);
      process.exitCode = 1;
    });
  `;
  const result = runIsolatedProbe(probe);

  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('stopAll keeps a stubborn Unix grandchild pending until group escalation', {
  skip: process.platform !== 'linux',
}, () => {
  const servicePath = require.resolve('../src/services/github/workspace-runner.service');
  const probe = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const { once } = require('node:events');
    const { spawn } = require('node:child_process');
    process.env.SIRAGPT_WORKSPACE_RUN_STOP_GRACE_MS = '250';
    process.env.SIRAGPT_WORKSPACE_RUN_FORCE_WAIT_MS = '500';
    const runner = require(${JSON.stringify(servicePath)});
    const grandchildSource = [
      "process.on('SIGTERM', () => {});",
      "if (process.send) process.send('ready');",
      "setInterval(() => {}, 1000);",
    ].join('');
    const leaderSource = [
      "const { spawn } = require('node:child_process');",
      "const source = " + JSON.stringify(grandchildSource) + ";",
      "const grandchild = spawn(process.execPath, ['-e', source],",
      " { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
      "grandchild.once('message', () => process.send({ grandchildPid: grandchild.pid }));",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join('');
    let leader;
    let grandchildPid;
    const isLiveNonZombie = (pid) => {
      try { return fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(' ')[2] !== 'Z'; }
      catch { return false; }
    };
    (async () => {
      leader = spawn(process.execPath, ['-e', leaderSource], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      [{ grandchildPid }] = await once(leader, 'message');
      runner._runs.set('stubborn-tree', {
        connectionId: 'stubborn-tree',
        status: 'ready',
        ready: true,
        proc: leader,
        server: null,
        log: [],
        runtimeEnv: {},
      });
      let completed = false;
      const startedAt = Date.now();
      const stopping = runner.stopAll().then(() => { completed = true; });
      await once(leader, 'exit');
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(completed, false);
      assert.equal(isLiveNonZombie(grandchildPid), true);
      await stopping;
      assert.ok(Date.now() - startedAt >= 200);
      const goneDeadline = Date.now() + 2000;
      while (isLiveNonZombie(grandchildPid) && Date.now() < goneDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(isLiveNonZombie(grandchildPid), false);
    })().catch((error) => {
      try { if (leader?.pid) process.kill(-leader.pid, 'SIGKILL'); } catch {}
      try { if (grandchildPid) process.kill(grandchildPid, 'SIGKILL'); } catch {}
      console.error(error);
      process.exitCode = 1;
    });
  `;
  const result = runIsolatedProbe(probe);

  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('stopAll force-kills an uncooperative child only after runner grace', () => {
  const servicePath = require.resolve('../src/services/github/workspace-runner.service');
  const probe = `
    const assert = require('node:assert/strict');
    const { EventEmitter } = require('node:events');
    process.env.SIRAGPT_WORKSPACE_RUN_STOP_GRACE_MS = '100';
    process.env.SIRAGPT_WORKSPACE_RUN_FORCE_WAIT_MS = '25';
    const runner = require(${JSON.stringify(servicePath)});
    const child = new EventEmitter();
    child.pid = null;
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.signals = [];
    child.kill = (signal) => { child.signals.push(signal); return true; };
    runner._runs.set('stubborn-child', {
      connectionId: 'stubborn-child',
      status: 'ready',
      ready: true,
      proc: child,
      server: null,
      log: [],
      runtimeEnv: {},
    });
    (async () => {
      const stopping = runner.stopAll();
      assert.deepEqual(child.signals, ['SIGTERM']);
      let settled = false;
      stopping.then(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(settled, false);
      await stopping;
      assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  const result = runIsolatedProbe(probe);

  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('detectRunPlan: next project', async () => {
  const dir = await tmpDir();
  try {
    await fsp.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { next: '14' }, scripts: { dev: 'next dev' } }),
    );
    const plan = runner.detectRunPlan(dir, 4321);
    assert.equal(plan.kind, 'node');
    assert.equal(plan.framework, 'next');
    assert.match(plan.command, /next dev -p 4321/);
    assert.match(plan.command, /npm install/); // no node_modules yet
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('detectRunPlan: vite project skips install when node_modules present', async () => {
  const dir = await tmpDir();
  try {
    await fsp.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { vite: '5' }, scripts: { dev: 'vite' } }),
    );
    await fsp.mkdir(path.join(dir, 'node_modules'));
    const plan = runner.detectRunPlan(dir, 4400);
    assert.equal(plan.framework, 'vite');
    assert.match(plan.command, /vite --port 4400 --host 127\.0\.0\.1 --strictPort/);
    assert.ok(!/npm install/.test(plan.command), 'install skipped');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('detectRunPlan: custom dev script', async () => {
  const dir = await tmpDir();
  try {
    await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
    const plan = runner.detectRunPlan(dir, 4500);
    assert.equal(plan.framework, 'custom-dev');
    assert.match(plan.command, /npm run dev/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('detectRunPlan: static site (index.html, no package.json)', async () => {
  const dir = await tmpDir();
  try {
    await fsp.writeFile(path.join(dir, 'index.html'), '<h1>hi</h1>');
    const plan = runner.detectRunPlan(dir, 4600);
    assert.equal(plan.kind, 'static');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('detectRunPlan: nothing runnable', async () => {
  const dir = await tmpDir();
  try {
    await fsp.writeFile(path.join(dir, 'README.md'), 'just docs');
    const plan = runner.detectRunPlan(dir, 4700);
    assert.equal(plan.kind, 'none');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('findFreePort returns a usable port in range', async () => {
  const port = await runner.findFreePort();
  assert.ok(port >= 4300 && port <= 4999, `port ${port} in range`);
});

test('status of unknown workspace is idle', () => {
  const s = runner.status('does-not-exist');
  assert.equal(s.running, false);
  assert.equal(s.status, 'idle');
});

test('normaliseRuntimeEnv keeps app env and rejects process overrides', () => {
  const env = runner.normaliseRuntimeEnv({
    openai_api_key: 'redacted',
    NEXT_PUBLIC_SITE_NAME: 'Sira',
    NODE_OPTIONS: '--require /tmp/evil.js',
    PATH: '/tmp/bin',
    'bad-key': 'x',
  });
  assert.equal(env.OPENAI_API_KEY, 'redacted');
  assert.equal(env.NEXT_PUBLIC_SITE_NAME, 'Sira');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.PATH, undefined);
  assert.equal(env['BAD-KEY'], undefined);
});

test('isRuntimeEnvFile identifies runtime env files but not templates', () => {
  assert.equal(runner.isRuntimeEnvFile('.env'), true);
  assert.equal(runner.isRuntimeEnvFile('.env.development'), true);
  assert.equal(runner.isRuntimeEnvFile('.env.development.local'), true);
  assert.equal(runner.isRuntimeEnvFile('packages/app/.env.local'), true);
  assert.equal(runner.isRuntimeEnvFile('.env.sample'), false);
  assert.equal(runner.isRuntimeEnvFile('.env.production.example'), false);
});

test('static server starts, serves, and stops', async () => {
  const dir = await tmpDir();
  try {
    await fsp.writeFile(path.join(dir, 'index.html'), '<h1>hello-run</h1>');
    const started = await runner.start('test-conn', dir);
    assert.equal(started.kind, 'static');
    assert.equal(started.ready, true);

    const localUrl = new URL('/', `http://127.0.0.1:${started.port}`);
    const body = await new Promise((resolve, reject) => {
      const http = require('http');
      http
        .get(localUrl, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve(data));
        })
        .on('error', reject);
    });
    assert.match(body, /hello-run/);

    const stopped = runner.stop('test-conn');
    assert.equal(stopped.stopped, true);
    assert.equal(runner.status('test-conn').status, 'idle');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
