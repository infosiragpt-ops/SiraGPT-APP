'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test, beforeEach } = require('node:test');

const shutdownReg = require('../src/utils/shutdown');

beforeEach(() => {
  shutdownReg._resetForTests();
});

describe('shutdown — register + run', () => {
  test('register requires name and fn', () => {
    assert.throws(() => shutdownReg.register('', () => {}), TypeError);
    assert.throws(() => shutdownReg.register('x', 'nope'), TypeError);
  });

  test('hooks execute in reverse-LIFO', async () => {
    const order = [];
    shutdownReg.register('a', () => { order.push('a'); });
    shutdownReg.register('b', () => { order.push('b'); });
    shutdownReg.register('c', () => { order.push('c'); });
    const r = await shutdownReg.shutdown('test');
    assert.deepEqual(order, ['c', 'b', 'a']);
    assert.equal(r.ok, true);
  });

  test('register after shutdown throws', async () => {
    await shutdownReg.shutdown('first');
    assert.throws(() => shutdownReg.register('a', () => {}));
  });
});

describe('shutdown — timeouts and isolation', () => {
  test('hook exceeding its timeout is reported but does not stop others', async () => {
    const ran = [];
    shutdownReg.register('fast', () => { ran.push('fast'); });
    shutdownReg.register('slow', () => new Promise((r) => setTimeout(r, 200)), 30);
    shutdownReg.register('also-fast', () => { ran.push('also-fast'); });
    const r = await shutdownReg.shutdown();
    assert.deepEqual(ran, ['also-fast', 'fast']);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].name, 'slow');
  });

  test('throwing hook is captured, others still run', async () => {
    const ran = [];
    shutdownReg.register('a', () => { ran.push('a'); });
    shutdownReg.register('boom', () => { throw new Error('oops'); });
    shutdownReg.register('c', () => { ran.push('c'); });
    const r = await shutdownReg.shutdown();
    assert.deepEqual(ran, ['c', 'a']);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].name, 'boom');
  });

  test('remaining global budget interrupts the active hook and skips later hooks', {
    timeout: 1000,
  }, async () => {
    let tailRan = false;
    shutdownReg.register('tail', () => { tailRan = true; });
    shutdownReg.register('hung', () => new Promise(() => {}), 250);
    shutdownReg.register('head', () => new Promise((resolve) => setTimeout(resolve, 35)), 100);

    const startedAt = Date.now();
    const result = await shutdownReg.shutdown('budget-test', { deadlineMs: 60 });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.ok, false);
    assert.equal(tailRan, false);
    assert.ok(elapsedMs < 180, `global budget must interrupt the active hook, elapsed=${elapsedMs}`);
    assert.equal(result.steps.find((step) => step.name === 'hung')?.ok, false);
    assert.equal(
      result.steps.find((step) => step.name === 'tail')?.error,
      'global_deadline_exceeded',
    );
  });
});

