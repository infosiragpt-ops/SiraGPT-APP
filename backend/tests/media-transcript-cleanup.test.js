'use strict';

// A recording's timed transcript lives beside the uploads
// (<UPLOAD_DIR>/.transcripts/<fileId>.json.gz, plus <fileId>.clip.json for a
// link clip), not in the File row. It must go with the file: the delete
// route and the GDPR account scrub remove it. The media pointer row is
// `pending`, so the analysis route still builds the real analysis.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const { buildRouteTestApp, installAuthSessionMock, reloadModule } = require('./http-test-utils');
const store = require('../src/services/media-transcript-store');

const RESULT = {
  ok: true,
  durationSec: 600,
  language: 'es',
  segments: [{ start: 0, end: 4, text: 'Hola a todos.' }, { start: 300, end: 304, text: 'Seguimos.' }],
  gaps: [],
};

describe('files routes · the transcript goes with the file', () => {
  let auth;
  let uploadDir;
  let previousUploadDir;
  let prisma;
  let docintel;
  let originals;
  let rows;

  beforeEach(() => {
    auth = installAuthSessionMock();
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-transcript-cleanup-'));
    previousUploadDir = process.env.UPLOAD_DIR;
    process.env.UPLOAD_DIR = uploadDir;
    delete require.cache[require.resolve('../src/middleware/upload')];
    delete require.cache[require.resolve('../src/routes/files')];
    prisma = require('../src/config/database');
    docintel = require('../src/services/document-intelligence');
    originals = {
      findFirst: prisma.file.findFirst,
      delete: prisma.file.delete,
      getAnalysisForFile: docintel.getAnalysisForFile,
      analyzeFile: docintel.analyzeFile,
    };
    rows = new Map();
    prisma.file.findFirst = async ({ where }) => {
      const row = rows.get(where.id);
      return row && row.userId === where.userId ? row : null;
    };
    prisma.file.delete = async ({ where }) => {
      const row = rows.get(where.id);
      rows.delete(where.id);
      return row;
    };
  });

  afterEach(() => {
    prisma.file.findFirst = originals.findFirst;
    prisma.file.delete = originals.delete;
    docintel.getAnalysisForFile = originals.getAnalysisForFile;
    docintel.analyzeFile = originals.analyzeFile;
    delete require.cache[require.resolve('../src/middleware/upload')];
    delete require.cache[require.resolve('../src/routes/files')];
    if (previousUploadDir === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = previousUploadDir;
    fs.rmSync(uploadDir, { recursive: true, force: true });
    auth.restore();
  });

  function buildApp() {
    return buildRouteTestApp('/api/files', reloadModule('../src/routes/files'));
  }

  test('DELETE /api/files/:id removes the transcript sidecar and the clip offset record', async () => {
    const binary = path.join(uploadDir, 'clase.mp4');
    fs.writeFileSync(binary, Buffer.alloc(16));
    rows.set('rec1', { id: 'rec1', userId: auth.user.id, path: binary, originalName: 'clase.mp4', mimeType: 'video/mp4' });
    rows.set('keep', { id: 'keep', userId: auth.user.id, path: path.join(uploadDir, 'otra.mp4'), mimeType: 'video/mp4' });
    await store.writeSidecar({ fileId: 'rec1', userId: auth.user.id, result: RESULT });
    await store.recordMediaClipOffset({ fileId: 'rec1', userId: auth.user.id, timeOffsetSec: 3600 });
    await store.writeSidecar({ fileId: 'keep', userId: auth.user.id, result: RESULT });
    const transcripts = path.join(uploadDir, '.transcripts');
    assert.deepEqual(fs.readdirSync(transcripts).sort(), ['keep.json.gz', 'rec1.clip.json', 'rec1.json.gz']);

    const res = await request(buildApp()).delete('/api/files/rec1').set('Authorization', auth.authHeader);
    assert.equal(res.status, 200);
    assert.equal(rows.has('rec1'), false);
    assert.deepEqual(fs.readdirSync(transcripts), ['keep.json.gz'], 'only the deleted file\'s transcript goes');
  });

  test('another user cannot delete the file, and its transcript stays', async () => {
    rows.set('rec2', { id: 'rec2', userId: 'someone-else', path: path.join(uploadDir, 'x.mp4'), mimeType: 'video/mp4' });
    await store.writeSidecar({ fileId: 'rec2', userId: 'someone-else', result: RESULT });
    const res = await request(buildApp()).delete('/api/files/rec2').set('Authorization', auth.authHeader);
    assert.equal(res.status, 404);
    assert.ok(fs.existsSync(path.join(uploadDir, '.transcripts', 'rec2.json.gz')));
  });

  test('GET /api/files/:id/analysis builds the real analysis over a pending media pointer', async () => {
    rows.set('rec3', { id: 'rec3', userId: auth.user.id });
    const analyzed = [];
    docintel.getAnalysisForFile = async () => ({ id: 'an1', fileId: 'rec3', status: 'pending', chunkCount: 0, summary: null, chunks: [] });
    docintel.analyzeFile = async (_prisma, args) => {
      analyzed.push(args.fileId);
      return { id: 'an1', fileId: 'rec3', status: 'ready', chunkCount: 12, summary: 'Clase sobre la célula.' };
    };
    const res = await request(buildApp()).get('/api/files/rec3/analysis').set('Authorization', auth.authHeader);
    assert.equal(res.status, 200);
    assert.deepEqual(analyzed, ['rec3']);
    assert.equal(res.body.analysis.chunkCount, 12);

    // A finished analysis is served as is.
    docintel.getAnalysisForFile = async () => ({ id: 'an1', fileId: 'rec3', status: 'ready', chunkCount: 12 });
    await request(buildApp()).get('/api/files/rec3/analysis').set('Authorization', auth.authHeader);
    assert.deepEqual(analyzed, ['rec3']);
  });
});

test('the GDPR account scrub removes every transcript sidecar of the account', async () => {
  const { run } = require('../src/jobs/scrub-deleted-user-content');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-scrub-transcripts-'));
  try {
    await store.writeSidecar({ fileId: 'f1', userId: 'gone', result: RESULT }, { root });
    await store.recordMediaClipOffset({ fileId: 'f1', userId: 'gone', timeOffsetSec: 60, root });
    await store.writeSidecar({ fileId: 'f-other', userId: 'alive', result: RESULT }, { root });
    const purged = [];
    const updates = [];
    const prisma = {
      user: { findMany: async () => [{ id: 'gone', email: 'g@example.com', deletedAt: new Date(0) }] },
      chat: { findMany: async () => [] },
      message: { findMany: async () => [], update: async () => ({}) },
      file: {
        findMany: async ({ where }) => (where.userId === 'gone'
          ? [{ id: 'f1', filename: 'clase.mp4', originalName: 'clase.mp4', extractedText: '[00:00] Hola a todos.', processingError: null }]
          : []),
        update: async ({ where, data }) => { updates.push({ id: where.id, data }); return {}; },
      },
    };
    const transcriptStore = { purgeMediaTranscript: async (fileId) => { purged.push(fileId); return store.purgeMediaTranscript(fileId, { root }); } };
    const common = {
      prisma, transcriptStore, now: new Date('2030-01-01T00:00:00Z'), scrubAfterDays: 0,
      piiMask: { mask: () => '[masked]', maskObject: (o) => o }, logger: { info() {}, warn() {}, error() {} },
    };
    // A dry run removes nothing.
    await run({ ...common, dryRun: true });
    assert.deepEqual(purged, []);
    assert.deepEqual(updates, []);
    await run({ ...common, dryRun: false });
    assert.deepEqual(purged, ['f1']);
    assert.deepEqual(fs.readdirSync(root), ['f-other.json.gz']);
    assert.equal(updates.at(-1).data.processingError, '[PII scrubbed by GDPR job]', 'a purged file is marked done');

    // A purge failure is logged and never stops the scrub; the file is masked
    // but left unmarked, so the next run retries the purge.
    for (const failing of [
      async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); },
      async () => ({ sidecar: false, clip: false, error: 'EACCES' }),
    ]) {
      const warnings = [];
      updates.length = 0;
      const result = await run({ ...common, dryRun: false, transcriptStore: { purgeMediaTranscript: failing },
        logger: { info() {}, warn: (line) => warnings.push(line), error() {} } });
      assert.equal(result.files, 1);
      assert.ok(warnings.some((line) => /file=f1 transcript purge failed code=E(IO|ACCES)/.test(line)), warnings.join('\n'));
      assert.equal(updates.length, 1);
      assert.equal(updates[0].data.extractedText, '[masked]', 'the text is still masked');
      assert.equal('processingError' in updates[0].data, false, 'no scrub marker: the purge is retried');
    }

    // A real unlink failure through the store itself (a directory where the
    // sidecar should be) reaches the scrub as a failure, not as «absent».
    fs.mkdirSync(path.join(root, 'f1.json.gz'));
    updates.length = 0;
    const warnings = [];
    await run({ ...common, dryRun: false, transcriptStore: { purgeMediaTranscript: (fileId) => store.purgeMediaTranscript(fileId, { root }) },
      logger: { info() {}, warn: (line) => warnings.push(line), error() {} } });
    assert.ok(warnings.some((line) => /file=f1 transcript purge failed code=/.test(line)));
    assert.equal('processingError' in updates[0].data, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── the `pending` media pointer is not an analysis ──────────────────────────

const TRANSCRIPT_TEXT = '[00:00:00] Hola a todos. Hoy vemos la célula, sus organelos y cómo la mitocondria produce la energía que la célula necesita.';

test('a chat turn builds the real analysis over a pending media pointer (and drops its stale chunks)', async () => {
  const attachments = require('../src/services/message-attachments');
  const docintel = require('../src/services/document-intelligence');
  const original = docintel.analyzeFile;
  const analyzed = [];
  docintel.analyzeFile = async (_prisma, { fileRecord }) => {
    analyzed.push(fileRecord.id);
    return { id: 'an1', fileId: fileRecord.id, status: 'ready', chunkCount: 3, chunks: [] };
  };
  const rowWith = (documentAnalysis) => ({ id: 'rec', originalName: 'clase.mp4', filename: 'clase.mp4', mimeType: 'video/mp4',
    size: 10, path: null, extractedText: TRANSCRIPT_TEXT, documentAnalysis });
  const prismaFor = (row) => ({ file: { findMany: async () => [row] }, documentAnalysis: {} });
  try {
    // Chunks of the text a gap retry replaced survive on the pending row.
    const stale = rowWith({ id: 'an1', status: 'pending', chunkCount: 2, chunks: [{ ordinal: 0, text: 'Texto parcial viejo.' }], tables: [] });
    const text = await attachments.buildTranscriptionTextFromFiles(prismaFor(stale), { userId: 'u1', fileIds: ['rec'] });
    assert.deepEqual(analyzed, ['rec'], 'the pending pointer is analyzed like a missing analysis');
    assert.match(text, /mitocondria/);

    // A finished analysis is reused as before.
    analyzed.length = 0;
    await attachments.buildTranscriptionTextFromFiles(prismaFor(rowWith({ id: 'an1', status: 'ready', chunkCount: 3, chunks: [], tables: [] })),
      { userId: 'u1', fileIds: ['rec'] });
    assert.deepEqual(analyzed, []);
  } finally {
    docintel.analyzeFile = original;
  }
});

test('diagnose reads a ready transcript with a pending pointer as missing_analysis, never empty_analysis', async () => {
  const documentContext = require('../src/services/agents/document-context');
  const prismaWith = (analysis) => ({
    file: { findFirst: async () => ({ id: 'rec', originalName: 'clase.mp4', mimeType: 'video/mp4', size: 10, path: null,
      extractedText: TRANSCRIPT_TEXT, processingStage: 'ready', processingError: null, processingStageAt: new Date(), createdAt: new Date(), updatedAt: new Date() }) },
    documentAnalysis: { findFirst: async () => analysis },
  });
  const pending = await documentContext.diagnoseFile(prismaWith({ id: 'an1', status: 'pending', chunkCount: 0, _count: { chunks: 0, tables: 0 } }),
    { userId: 'u1', fileId: 'rec' });
  assert.equal(pending.result.diagnostics.health, 'missing_analysis');
  assert.equal(pending.result.diagnostics.analysisStatus, 'pending');
  // A finished analysis with no chunks is still reported as empty.
  const empty = await documentContext.diagnoseFile(prismaWith({ id: 'an1', status: 'ready', chunkCount: 0, _count: { chunks: 0, tables: 0 } }),
    { userId: 'u1', fileId: 'rec' });
  assert.equal(empty.result.diagnostics.health, 'empty_analysis');
});
