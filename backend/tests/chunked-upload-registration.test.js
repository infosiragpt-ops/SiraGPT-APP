'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/routes/files.js'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function harness(row = null) {
  const rows = new Map(row ? [[row.id, row]] : []), removed = [], scheduled = [], validations = [];
  let creates = 0;
  const prisma = { file: {
    findFirst: async ({ where }) => { const record = rows.get(where.id); return record?.userId === where.userId ? record : null; },
    create: async ({ data }) => { creates++; if (rows.has(data.id)) throw Object.assign(new Error('duplicate'), { code: 'P2002' }); rows.set(data.id, { ...data }); return rows.get(data.id); },
    update: async ({ where, data }) => { Object.assign(rows.get(where.id), data); return rows.get(where.id); },
  } };
  const context = vm.createContext({
    MAX_CONCURRENT: 5, dbFileSize: value => value, Date,
    unlinkQuiet: async filename => removed.push(filename),
    fileProcessingStatus: { setStage: async (_, id, stage) => { rows.get(id).processingStage = stage; } },
    detectMime: async filename => { validations.push(filename); return { mime: 'video/mp4' }; },
    validateUploadPolicy: () => ({ ok: true }), mediaTranscription: { isMediaFile: () => true },
    scheduleFileAfterFastUpload: (_, userId, __, record) => scheduled.push({ userId, id: record.id }),
    console: { error() {}, warn() {} },
  });
  vm.runInContext(section('function uploadResponseForFile(', 'async function processFileAfterFastUpload('), context);
  vm.runInContext(section('async function processFilesForAsyncPreview(', 'function scheduleCrossDocumentAnalysisWhenReady('), context);
  const file = { deterministicId: 'upload_stable', filename: 'files-stable.mp4', originalname: 'lesson.mp4', mimetype: 'video/mp4', size: 100, path: '/temporary/owned/lesson.mp4' };
  return { prisma, rows, removed, scheduled, validations, creates: () => creates, run: () => context.processFilesForAsyncPreview([file], 'owner1', prisma) };
}

test('a registration outage preserves assembled bytes so completion can be retried', async () => {
  const h = harness(); h.prisma.file.create = async () => { throw new Error('database unavailable'); };
  await assert.rejects(h.run(), /database unavailable/);
  assert.deepEqual(h.removed, []);
  assert.equal(h.rows.size, 0);
});
test('replaying after a crash between File registration and validation reuses the row and resumes work', async () => {
  const h = harness({ id: 'upload_stable', userId: 'owner1', processingStage: 'uploaded' });
  const result = await h.run();
  assert.equal(result[0].id, 'upload_stable'); assert.equal(result[0].success, true);
  assert.equal(h.creates(), 0); assert.equal(h.validations.length, 1);
  assert.deepEqual(h.scheduled, [{ userId: 'owner1', id: 'upload_stable' }]);
});
test('lost completion acknowledgement cannot duplicate a ready File or repeat processing', async () => {
  const h = harness({ id: 'upload_stable', userId: 'owner1', processingStage: 'ready' });
  const a = await h.run(), b = await h.run();
  assert.equal(a[0].id, b[0].id); assert.equal(h.rows.size, 1); assert.equal(h.creates(), 0);
  assert.deepEqual(h.scheduled, []); assert.deepEqual(h.validations, []);
});
