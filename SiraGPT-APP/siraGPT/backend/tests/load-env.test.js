'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ENV_CANDIDATES, loadEnvFiles } = require('../src/config/load-env');

test('backend env loader checks backend and root local env before fallback env files', () => {
  const names = ENV_CANDIDATES.map((file) => path.basename(file));

  assert.deepEqual(names, ['.env.local', '.env.local', '.env', '.env']);
  assert.match(ENV_CANDIDATES[0], /backend[\\/]\.env\.local$/);
  assert.doesNotMatch(ENV_CANDIDATES[1], /backend[\\/]\.env\.local$/);
});

test('backend env loader loads keys without overriding existing process env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-env-'));
  const first = path.join(dir, '.env.local');
  const second = path.join(dir, '.env');
  const key = `SIRAGPT_ENV_LOADER_TEST_${Date.now()}`;

  fs.writeFileSync(first, `${key}=from_local\n`);
  fs.writeFileSync(second, `${key}=from_env\n`);

  const previous = process.env[key];
  delete process.env[key];
  try {
    const result = loadEnvFiles({ candidates: [first, second] });
    assert.deepEqual(result.loadedFiles, [first, second]);
    assert.equal(process.env[key], 'from_local');
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
