'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the production scheduler with deferred provider I/O and an in-memory
// File model. No HTTP, credentials, database, or upload pipeline is required.
const source = fs.readFileSync(path.join(__dirname, '../src/routes/files.js'), 'utf8');
const start = source.indexOf('function scheduleOpenAiFilesUpload(');
const end = source.indexOf('// ─── Parallel batch processor', start);
assert.ok(start >= 0 && end > start, 'the production background scheduler is present');

function harness() {
  let finishUpload;
  const upload = new Promise((resolve) => { finishUpload = resolve; });
  const warnings = [];
  const context = vm.createContext({
    uploadToOpenAiFiles: () => upload,
    console: { warn: (...args) => warnings.push(args) },
  });
  vm.runInContext(source.slice(start, end), context);
  const rows = new Map([['kept-file', { id: 'kept-file', openaiFileId: null }], ['uploaded-file', { id: 'uploaded-file', openaiFileId: null }]]);
  const prismaErrors = [];
  const model = {
    async update({ where, data }) {
      if (!rows.has(where.id)) {
        prismaErrors.push('P2025'); // Prisma logs before the caller can catch.
        throw Object.assign(new Error('No record was found for an update.'), { code: 'P2025' });
      }
      Object.assign(rows.get(where.id), data);
      return rows.get(where.id);
    },
    async updateMany({ where, data }) {
      if (!rows.has(where.id)) return { count: 0 };
      Object.assign(rows.get(where.id), data);
      return { count: 1 };
    },
  };
  return { rows, warnings, prismaErrors, model, finishUpload, start: () => context.scheduleOpenAiFilesUpload({ file: model }, 'uploaded-file', {}) };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('deleting a file during a background upload causes no missing-row Prisma error or resurrection', async () => {
  const h = harness();
  h.start();
  await settle();
  h.rows.delete('uploaded-file');
  h.finishUpload('provider-file-test');
  await settle();
  assert.deepEqual(h.prismaErrors, [], 'a normal concurrent deletion must not execute a throwing update');
  assert.equal(h.rows.has('uploaded-file'), false);
  assert.equal(h.rows.get('kept-file').openaiFileId, null, 'only the requested File may be updated');
  assert.deepEqual(h.warnings, []);
});

test('the auxiliary provider id is persisted when the File still exists', async () => {
  const h = harness();
  h.start();
  h.finishUpload('provider-file-test');
  await settle();
  assert.equal(h.rows.get('uploaded-file').openaiFileId, 'provider-file-test');
  assert.equal(h.rows.get('kept-file').openaiFileId, null);
  assert.deepEqual(h.warnings, []);
});

test('a skipped provider upload never changes File metadata', async () => {
  const h = harness();
  h.start();
  h.finishUpload(null);
  await settle();
  assert.equal(h.rows.get('uploaded-file').openaiFileId, null);
  assert.deepEqual(h.warnings, []);
});

test('real persistence failures remain visible instead of being treated as deletion', async () => {
  const h = harness();
  h.model.update = h.model.updateMany = async () => { throw Object.assign(new Error('database unavailable'), { code: 'P1001' }); };
  h.start();
  h.finishUpload('provider-file-test');
  await settle();
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0].join(' '), /background upload failed: database unavailable/);
  assert.equal(h.rows.get('uploaded-file').openaiFileId, null);
});
