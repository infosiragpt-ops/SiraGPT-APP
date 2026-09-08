'use strict';

/**
 * Unit coverage for the host runner's cached + deterministic install plan:
 * lockfile → single `npm ci`; no lockfile → pin (`--package-lock-only`) then
 * `npm ci`; failure → one-shot plain `npm install` heal; cache dir defaults to
 * the shared run root (never the API user's home).
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

function argLists(plan) {
  return plan.map((s) => s.args);
}

test('installPlan: lockfile presente → un único npm ci determinista', () => {
  const plan = runner._buildInstallPlanForTest(true);
  assert.equal(plan.length, 1);
  assert.deepEqual(argLists(plan)[0], ['ci', '--no-audit', '--no-fund', '--include=dev', '--loglevel=error']);
});

test('installPlan: sin lockfile → fija árbol (--package-lock-only) y luego npm ci', () => {
  const plan = runner._buildInstallPlanForTest(false);
  assert.equal(plan.length, 2);
  assert.deepEqual(argLists(plan)[0], ['install', '--package-lock-only', '--no-audit', '--no-fund', '--include=dev', '--loglevel=error']);
  assert.deepEqual(argLists(plan)[1], ['ci', '--no-audit', '--no-fund', '--include=dev', '--loglevel=error']);
});

test('npmCacheDir: por defecto vive bajo la raíz del runner (siragpt-coderun), no en el caché global de npm', async () => {
  await withEnv({ NPM_CONFIG_CACHE: undefined, npm_config_cache: undefined }, async () => {
    const dir = runner._npmCacheDirForTest();
    assert.equal(require('node:path').basename(dir), '.npm-cache');
    assert.ok(dir.includes('siragpt-coderun'), `el caché debe vivir bajo ${'tmpdir'}/siragpt-coderun, fue: ${dir}`);
    assert.ok(!dir.endsWith('/.npm'), 'no debe ser el caché por defecto ~/.npm');
  });
});

test('npmCacheDir: respeta NPM_CONFIG_CACHE si el deploy lo define', async () => {
  await withEnv({ NPM_CONFIG_CACHE: '/var/cache/sira-npm' }, async () => {
    assert.equal(runner._npmCacheDirForTest(), '/var/cache/sira-npm');
  });
});
