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

test('startAllowed(): no allowlist → any authenticated user may start', async () => {
  await withEnv({ CODE_HOST_RUNNER_ALLOWED_USER_IDS: undefined }, () => {
    assert.equal(runner.startAllowed({ id: 'u1' }), true);
  });
});

test('startAllowed(): allowlist restricts to listed ids', async () => {
  await withEnv({ CODE_HOST_RUNNER_ALLOWED_USER_IDS: 'owner-1, owner-2' }, () => {
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
