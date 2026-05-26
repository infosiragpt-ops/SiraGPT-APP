'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  requireDurableArtifactStorage,
  assertArtifactStorageReady,
} = require('../src/orchestration/artifact-storage-policy');

const R2_KEYS = {
  R2_ACCOUNT_ID: 'a',
  R2_ACCESS_KEY_ID: 'b',
  R2_SECRET_ACCESS_KEY: 'c',
  R2_BUCKET_NAME: 'd',
  R2_ENDPOINT: 'https://r2.local',
};

test('exports both helpers', () => {
  assert.equal(typeof requireDurableArtifactStorage, 'function');
  assert.equal(typeof assertArtifactStorageReady, 'function');
});

test('non-prod environments return ok + local mode without requiring R2', () => {
  const result = requireDurableArtifactStorage({ NODE_ENV: 'development' });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'local');
  assert.equal(result.required, false);
});

test('test environment without R2 also resolves to local mode', () => {
  const result = requireDurableArtifactStorage({ NODE_ENV: 'test' });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'local');
});

test('production with full R2 config returns ok + mode "r2"', () => {
  const result = requireDurableArtifactStorage({ NODE_ENV: 'production', ...R2_KEYS });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'r2');
  assert.equal(result.required, true);
});

test('production WITHOUT R2 returns ok:false + missing_r2 + actionable error message', () => {
  const result = requireDurableArtifactStorage({ NODE_ENV: 'production' });
  assert.equal(result.ok, false);
  assert.equal(result.mode, 'missing_r2');
  assert.equal(result.required, true);
  assert.match(result.error, /R2 artifact storage is required/);
  assert.match(result.error, /R2_ACCOUNT_ID/);
});

test('SIRAGPT_REQUIRE_R2_ARTIFACTS=1 enforces R2 even outside production', () => {
  const result = requireDurableArtifactStorage({
    NODE_ENV: 'development',
    SIRAGPT_REQUIRE_R2_ARTIFACTS: '1',
  });
  assert.equal(result.ok, false);
  assert.equal(result.mode, 'missing_r2');
  assert.equal(result.required, true);
});

test('SIRAGPT_REQUIRE_R2_ARTIFACTS=1 with valid R2 config still passes', () => {
  const result = requireDurableArtifactStorage({
    NODE_ENV: 'staging',
    SIRAGPT_REQUIRE_R2_ARTIFACTS: '1',
    ...R2_KEYS,
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'r2');
});

test('NODE_ENV check is case-insensitive (PRODUCTION counts)', () => {
  const result = requireDurableArtifactStorage({ NODE_ENV: 'PRODUCTION' });
  assert.equal(result.required, true);
});

test('assertArtifactStorageReady returns the policy when ok', () => {
  const policy = assertArtifactStorageReady({ NODE_ENV: 'development' });
  assert.equal(policy.ok, true);
  assert.equal(policy.mode, 'local');
});

test('assertArtifactStorageReady throws with code ARTIFACT_STORAGE_NOT_CONFIGURED when not ok', () => {
  assert.throws(
    () => assertArtifactStorageReady({ NODE_ENV: 'production' }),
    (err) => err.code === 'ARTIFACT_STORAGE_NOT_CONFIGURED' && /R2 artifact storage is required/.test(err.message),
  );
});

test('SIRAGPT_REQUIRE_R2_ARTIFACTS values other than exactly "1" are ignored', () => {
  // Only the literal "1" enables forced R2; anything else (true, yes, on, true-ish) is not enforced.
  for (const val of ['true', 'yes', 'on', '0']) {
    const result = requireDurableArtifactStorage({ NODE_ENV: 'development', SIRAGPT_REQUIRE_R2_ARTIFACTS: val });
    assert.equal(result.required, false, `SIRAGPT_REQUIRE_R2_ARTIFACTS="${val}" must not force R2`);
  }
});
