'use strict';

/**
 * Unit coverage for the no-Docker host runner's pure gates. Deliberately avoids
 * spawning real dev servers: every assertion exercises a code path that runs
 * BEFORE any child process (enable flag, allowlist, the two synchronous startRun
 * rejections) or a lookup on an empty run map.
 */

const test = require('node:test');
const assert = require('node:assert');

const runner = require('../src/services/code/host-runner');

async function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test('enabled() honours the explicit flag (truthy + falsy spellings)', async () => {
  await withEnv({ CODE_HOST_RUNNER: '1', NODE_ENV: 'production' }, () => assert.equal(runner.enabled(), true));
  await withEnv({ CODE_HOST_RUNNER: 'true', NODE_ENV: 'production' }, () => assert.equal(runner.enabled(), true));
  await withEnv({ CODE_HOST_RUNNER: 'on', NODE_ENV: 'production' }, () => assert.equal(runner.enabled(), true));
  await withEnv({ CODE_HOST_RUNNER: '0', NODE_ENV: 'development' }, () => assert.equal(runner.enabled(), false));
  await withEnv({ CODE_HOST_RUNNER: 'off', NODE_ENV: 'development' }, () => assert.equal(runner.enabled(), false));
});

test('enabled() default: on in dev, off in production', async () => {
  await withEnv({ CODE_HOST_RUNNER: undefined, NODE_ENV: 'development' }, () => assert.equal(runner.enabled(), true));
  await withEnv({ CODE_HOST_RUNNER: undefined, NODE_ENV: 'production' }, () => assert.equal(runner.enabled(), false));
});

test('startAllowed(): implicit dev default (flag unset) + no allowlist → any authenticated user may start', async () => {
  await withEnv({ CODE_HOST_RUNNER: undefined, CODE_HOST_RUNNER_ALLOWED_USER_IDS: undefined }, () => {
    assert.equal(runner.startAllowed({ id: 'u1' }), true);
  });
});

test('startAllowed(): FAIL-CLOSED — flag explicitly on + EMPTY allowlist → denied for everyone', async () => {
  // /exec runs `/bin/sh -c` on the host: forcing the runner on without an
  // allowlist must never fail open to "any authenticated user".
  await withEnv({ CODE_HOST_RUNNER: '1', CODE_HOST_RUNNER_ALLOWED_USER_IDS: undefined }, () => {
    assert.equal(runner.startAllowed({ id: 'u1' }), false);
    assert.equal(runner.startAllowed(null), false);
  });
  // Blank / whitespace-only spellings of "empty" behave the same.
  await withEnv({ CODE_HOST_RUNNER: 'true', CODE_HOST_RUNNER_ALLOWED_USER_IDS: '' }, () => {
    assert.equal(runner.startAllowed({ id: 'u1' }), false);
  });
  await withEnv({ CODE_HOST_RUNNER: 'on', CODE_HOST_RUNNER_ALLOWED_USER_IDS: ' , ' }, () => {
    assert.equal(runner.startAllowed({ id: 'u1' }), false);
  });
});

test('startAllowed(): flag on + allowlist configured → listed ids allowed, others denied (prod shape)', async () => {
  await withEnv({ CODE_HOST_RUNNER: '1', CODE_HOST_RUNNER_ALLOWED_USER_IDS: 'owner-1, owner-2' }, () => {
    assert.equal(runner.startAllowed({ id: 'owner-1' }), true);
    assert.equal(runner.startAllowed({ id: 'owner-2' }), true);
    assert.equal(runner.startAllowed({ id: 'intruder' }), false);
    assert.equal(runner.startAllowed(null), false);
  });
});

test('startAllowed(): allowlist restricts to listed ids (flag unset)', async () => {
  await withEnv({ CODE_HOST_RUNNER: undefined, CODE_HOST_RUNNER_ALLOWED_USER_IDS: 'owner-1, owner-2' }, () => {
    assert.equal(runner.startAllowed({ id: 'owner-1' }), true);
    assert.equal(runner.startAllowed({ id: 'owner-2' }), true);
    assert.equal(runner.startAllowed({ id: 'intruder' }), false);
    assert.equal(runner.startAllowed(null), false);
  });
});

test('startRun() rejects with code "disabled" when the flag is off', async () => {
  await withEnv({ CODE_HOST_RUNNER: '0' }, async () => {
    await assert.rejects(
      () => runner.startRun({ runId: 'r1', userId: 'u1', files: { 'package.json': '{}' } }),
      (e) => e && e.code === 'disabled',
    );
  });
});

test('startRun() rejects with code "no_package" for a project without package.json', async () => {
  await withEnv({ CODE_HOST_RUNNER: '1' }, async () => {
    await assert.rejects(
      () => runner.startRun({ runId: 'r2', userId: 'u1', files: { 'index.js': 'console.log(1)' } }),
      (e) => e && e.code === 'no_package',
    );
  });
});

test('getRunForProxy()/getPreviewToken(): unknown run → null', () => {
  assert.equal(runner.getRunForProxy('does-not-exist', 'whatever'), null);
  assert.equal(runner.getPreviewToken('does-not-exist'), null);
});

