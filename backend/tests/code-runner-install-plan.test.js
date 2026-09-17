'use strict';

// «Dame la web en local» for real repos: installer by lockfile, public dev
// env passthrough and a user-requested port in the runner.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const utils = require('../../scripts/code-runner-utils.js');

test('pickInstallPlan: npm lockfile → npm ci, then without scripts, then npm install', () => {
  const plan = utils.pickInstallPlan({ hasPackageLock: true });
  assert.deepEqual(plan.map((p) => p.label), ['npm ci', 'npm ci --ignore-scripts', 'npm install']);
  assert.deepEqual(plan[0].cmd.slice(0, 2), ['npm', 'ci']);
  assert.ok(plan[1].cmd.includes('--ignore-scripts'));
  for (const p of plan) assert.equal(utils.commandRejectionReason(p.cmd), null, `${p.label} must be an allowed runner command`);
});

test('pickInstallPlan: bun lock (or no lock) keeps bun; pnpm/yarn fall back to npm install', () => {
  assert.equal(utils.pickInstallPlan({ hasBunLock: true, hasPackageLock: true })[0].label, 'bun install');
  assert.equal(utils.pickInstallPlan({})[0].label, 'bun install');
  assert.equal(utils.pickInstallPlan({ hasPnpmLock: true }).at(-1).label, 'npm install');
  assert.equal(utils.pickInstallPlan({ hasYarnLock: true }).at(-1).label, 'npm install');
});

test('sanitizeDevEnv keeps only public build-time keys with sane values', () => {
  const out = utils.sanitizeDevEnv({
    NEXT_PUBLIC_API_URL: '/api',
    VITE_BASE: '/x',
    DATABASE_URL: 'postgres://secret',
    OPENAI_API_KEY: 'sk-1',
    PATH: '/bin',
    NEXT_PUBLIC_BAD: 'a\nb',
    'NEXT_PUBLIC_lower': 'x',
    NEXT_PUBLIC_NUM: 5,
  });
  assert.deepEqual(out, { NEXT_PUBLIC_API_URL: '/api', VITE_BASE: '/x', NEXT_PUBLIC_NUM: '5' });
  assert.deepEqual(utils.sanitizeDevEnv(null), {});
  assert.deepEqual(utils.sanitizeDevEnv(['x']), {});
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`NEXT_PUBLIC_K${i}`, 'v']));
  assert.equal(Object.keys(utils.sanitizeDevEnv(many)).length, 20);
});

test('sanitizePinnedPort accepts a free user port and rejects reserved/invalid ones', () => {
  assert.equal(utils.sanitizePinnedPort(5000, { reserved: [4097] }), 5000);
  assert.equal(utils.sanitizePinnedPort('5000'), 5000);
  assert.equal(utils.sanitizePinnedPort(4097, { reserved: [4097] }), null);
  assert.equal(utils.sanitizePinnedPort(80), null);
  assert.equal(utils.sanitizePinnedPort(70000), null);
  assert.equal(utils.sanitizePinnedPort('abc'), null);
  assert.equal(utils.sanitizePinnedPort(undefined), null);
});

test('runner wires the install plan, pinned port and env passthrough', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'code-runner.js'), 'utf8');
  assert.match(src, /const plan = pickInstallPlan\(\{/);
  assert.match(src, /for \(const attempt of plan\)/);
  assert.match(src, /async function startDev\(projectId = null, runId = null, basePath = null, opts = \{\}\)/);
  assert.match(src, /sanitizePinnedPort\(opts && opts\.port, \{ reserved: \[CTRL_PORT\] \}\)/);
  assert.match(src, /\.\.\.\(entry\.extraEnv \|\| \{\}\)/);
  assert.match(src, /body && \(body\.port \?\? body\.preferredPort\)/);
  assert.match(src, /"CODE_RUNNER_INSTALL_TIMEOUT_MS", 900_000/);
  assert.match(src, /"CODE_RUNNER_RLIMIT_NOFILE", 8192/);
  assert.match(src, /"CODE_RUNNER_RLIMIT_NPROC", 512/);
  assert.match(src, /"CODE_RUNNER_RLIMIT_AS_BYTES", 256 \* 1024 \* 1024 \* 1024/);
  assert.match(src, /NODE_OPTIONS: `--max-old-space-size=\$\{DEV_HEAP_MB\}`/);
  assert.match(src, /probeReady\(port, entry\.basePath, entry\.framework\)/);
});
