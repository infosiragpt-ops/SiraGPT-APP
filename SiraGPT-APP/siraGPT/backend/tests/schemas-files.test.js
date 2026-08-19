'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FileMetadataSchema, FileUploadResponseSchema } = require('../src/schemas/files');

test('exports FileMetadataSchema and FileUploadResponseSchema', () => {
  assert.ok(FileMetadataSchema);
  assert.equal(typeof FileMetadataSchema.parse, 'function');
  assert.ok(FileUploadResponseSchema);
  assert.equal(typeof FileUploadResponseSchema.parse, 'function');
});

test('FileMetadataSchema accepts the minimum required shape (id + name)', () => {
  const out = FileMetadataSchema.parse({ id: 'f1', name: 'thesis.pdf' });
  assert.equal(out.id, 'f1');
  assert.equal(out.name, 'thesis.pdf');
});

test('FileMetadataSchema accepts numeric ids and userId', () => {
  const out = FileMetadataSchema.parse({ id: 42, name: 'x', userId: 99 });
  assert.equal(out.id, 42);
  assert.equal(out.userId, 99);
});

test('FileMetadataSchema rejects payloads missing required fields', () => {
  assert.throws(() => FileMetadataSchema.parse({}), /id|name/i);
  assert.throws(() => FileMetadataSchema.parse({ id: 'x' }), /name/i);
  assert.throws(() => FileMetadataSchema.parse({ name: 'x' }), /id/i);
});

test('FileMetadataSchema rejects negative size', () => {
  assert.throws(() => FileMetadataSchema.parse({ id: 'x', name: 'y', size: -1 }));
});

test('FileMetadataSchema accepts nullable optional fields', () => {
  const out = FileMetadataSchema.parse({
    id: 'f',
    name: 'x',
    chatId: null,
    storageKey: null,
    url: null,
    error: null,
    extension: null,
    metadata: null,
  });
  assert.equal(out.chatId, null);
  assert.equal(out.storageKey, null);
  assert.equal(out.url, null);
});

test('FileMetadataSchema passes through unknown extra fields', () => {
  const out = FileMetadataSchema.parse({
    id: 'f', name: 'x',
    extraField: 'preserved',
    nested: { a: 1 },
  });
  assert.equal(out.extraField, 'preserved');
  assert.deepEqual(out.nested, { a: 1 });
});

test('FileMetadataSchema accepts metadata as a record', () => {
  const out = FileMetadataSchema.parse({
    id: 'f', name: 'x',
    metadata: { width: 1024, height: 768, tags: ['photo'] },
  });
  assert.equal(out.metadata.width, 1024);
});

test('FileMetadataSchema accepts createdAt as ISO string or Date', () => {
  const a = FileMetadataSchema.parse({ id: '1', name: 'x', createdAt: '2026-05-21T00:00:00Z' });
  const b = FileMetadataSchema.parse({ id: '2', name: 'y', createdAt: new Date() });
  assert.ok(a.createdAt);
  assert.ok(b.createdAt);
});

test('FileUploadResponseSchema requires files array', () => {
  assert.throws(() => FileUploadResponseSchema.parse({}), /files/i);
  const out = FileUploadResponseSchema.parse({ files: [] });
  assert.deepEqual(out.files, []);
});

test('FileUploadResponseSchema validates nested file metadata', () => {
  const out = FileUploadResponseSchema.parse({
    files: [
      { id: 'f1', name: 'a.pdf' },
      { id: 'f2', name: 'b.pdf' },
    ],
  });
  assert.equal(out.files.length, 2);
  assert.equal(out.files[0].id, 'f1');
});

test('FileUploadResponseSchema rejects when a file inside files[] is invalid', () => {
  assert.throws(() => FileUploadResponseSchema.parse({
    files: [{ id: 'ok', name: 'a.pdf' }, { name: 'no-id.pdf' }],
  }));
});

test('FileUploadResponseSchema accepts failed[] with name + reason', () => {
  const out = FileUploadResponseSchema.parse({
    files: [],
    failed: [
      { name: 'corrupt.pdf', reason: 'parse_failed' },
      { name: 'too-big.pdf', reason: 'size_exceeded' },
    ],
  });
  assert.equal(out.failed.length, 2);
  assert.equal(out.failed[0].name, 'corrupt.pdf');
});

test('FileUploadResponseSchema rejects failed entries missing name or reason', () => {
  assert.throws(() => FileUploadResponseSchema.parse({
    files: [], failed: [{ name: 'x' }],
  }));
  assert.throws(() => FileUploadResponseSchema.parse({
    files: [], failed: [{ reason: 'why' }],
  }));
});

test('FileUploadResponseSchema accepts intent as a generic record or null', () => {
  const a = FileUploadResponseSchema.parse({ files: [], intent: { domain: 'legal' } });
  const b = FileUploadResponseSchema.parse({ files: [], intent: null });
  assert.equal(a.intent.domain, 'legal');
  assert.equal(b.intent, null);
});

test('FileUploadResponseSchema accepts batchId string', () => {
  const out = FileUploadResponseSchema.parse({ files: [], batchId: 'batch-1' });
  assert.equal(out.batchId, 'batch-1');
});

test('FileUploadResponseSchema passes through unknown extra fields', () => {
  const out = FileUploadResponseSchema.parse({
    files: [],
    crossDocument: { totalDocs: 0 },
  });
  assert.deepEqual(out.crossDocument, { totalDocs: 0 });
});