test('stopRun(): ownership — a user cannot stop another user\'s run; the owner can', () => {
  runner._resetRunsForTest();
  runner._seedRunForTest({ runId: 'own1', userId: 'alice', port: 5200, phase: 'ready', previewToken: 'tok' });
  // Wrong owner → refused (no-op, run survives).
  assert.equal(runner.stopRun('own1', 'mallory'), false);
  assert.deepEqual(runner.getRunForProxy('own1', 'tok'), { port: 5200 });
  // Correct owner → stopped.
  assert.equal(runner.stopRun('own1', 'alice'), true);
  assert.equal(runner.getRunForProxy('own1', 'tok'), null);
  // Unknown run → false, not a throw.
  assert.equal(runner.stopRun('nope', 'alice'), false);
  runner._resetRunsForTest();
});

test('stopRun(): internal callers (no userId) bypass the ownership gate', () => {
  runner._resetRunsForTest();
  runner._seedRunForTest({ runId: 'own2', userId: 'alice', port: 5201, phase: 'ready', previewToken: 't2' });
  assert.equal(runner.stopRun('own2'), true); // evict/restart/reaper path
  assert.equal(runner.getPreviewToken('own2'), null);
  runner._resetRunsForTest();
});

test('getRunForProxy(): a crashed/stopped run no longer exposes its (recyclable) port', () => {
  runner._resetRunsForTest();
  runner._seedRunForTest({ runId: 'p1', userId: 'alice', port: 5300, phase: 'ready', previewToken: 'pt' });
  assert.deepEqual(runner.getRunForProxy('p1', 'pt'), { port: 5300 });
  // Simulate a boot failure: phase error keeps the row but the port is dead.
  runner._seedRunForTest({ runId: 'p1', userId: 'alice', port: 5300, phase: 'error', previewToken: 'pt' });
  assert.equal(runner.getRunForProxy('p1', 'pt'), null);
  // Wrong token never resolves regardless of phase.
  runner._seedRunForTest({ runId: 'p1', userId: 'alice', port: 5300, phase: 'ready', previewToken: 'pt' });
  assert.equal(runner.getRunForProxy('p1', 'WRONG'), null);
  runner._resetRunsForTest();
});

test('normaliseRuntimeEnv keeps app env and drops dangerous process overrides', () => {
  const env = runner.normaliseRuntimeEnv({
    stripe_secret_key: 'sk_test_redacted',
    VITE_PUBLIC_NAME: 'Sira',
    NODE_OPTIONS: '--require /tmp/evil.js',
    PATH: '/tmp/bin',
    'bad-key': 'x',
  });

  assert.equal(env.STRIPE_SECRET_KEY, 'sk_test_redacted');
  assert.equal(env.VITE_PUBLIC_NAME, 'Sira');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.PATH, undefined);
  assert.equal(env['BAD-KEY'], undefined);
});

test('isRuntimeEnvFile identifies runtime .env files but not templates', () => {
  assert.equal(runner.isRuntimeEnvFile('.env'), true);
  assert.equal(runner.isRuntimeEnvFile('.env.local'), true);
  assert.equal(runner.isRuntimeEnvFile('.env.production.local'), true);
  assert.equal(runner.isRuntimeEnvFile('apps/web/.env.production'), true);
  assert.equal(runner.isRuntimeEnvFile('.env.example'), false);
  assert.equal(runner.isRuntimeEnvFile('.env.local.example'), false);
});

test('errored/dead runs do not hold the global concurrency slots (cross-user DoS)', async () => {
  runner._resetRunsForTest();
  // Two errored runs owned by user A fill the map but have NO live dev server.
  // MAX_CONCURRENT defaults to 2 → these two would trip capacity_full under the
  // old "count every run" logic.
  runner._seedRunForTest({ runId: 'dead-1', userId: 'alice', port: null, phase: 'error', previewToken: null });
  runner._seedRunForTest({ runId: 'dead-2', userId: 'alice', port: null, phase: 'error', previewToken: null });

  await withEnv({ CODE_HOST_RUNNER: '1' }, async () => {
    // User B (owns none of the errored runs) must NOT be denied capacity.
    const res = await runner.startRun({
      runId: 'bob-run',
      userId: 'bob',
      files: { 'package.json': '{"name":"x","private":true}' },
    });
    assert.equal(res.runId, 'bob-run');
    // Kill the freshly-started run immediately so the async npm install/dev
    // pipeline doesn't run for real during the test.
    runner.stopRun('bob-run');
  });
  runner._resetRunsForTest();
});

test('getStatus() does not bump lastTouch on a terminal (error) run', () => {
  runner._resetRunsForTest();
  const past = Date.now() - 60 * 60 * 1000; // 1h ago
  runner._seedRunForTest({ runId: 'err-run', userId: 'alice', port: null, phase: 'error', previewToken: null, lastTouch: past, logs: [] });

  const status = runner.getStatus('err-run', 'alice');
  assert.equal(status.phase, 'error');
  // Polling a dead run must not refresh its liveness (so the idle reaper can
  // eventually collect it even while a client keeps polling).
  assert.equal(runner._peekRunForTest('err-run').lastTouch, past);
  runner._resetRunsForTest();
});
