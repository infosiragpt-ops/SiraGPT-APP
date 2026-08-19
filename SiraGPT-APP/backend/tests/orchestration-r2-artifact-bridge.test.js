'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createR2ArtifactBridge } = require('../src/orchestration/r2-artifact-bridge');

function makeR2Stub(overrides = {}) {
  const calls = { put: [], signedGetUrl: [], delete: [], signedPutUrl: [] };
  const stub = {
    enabled: true,
    async put(args) { calls.put.push(args); return { ok: true }; },
    async signedGetUrl(key, ttl) { calls.signedGetUrl.push({ key, ttl }); return `https://r2.local/get/${key}`; },
    async delete(key) { calls.delete.push(key); return { deleted: true }; },
    async signedPutUrl({ key, contentType }) { calls.signedPutUrl.push({ key, contentType }); return `https://r2.local/put/${key}`; },
    ...overrides,
  };
  return { stub, calls };
}

test('exports createR2ArtifactBridge', () => {
  assert.equal(typeof createR2ArtifactBridge, 'function');
});

test('returns disabled when r2Storage is null', () => {
  const bridge = createR2ArtifactBridge(null);
  assert.equal(bridge.enabled, false);
});

test('returns disabled when r2Storage is not enabled', () => {
  const bridge = createR2ArtifactBridge({ enabled: false });
  assert.equal(bridge.enabled, false);
});

test('returns enabled bridge surface when r2Storage is enabled', () => {
  const { stub } = makeR2Stub();
  const bridge = createR2ArtifactBridge(stub);
  assert.equal(bridge.enabled, true);
  for (const fn of ['shouldOffload', 'upload', 'getSignedUrl', 'delete', 'signedUploadUrl']) {
    assert.equal(typeof bridge[fn], 'function', `expected ${fn}`);
  }
  assert.equal(typeof bridge.minSizeBytes, 'number');
});

test('shouldOffload compares against minSizeBytes', () => {
  const { stub } = makeR2Stub();
  const bridge = createR2ArtifactBridge(stub);
  assert.equal(bridge.shouldOffload(bridge.minSizeBytes - 1), false);
  assert.equal(bridge.shouldOffload(bridge.minSizeBytes), true);
  assert.equal(bridge.shouldOffload(bridge.minSizeBytes + 1024), true);
});

test('upload forwards to r2Storage.put with key+body+contentType+metadata', async () => {
  const { stub, calls } = makeR2Stub();
  const bridge = createR2ArtifactBridge(stub);
  const buffer = Buffer.from('hello world');
  const out = await bridge.upload({
    buffer,
    fileName: 'thesis.pdf',
    userId: 'user-1234567890abcdef',
    mimeType: 'application/pdf',
    metadata: { source: 'upload' },
  });
  assert.equal(calls.put.length, 1);
  const putArgs = calls.put[0];
  assert.equal(putArgs.body, buffer);
  assert.equal(putArgs.contentType, 'application/pdf');
  assert.equal(putArgs.metadata.source, 'upload');
  assert.ok(typeof putArgs.metadata.uploadedAt === 'string');
  assert.match(putArgs.key, /thesis\.pdf$/);
  assert.equal(out.storage, 'r2');
  assert.ok(out.url.startsWith('https://r2.local/get/'));
  assert.equal(out.bucket, 'r2');
});

test('upload defaults contentType to application/octet-stream when mimeType is missing', async () => {
  const { stub, calls } = makeR2Stub();
  const bridge = createR2ArtifactBridge(stub);
  await bridge.upload({
    buffer: Buffer.from('x'),
    fileName: 'a.bin',
    userId: 'u',
  });
  assert.equal(calls.put[0].contentType, 'application/octet-stream');
});

test('upload truncates userId to 36 chars in the key', async () => {
  const { stub, calls } = makeR2Stub();
  const bridge = createR2ArtifactBridge(stub);
  const longUserId = 'a'.repeat(80);
  await bridge.upload({
    buffer: Buffer.from('x'),
    fileName: 'a.bin',
    userId: longUserId,
  });
  // Key shape: artifacts/<userIdSliced>/<ts>-a.bin
  const keyParts = calls.put[0].key.split('/');
  assert.equal(keyParts[0], 'artifacts');
  assert.equal(keyParts[1].length, 36);
});

test('getSignedUrl forwards key and ttl to r2Storage.signedGetUrl', async () => {
  const { stub, calls } = makeR2Stub();
  const bridge = createR2ArtifactBridge(stub);
  const url = await bridge.getSignedUrl('artifacts/u/123-file.pdf', 900);
  assert.equal(url, 'https://r2.local/get/artifacts/u/123-file.pdf');
  assert.deepEqual(calls.signedGetUrl[0], { key: 'artifacts/u/123-file.pdf', ttl: 900 });
});

test('delete forwards to r2Storage.delete', async () => {
  const { stub, calls } = makeR2Stub();
  const bridge = createR2ArtifactBridge(stub);
  const res = await bridge.delete('artifacts/u/a.pdf');
  assert.deepEqual(res, { deleted: true });
  assert.deepEqual(calls.delete, ['artifacts/u/a.pdf']);
});

test('signedUploadUrl returns key + presigned PUT url', async () => {
  const { stub, calls } = makeR2Stub();
  const bridge = createR2ArtifactBridge(stub);
  const out = await bridge.signedUploadUrl({ fileName: 'doc.pdf', userId: 'u-7', contentType: 'application/pdf' });
  assert.ok(out.key.endsWith('-doc.pdf'));
  assert.ok(out.key.startsWith('artifacts/u-7/'));
  assert.equal(calls.signedPutUrl.length, 1);
  assert.equal(calls.signedPutUrl[0].contentType, 'application/pdf');
});
