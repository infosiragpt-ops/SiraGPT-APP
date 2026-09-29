'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { createArtifactDataPreviewHandler, createFileDataPreviewHandler } = require('../src/services/document-pipeline/preview-data-handlers');
const { DataPreviewError, MAX_SOURCE_BYTES } = require('../src/services/document-pipeline/preview-data-service');

function appFor(handler, url = '/artifact/:id/preview.data') {
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 'owner-1' }; next(); });
  app.get(url, handler);
  return app;
}

test('artifact data route checks owner before reading, cleans R2 source, and returns private JSON', async () => {
  let cleaned = false;
  let parsed;
  const app = appFor(createArtifactDataPreviewHandler({ artifactDir: '/artifact-root',
    materializeArtifactSource: async (args) => {
      assert.equal(args.id, 'abcdef1234');
      assert.equal(args.ownerUserId, 'owner-1');
      assert.equal(args.artifactDir, '/artifact-root');
      return { ok: true, sourcePath: '/temp/hydrated', filename: 'survey.sav', fromR2: true,
        cleanup: async () => { cleaned = true; } };
    },
    preview: async (args) => { parsed = args; return { format: 'sav', rows: [[1, 5]], columns: [{ name: 'ID' }, { name: 'P01' }] }; },
  }));
  const response = await request(app).get('/artifact/ABCDEF1234/preview.data?limit=20&offset=40');
  assert.equal(response.status, 200);
  assert.equal(response.body.format, 'sav');
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.match(response.headers['content-type'], /application\/json/);
  assert.equal(parsed.cacheScope, 'artifact:owner-1:abcdef1234');
  assert.equal(parsed.limit, '20');
  assert.equal(parsed.offset, '40');
  assert.equal(cleaned, true);
});

test('artifact access rejection never invokes the parser; invalid id never materializes', async () => {
  let sources = 0;
  let readers = 0;
  const app = appFor(createArtifactDataPreviewHandler({
    materializeArtifactSource: async () => { sources++; return { ok: false, status: 403, error: 'artifact not found' }; },
    preview: async () => { readers++; },
  }));
  const denied = await request(app).get('/artifact/abcd1234/preview.data');
  assert.equal(denied.status, 403);
  assert.equal(readers, 0);
  const bad = await request(app).get('/artifact/not-an-artifact/preview.data');
  assert.equal(bad.status, 400);
  assert.equal(sources, 1);
});

test('artifact parser failure cleans temporary bytes and exposes a stable code without internal paths', async () => {
  let cleaned = false;
  const app = appFor(createArtifactDataPreviewHandler({
    materializeArtifactSource: async () => ({ ok: true, sourcePath: '/private/secrets/path.sav', filename: 'survey.sav',
      cleanup: async () => { cleaned = true; } }),
    preview: async () => { throw new DataPreviewError('PREVIEW_READER_UNAVAILABLE', 503); },
  }));
  const response = await request(app).get('/artifact/abcd1234/preview.data');
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'PREVIEW_READER_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(response.body), /private|secrets|path\.sav/);
  assert.equal(cleaned, true);
});

test('uploaded statistical data remains scoped to the current user and materializes only an existing object', async () => {
  let cleaned = false;
  const app = appFor(createFileDataPreviewHandler({
    prisma: { file: { findFirst: async (args) => {
      assert.deepEqual(args.where, { id: 'uploaded-file', userId: 'owner-1' });
      return { id: 'uploaded-file', originalName: 'survey.zsav', path: 'r2:survey.zsav', size: 512 };
    } } },
    objectStorage: { exists: async (ref) => ref === 'r2:survey.zsav', toLocalTemp: async () => ({
      path: '/temp/survey.zsav', cleanup: async () => { cleaned = true; },
    }) },
    preview: async (args) => { assert.equal(args.cacheScope, 'file:owner-1:uploaded-file'); return { format: 'zsav', rows: [[1]] }; },
  }), '/files/:id/preview.data');
  const response = await request(app).get('/files/uploaded-file/preview.data');
  assert.equal(response.status, 200);
  assert.equal(response.body.format, 'zsav');
  assert.equal(cleaned, true);
});

test('unknown uploaded file, unsupported format, oversized source and incomplete upload fail before hydration', async () => {
  let file = null;
  let hydrated = 0;
  const app = appFor(createFileDataPreviewHandler({
    prisma: { file: { findFirst: async () => file } },
    objectStorage: { exists: async () => false, toLocalTemp: async () => { hydrated++; } },
    preview: async () => { throw new Error('parser must not run'); },
  }), '/files/:id/preview.data');
  assert.equal((await request(app).get('/files/id/preview.data')).status, 404);
  file = { id: 'id', originalName: 'data.xlsx', path: 'x', size: 10 };
  assert.equal((await request(app).get('/files/id/preview.data')).status, 415);
  file = { id: 'id', originalName: 'data.sav', path: 'x', size: MAX_SOURCE_BYTES + 1 };
  assert.equal((await request(app).get('/files/id/preview.data')).status, 413);
  file = { id: 'id', originalName: 'data.sav', path: 'x', size: 10 };
  const notReady = await request(app).get('/files/id/preview.data');
  assert.equal(notReady.status, 409);
  assert.equal(notReady.body.code, 'PREVIEW_OBJECT_NOT_READY');
  assert.equal(hydrated, 0);
});
