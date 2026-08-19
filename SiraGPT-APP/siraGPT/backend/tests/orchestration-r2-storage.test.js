'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  bucketName,
  createR2Client,
  createR2ArtifactStorage,
  enabled,
  safeKey,
} = require('../src/orchestration/r2-storage');

test('enabled returns false without credentials', () => {
  assert.equal(enabled({}), false);
});

test('enabled returns true with full credentials', () => {
  assert.equal(enabled({
    R2_ACCOUNT_ID: 'acct',
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret',
    R2_BUCKET_NAME: 'bucket',
  }), true);
});

test('enabled returns true with R2_BUCKET alias', () => {
  assert.equal(enabled({
    R2_ACCOUNT_ID: 'acct',
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret',
    R2_BUCKET: 'bucket',
  }), true);
});

test('enabled returns false without bucket', () => {
  assert.equal(enabled({
    R2_ACCOUNT_ID: 'acct',
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret',
  }), false);
});

test('bucketName prefers R2_BUCKET_NAME over R2_BUCKET', () => {
  const env = { R2_BUCKET_NAME: 'primary', R2_BUCKET: 'fallback' };
  assert.equal(bucketName(env), 'primary');
});

test('bucketName falls back to R2_BUCKET', () => {
  assert.equal(bucketName({ R2_BUCKET: 'fallback' }), 'fallback');
});

test('createR2Client returns null when not enabled', () => {
  assert.equal(createR2Client({}), null);
});

test('safeKey sanitizes user ID and file names', () => {
  const key = safeKey({ userId: 'user@domain.com', fileName: 'thesis final.pdf' });
  assert.ok(key.startsWith('artifacts/user_domain_com/'));
  assert.ok(key.includes('thesis_final.pdf'));
  assert.ok(key.length < 250);
});

test('safeKey uses anon for missing userId', () => {
  const key = safeKey({ fileName: 'file.pdf' });
  assert.ok(key.startsWith('artifacts/anon/'));
});

test('createR2ArtifactStorage is disabled when not configured', () => {
  const storage = createR2ArtifactStorage({ env: {}, client: null });
  assert.equal(storage.enabled, false);
});

test('createR2ArtifactStorage put throws when disabled', async () => {
  const storage = createR2ArtifactStorage({ env: {}, client: null });
  await assert.rejects(
    () => storage.put({ key: 'test', body: 'data' }),
    /not configured/,
  );
});

test('createR2ArtifactStorage signedGetUrl throws when disabled', async () => {
  const storage = createR2ArtifactStorage({ env: {}, client: null });
  await assert.rejects(
    () => storage.signedGetUrl('test'),
    /not configured/,
  );
});