describe('shutdown — introspection', () => {
  test('snapshot reflects registered hooks', () => {
    shutdownReg.register('x', () => {}, 1234);
    const snap = shutdownReg.snapshot();
    assert.equal(snap.shuttingDown, false);
    assert.equal(snap.hooks.length, 1);
    assert.equal(snap.hooks[0].name, 'x');
    assert.equal(snap.hooks[0].timeoutMs, 1234);
  });

  test('isShuttingDown flips during shutdown', async () => {
    assert.equal(shutdownReg.isShuttingDown(), false);
    await shutdownReg.shutdown();
    assert.equal(shutdownReg.isShuttingDown(), true);
  });

  test('exposes TOTAL_SHUTDOWN_DEADLINE_MS = 30000', () => {
    assert.equal(shutdownReg.TOTAL_SHUTDOWN_DEADLINE_MS, 30_000);
  });

  test('production order stops advisory pool sampling before Prisma disconnect', () => {
    const order = shutdownReg.PRODUCTION_SHUTDOWN_ORDER;
    const autoscaler = order.indexOf('database_pool_autoscaler_stop');
    const prisma = order.indexOf('prisma_disconnect');
    assert.ok(autoscaler >= 0);
    assert.ok(prisma >= 0);
    assert.ok(autoscaler < prisma);
  });

  test('central shutdown awaits workspace runners before WebSocket and HTTP drain', () => {
    const order = shutdownReg.PRODUCTION_SHUTDOWN_ORDER;
    const workspaceRunner = order.indexOf('workspace_runner_stop');
    const realtime = order.indexOf('realtime_ws_close');
    const computerUse = order.indexOf('computer_use_ws_close');
    const http = order.indexOf('http_server_close');

    assert.ok(workspaceRunner >= 0, 'workspace runner shutdown phase must be ordered');
    assert.ok(workspaceRunner < realtime);
    assert.ok(workspaceRunner < computerUse);
    assert.ok(workspaceRunner < http);

    const indexSource = fs.readFileSync(require.resolve('../index.js'), 'utf8');
    const hook = indexSource.match(
      /shutdownRegistry\.register\(\s*'workspace_runner_stop',([\s\S]*?),\s*5000,?\s*\);/,
    );
    assert.ok(hook, 'workspace runner shutdown hook must be registered');
    assert.match(hook[1], /await\s+workspaceRunner\.stopAll\(\)/);
  });
});

function loadParentShutdownHelper() {
  const helperPath = path.resolve(__dirname, '../../scripts/parent-shutdown.js');
  return fs.existsSync(helperPath) ? require(helperPath) : {};
}

function fakeChild(pid, { connected = false } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.forwarded = [];
  child.connected = connected;
  child.messages = [];
  child.send = (message, callback) => {
    child.messages.push(message);
    callback?.();
    return true;
  };
  child.kill = (signal) => {
    child.forwarded.push(signal);
    child.killed = true;
    return true;
  };
  return child;
}

function fakeTimerHarness() {
  const scheduled = [];
  const cleared = [];
  return {
    scheduled,
    cleared,
    setTimeoutFn(callback, delay) {
      const timer = {
        callback,
        delay,
        unrefCalled: false,
        unref() { this.unrefCalled = true; },
      };
      scheduled.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      cleared.push(timer);
    },
  };
}

function leaderOnlyTreeLiveness(entry) {
  return entry.child.exitCode === null && entry.child.signalCode == null;
}

describe('start-all parent shutdown', () => {
  test('parent deadline defaults to 50s and clamps to a 40-120s safety range', () => {
    const {
      DEFAULT_PARENT_SHUTDOWN_TIMEOUT_MS,
      MIN_PARENT_SHUTDOWN_TIMEOUT_MS,
      resolveParentShutdownTimeoutMs,
    } = loadParentShutdownHelper();

    assert.equal(typeof resolveParentShutdownTimeoutMs, 'function');
    assert.ok(DEFAULT_PARENT_SHUTDOWN_TIMEOUT_MS > shutdownReg.TOTAL_SHUTDOWN_DEADLINE_MS);
    assert.equal(DEFAULT_PARENT_SHUTDOWN_TIMEOUT_MS, 50_000);
    assert.equal(MIN_PARENT_SHUTDOWN_TIMEOUT_MS, 40_000);
    assert.equal(resolveParentShutdownTimeoutMs(undefined), 50_000);
    assert.equal(resolveParentShutdownTimeoutMs('not-a-number'), 50_000);
    assert.equal(resolveParentShutdownTimeoutMs(10_000), 40_000);
    assert.equal(resolveParentShutdownTimeoutMs(90_000.9), 90_000);
    assert.equal(resolveParentShutdownTimeoutMs(999_999), 120_000);
  });

  test('coordinator waits for every child and clears the deadline on graceful host shutdown', async () => {
    const { createShutdownCoordinator } = loadParentShutdownHelper();
    const backend = fakeChild(101, { connected: true });
    const frontend = fakeChild(202);
    const timers = fakeTimerHarness();
    const processSignals = [];
    const hardExits = [];
    const settled = [];

    assert.equal(typeof createShutdownCoordinator, 'function');
    const coordinator = createShutdownCoordinator({
      platform: 'linux',
      timeoutMs: 50_000,
      isProcessTreeAlive: leaderOnlyTreeLiveness,
      processKill: (pid, signal) => processSignals.push([pid, signal]),
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      hardExit: (code) => hardExits.push(code),
      onSettled: (result) => settled.push(result),
    });
    coordinator.registerChild('backend', backend, { ipc: true, processGroup: true });
    coordinator.registerChild('frontend', frontend, { processGroup: true });
    const completion = coordinator.shutdown({
      reason: 'host:SIGTERM',
      signal: 'SIGTERM',
      desiredExitCode: 0,
    });

    assert.deepEqual(backend.messages, [{
      type: 'siragpt:shutdown',
      reason: 'host:SIGTERM',
      signal: 'SIGTERM',
      desiredExitCode: 0,
    }]);
    assert.deepEqual(backend.forwarded, []);
    assert.deepEqual(frontend.forwarded, ['SIGTERM']);
    assert.deepEqual(processSignals, []);
    assert.equal(timers.scheduled.length, 1);
    assert.equal(timers.scheduled[0].delay, 50_000);
    assert.equal(timers.scheduled[0].unrefCalled, false);
    assert.deepEqual(hardExits, []);

    backend.exitCode = 0;
    backend.emit('exit', 0, null);
    assert.equal(timers.cleared.length, 0);
    assert.deepEqual(settled, []);
    assert.deepEqual(hardExits, []);

    frontend.exitCode = 0;
    frontend.emit('exit', 0, null);
    const result = await completion;
    assert.deepEqual(timers.cleared, timers.scheduled);
    assert.equal(result.reason, 'host:SIGTERM');
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.deepEqual(settled, [result]);
    assert.deepEqual(hardExits, []);
  });

  test('active shutdown keeps the parent alive until its hard deadline', () => {
    const helperPath = path.resolve(__dirname, '../../scripts/parent-shutdown.js');
    const probe = `
      const { EventEmitter } = require('node:events');
      const { createShutdownCoordinator } = require(${JSON.stringify(helperPath)});
      const child = new EventEmitter();
      child.pid = 991;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => {
        child.exitCode = 0;
        queueMicrotask(() => child.emit('exit', 0, null));
      };
      const coordinator = createShutdownCoordinator({
        platform: 'linux',
        timeoutMs: 180,
        resolveTimeoutMs: () => 180,
        treePollIntervalMs: 20,
        isProcessTreeAlive: () => true,
        processKill: () => {},
        onSettled: () => {},
        hardExit: (code) => {
          require('node:fs').writeSync(1, 'deadline:' + code);
          process.exit(code);
        },
      });
      coordinator.registerChild('backend', child, { processGroup: true });
      coordinator.shutdown({ reason: 'probe', signal: 'SIGTERM', desiredExitCode: 0 });
    `;
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, ['-e', probe], {
      encoding: 'utf8',
      timeout: 3000,
    });

    assert.equal(result.status, 1, result.stderr || result.error?.message);
    assert.equal(result.stdout, 'deadline:1');
    assert.ok(Date.now() - startedAt >= 140);
  });

  test('unexpected child exit uses the same coordinator and preserves its crash code', async () => {
    const { createShutdownCoordinator } = loadParentShutdownHelper();
    const backend = fakeChild(303);
    const frontend = fakeChild(404);
    const timers = fakeTimerHarness();
    const processSignals = [];
    const coordinator = createShutdownCoordinator({
      platform: 'linux',
      timeoutMs: 50_000,
      isProcessTreeAlive: leaderOnlyTreeLiveness,
      processKill: (pid, signal) => processSignals.push([pid, signal]),
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      hardExit: () => assert.fail('graceful crash teardown must not hard-exit'),
      onSettled: () => {},
    });
    coordinator.registerChild('backend', backend, { processGroup: true });
    coordinator.registerChild('frontend', frontend, { processGroup: true });

    backend.exitCode = 7;
    backend.emit('exit', 7, null);
    assert.equal(coordinator.isShuttingDown(), true);
    assert.deepEqual(frontend.forwarded, ['SIGTERM']);
    assert.deepEqual(processSignals, []);
    frontend.exitCode = 0;
    frontend.emit('exit', 0, null);

    const result = await coordinator.waitForShutdown();
    assert.equal(result.reason, 'child:backend');
    assert.equal(result.exitCode, 7);
  });

  test('Windows uses IPC gracefully, then taskkill trees and exits nonzero at deadline', async () => {
    const { createShutdownCoordinator } = loadParentShutdownHelper();
    const backend = fakeChild(505, { connected: true });
    const frontend = fakeChild(606);
    const timers = fakeTimerHarness();
    const taskkills = [];
    const taskkillOptions = [];
    const hardExits = [];
    const coordinator = createShutdownCoordinator({
      platform: 'win32',
      timeoutMs: 50_000,
      isProcessTreeAlive: () => true,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      hardExit: (code) => hardExits.push(code),
      spawnImpl: (command, args, options) => {
        taskkills.push([command, args]);
        taskkillOptions.push(options);
        const error = new Error('taskkill timed out');
        error.code = 'ETIMEDOUT';
        return { status: null, error };
      },
      onSettled: () => {},
    });
    coordinator.registerChild('backend', backend, { ipc: true });
    coordinator.registerChild('frontend', frontend);
    const completion = coordinator.shutdown({
      reason: 'host:SIGINT',
      signal: 'SIGINT',
      desiredExitCode: 0,
    });

    assert.deepEqual(backend.messages, [{
      type: 'siragpt:shutdown',
      reason: 'host:SIGINT',
      signal: 'SIGINT',
      desiredExitCode: 0,
    }]);
    assert.deepEqual(backend.forwarded, []);
    assert.deepEqual(frontend.forwarded, ['SIGINT']);
    assert.deepEqual(taskkills, []);
    assert.deepEqual(hardExits, []);
    backend.exitCode = 0;
    backend.emit('exit', 0, null);
    frontend.exitCode = 0;
    frontend.emit('exit', 0, null);
    await Promise.resolve();
    assert.deepEqual(hardExits, []);
    timers.scheduled[0].callback();
    const result = await completion;

    assert.deepEqual(taskkills, [
      ['taskkill', ['/pid', '505', '/T', '/F']],
      ['taskkill', ['/pid', '606', '/T', '/F']],
    ]);
    assert.equal(taskkillOptions.length, 2);
    for (const options of taskkillOptions) {
      assert.ok(options.timeout > 0);
      assert.ok(options.timeout < 50_000);
      assert.equal(options.killSignal, 'SIGKILL');
    }
    assert.deepEqual(backend.forwarded, ['SIGKILL']);
    assert.deepEqual(frontend.forwarded, ['SIGINT', 'SIGKILL']);
    assert.deepEqual(hardExits, [1]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.timedOut, true);
  });

  test('Windows snapshots capture a late child while leader lives, then its reparented child', async () => {
    const { createShutdownCoordinator } = loadParentShutdownHelper();
    const backend = fakeChild(611, { connected: true });
    const deadlines = fakeTimerHarness();
    const polls = fakeTimerHarness();
    let processList = [
      { pid: 611, parentPid: 1 },
    ];
    const coordinator = createShutdownCoordinator({
      platform: 'win32',
      windowsProcessListImpl: () => processList,
      setTimeoutFn: deadlines.setTimeoutFn,
      clearTimeoutFn: deadlines.clearTimeoutFn,
      setTreePollTimeoutFn: polls.setTimeoutFn,
      clearTreePollTimeoutFn: polls.clearTimeoutFn,
      hardExit: () => assert.fail('known descendants quiesce before deadline'),
      onSettled: () => {},
    });
    coordinator.registerChild('backend', backend, { ipc: true });
    const completion = coordinator.shutdown({
      reason: 'host:SIGTERM',
      signal: 'SIGTERM',
      desiredExitCode: 0,
    });

    assert.equal(polls.scheduled.length, 1);
    processList = [
      { pid: 611, parentPid: 1 },
      { pid: 1611, parentPid: 611 },
    ];
    polls.scheduled.shift().callback();
    await Promise.resolve();
    assert.equal(polls.scheduled.length, 1);

    processList = [
      // The late first-generation child has been reparented after leader exit;
      // its own child must still be discovered from refreshed known-PID roots.
      { pid: 1611, parentPid: 1 },
      { pid: 2611, parentPid: 1611 },
    ];
    backend.exitCode = 0;
    backend.emit('exit', 0, null);

    let completed = false;
    completion.then(() => { completed = true; });
    await Promise.resolve();
    assert.equal(completed, false);
    assert.equal(polls.scheduled.length, 1);
    assert.equal(polls.scheduled[0].unrefCalled, false);

    processList = [];
    polls.scheduled.shift().callback();
    const result = await completion;
    assert.equal(result.timedOut, false);
  });

  test('a child registered during shutdown is terminated and included in the wait', async () => {
    const { createShutdownCoordinator } = loadParentShutdownHelper();
    const backend = fakeChild(707);
    const frontend = fakeChild(808);
    const processSignals = [];
    const coordinator = createShutdownCoordinator({
      platform: 'linux',
      isProcessTreeAlive: leaderOnlyTreeLiveness,
      processKill: (pid, signal) => processSignals.push([pid, signal]),
      hardExit: () => assert.fail('deadline must not fire'),
      onSettled: () => {},
    });
    coordinator.registerChild('backend', backend, { processGroup: true });
    const completion = coordinator.shutdown({
      reason: 'host:SIGTERM',
      signal: 'SIGTERM',
      desiredExitCode: 0,
    });
    coordinator.registerChild('frontend', frontend, { processGroup: true });

    assert.deepEqual(backend.forwarded, ['SIGTERM']);
    assert.deepEqual(frontend.forwarded, ['SIGTERM']);
    assert.deepEqual(processSignals, []);
    backend.exitCode = 0;
    backend.emit('exit', 0, null);
    let completed = false;
    completion.then(() => { completed = true; });
    await Promise.resolve();
    assert.equal(completed, false);
    frontend.exitCode = 0;
    frontend.emit('exit', 0, null);
    await completion;
  });

  test('leader exit remains pending until the injected process tree is quiescent', async () => {
    const { createShutdownCoordinator } = loadParentShutdownHelper();
    const backend = fakeChild(901);
    const frontend = fakeChild(902);
    const deadlines = fakeTimerHarness();
    const polls = fakeTimerHarness();
    const alive = new Map([
      ['backend', true],
      ['frontend', false],
    ]);
    const coordinator = createShutdownCoordinator({
      platform: 'linux',
      timeoutMs: 50_000,
      isProcessTreeAlive: (entry) => alive.get(entry.name) === true,
      setTimeoutFn: deadlines.setTimeoutFn,
      clearTimeoutFn: deadlines.clearTimeoutFn,
      setTreePollTimeoutFn: polls.setTimeoutFn,
      clearTreePollTimeoutFn: polls.clearTimeoutFn,
      hardExit: () => assert.fail('tree becomes quiescent before deadline'),
      onSettled: () => {},
    });
    coordinator.registerChild('backend', backend, { processGroup: true });
    coordinator.registerChild('frontend', frontend, { processGroup: true });
    const completion = coordinator.shutdown({
      reason: 'host:SIGTERM',
      signal: 'SIGTERM',
      desiredExitCode: 0,
    });

    backend.exitCode = 0;
    backend.emit('exit', 0, null);
    frontend.exitCode = 0;
    frontend.emit('exit', 0, null);
    let completed = false;
    completion.then(() => { completed = true; });
    await Promise.resolve();
    assert.equal(completed, false);
    assert.equal(polls.scheduled.length, 1);

    alive.set('backend', false);
    polls.scheduled[0].callback();
    const result = await completion;
    assert.equal(result.timedOut, false);
    assert.deepEqual(deadlines.cleared, deadlines.scheduled);
  });

  test('registration closes the already-exited child race and preserves its code', async () => {
    const { createShutdownCoordinator } = loadParentShutdownHelper();
    const child = fakeChild(909);
    child.exitCode = 9;
    const coordinator = createShutdownCoordinator({
      hardExit: () => assert.fail('no deadline is needed'),
      onSettled: () => {},
    });

    coordinator.registerChild('already-exited', child);
    assert.equal(coordinator.isShuttingDown(), true);
    const result = await coordinator.waitForShutdown();
    assert.equal(result.reason, 'child:already-exited');
    assert.equal(result.exitCode, 9);
  });

  test('child process errors enter coordinated crash shutdown without an unhandled event', async () => {
    const { createShutdownCoordinator } = loadParentShutdownHelper();
    const backend = fakeChild(910);
    const frontend = fakeChild(911);
    const coordinator = createShutdownCoordinator({
      platform: 'linux',
      isProcessTreeAlive: leaderOnlyTreeLiveness,
      processKill: () => {},
      hardExit: () => assert.fail('children settle before the deadline'),
      onSettled: () => {},
    });
    coordinator.registerChild('backend', backend, { processGroup: true });
    coordinator.registerChild('frontend', frontend, { processGroup: true });

    backend.emit('error', new Error('spawn failed'));
    assert.equal(coordinator.isShuttingDown(), true);
    backend.exitCode = 1;
    backend.emit('close', 1, null);
    frontend.exitCode = 0;
    frontend.emit('exit', 0, null);

    const result = await coordinator.waitForShutdown();
    assert.equal(result.reason, 'child:backend');
    assert.equal(result.exitCode, 1);
  });

  test('coordinator gracefully waits for a real subprocess', async (t) => {
    const { createShutdownCoordinator } = loadParentShutdownHelper();
    const child = spawn(process.execPath, ['-e', [
      "process.on('message', (m) => {",
      " if (m && m.type === 'siragpt:shutdown') setTimeout(() => process.exit(0), 60);",
      "});",
      "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 60));",
      "if (process.send) process.send('ready');",
      "setInterval(() => {}, 1000);",
    ].join('')], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    t.after(() => {
      try {
        if (child.exitCode === null) {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        }
      } catch { /* already gone */ }
    });
    await once(child, 'message');
    const coordinator = createShutdownCoordinator({
      hardExit: () => assert.fail('real child should exit before deadline'),
      onSettled: () => {},
    });
    coordinator.registerChild('fixture', child, {
      ipc: true,
      processGroup: process.platform !== 'win32',
    });

    const result = await coordinator.shutdown({
      reason: 'portable-test',
      signal: 'SIGTERM',
      desiredExitCode: 0,
    });
    assert.equal(result.timedOut, false);
    assert.notEqual(child.exitCode ?? child.signalCode, null);
  });

  test('Unix coordinator keeps a stubborn grandchild pending and kills its group only at deadline', {
    skip: process.platform !== 'linux',
  }, async (t) => {
    const { createShutdownCoordinator } = loadParentShutdownHelper();
    const grandchildSource = [
      "process.on('SIGTERM', () => {});",
      "if (process.send) process.send('ready');",
      "setInterval(() => {}, 1000);",
    ].join('');
    const leaderSource = [
      "const { spawn } = require('node:child_process');",
      `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}],`,
      " { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
      "grandchild.once('message', () => process.send({ grandchildPid: grandchild.pid }));",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join('');
    const leader = spawn(process.execPath, ['-e', leaderSource], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const [{ grandchildPid }] = await once(leader, 'message');
    const isLiveNonZombie = (pid) => {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.split(' ')[2] !== 'Z';
      } catch {
        return false;
      }
    };
    t.after(() => {
      try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* gone */ }
      try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* gone */ }
    });

    const hardExits = [];
    const coordinator = createShutdownCoordinator({
      timeoutMs: 250,
      resolveTimeoutMs: () => 250,
      treePollIntervalMs: 20,
      hardExit: (code) => hardExits.push(code),
      onSettled: () => {},
    });
    coordinator.registerChild('leader', leader, { processGroup: true });
    let completed = false;
    const completion = coordinator.shutdown({
      reason: 'stubborn-tree-test',
      signal: 'SIGTERM',
      desiredExitCode: 0,
    }).then((result) => {
      completed = true;
      return result;
    });

    await once(leader, 'exit');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(completed, false);
    assert.equal(isLiveNonZombie(grandchildPid), true);

    const result = await completion;
    assert.equal(result.timedOut, true);
    assert.deepEqual(hardExits, [1]);
    const goneDeadline = Date.now() + 2000;
    while (isLiveNonZombie(grandchildPid) && Date.now() < goneDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(isLiveNonZombie(grandchildPid), false);
  });

  test('both start-all parents use the coordinator and IPC-capable backend child', () => {
    for (const filename of ['start-all.cjs', 'start-all.js']) {
      const source = fs.readFileSync(path.resolve(__dirname, `../../scripts/${filename}`), 'utf8');
      assert.match(source, /require\(["']\.\/parent-shutdown["']\)/);
      assert.match(source, /SIRAGPT_PARENT_SHUTDOWN_TIMEOUT_MS/);
      assert.match(source, /createShutdownCoordinator\(\{/);
      assert.match(source, /coordinator\.registerChild\(["']backend["']/);
      assert.match(source, /coordinator\.shutdown\(\{/);
      assert.match(source, /waitForPort\([\s\S]*?shutdownController\.signal/);
      assert.match(source, /stdio:\s*\["ignore",\s*"pipe",\s*"pipe",\s*"ipc"\]/);
      assert.doesNotMatch(source, /function onChildExit\(/);
    }
  });

  test('parent shutdown deadline is documented for operators and Replit', () => {
    for (const filename of [
      '../../.env.example',
      '../../.replit',
      '../../docs/operations/ENVIRONMENT.md',
    ]) {
      const source = fs.readFileSync(path.resolve(__dirname, filename), 'utf8');
      assert.match(source, /SIRAGPT_PARENT_SHUTDOWN_TIMEOUT_MS/);
      assert.match(source, /40(?:000|s)/);
      assert.match(source, /50(?:000|s)/);
    }
  });

  test('PM2 and both Compose backend grace periods fit between backend and parent deadlines', () => {
    const {
      DEFAULT_PARENT_SHUTDOWN_TIMEOUT_MS,
      MIN_PARENT_SHUTDOWN_TIMEOUT_MS,
    } = loadParentShutdownHelper();
    const ecosystem = require('../ecosystem.config');
    const killTimeoutMs = ecosystem.apps.find((app) => app.name === 'siraGPT-api')?.kill_timeout;

    assert.ok(killTimeoutMs > shutdownReg.TOTAL_SHUTDOWN_DEADLINE_MS);
    assert.ok(killTimeoutMs < MIN_PARENT_SHUTDOWN_TIMEOUT_MS);
    assert.ok(killTimeoutMs < DEFAULT_PARENT_SHUTDOWN_TIMEOUT_MS);

    for (const filename of ['docker-compose.yml', 'docker-compose.prod.yml']) {
      const source = fs.readFileSync(path.resolve(__dirname, `../../${filename}`), 'utf8');
      const backend = source.match(/\n  backend:\n([\s\S]*?)(?=\n  [a-z][\w-]*:\n|\nvolumes:)/);
      assert.ok(backend, `${filename} backend service must exist`);
      const grace = backend[1].match(/\bstop_grace_period:\s*["']?(\d+)s["']?/);
      assert.ok(grace, `${filename} backend must declare stop_grace_period`);
      const graceMs = Number(grace[1]) * 1000;
      assert.ok(graceMs > shutdownReg.TOTAL_SHUTDOWN_DEADLINE_MS);
      assert.ok(graceMs < MIN_PARENT_SHUTDOWN_TIMEOUT_MS);
      assert.ok(graceMs < DEFAULT_PARENT_SHUTDOWN_TIMEOUT_MS);
    }
  });
});
