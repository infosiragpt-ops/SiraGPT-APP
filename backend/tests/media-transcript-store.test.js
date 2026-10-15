'use strict';

// media-transcript-store: the gzip sidecar that keeps a media transcription's
// segments out of the database, plus the owner-scoped loader and the
// DocumentAnalysis pointer. Temp dirs and a Prisma double that only accepts
// the columns declared in schema.prisma.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const store = require('../src/services/media-transcript-store');
const fmt = require('../src/services/media-transcript-format');

const NOW = new Date('2026-10-15T15:00:00Z');

const schema = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
function modelFields(name) {
  const match = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  assert.ok(match, `${name} model present in schema.prisma`);
  return new Set(match[1].split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('@@'))
    .map((l) => l.split(/\s+/)[0]));
}
const FILE_FIELDS = modelFields('File');
const ANALYSIS_FIELDS = modelFields('DocumentAnalysis');

function assertColumns(label, fields, obj) {
  for (const key of Object.keys(obj || {})) assert.ok(fields.has(key), `${label}: \`${key}\` is not a column`);
}

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-transcripts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, '.transcripts');
}

const RESULT = Object.freeze({
  ok: true,
  status: 'ready',
  text: 'Transcripción — 63 caracteres, modelo: whisper-large-v3-turbo, idioma: es\n---\nHola a todos. Hoy vemos la célula. ¿Alguna pregunta?',
  transcript: 'Hola a todos. Hoy vemos la célula. ¿Alguna pregunta?',
  method: 'whisper',
  model: 'whisper-large-v3-turbo',
  language: 'es',
  durationSec: 3725.4567,
  segments: [
    { start: 0.12345, end: 2.5, text: 'Hola a todos.', speaker: 'SPEAKER_00', confidence: 0.91234 },
    { start: 2.7, end: 5.25, text: 'Hoy vemos la célula.', speaker: 'SPEAKER_00' },
    { start: 3700, end: 3702.1, text: '¿Alguna pregunta?', speaker: 'SPEAKER_01', confidence: 0.3 },
    { start: 3703, end: 3704, text: '   ' },
  ],
  gaps: [{ start: 1200, end: 1800, reason: 'timeout' }],
  coverage: 0.8389,
  providers: { groq: 6, local: 1 },
  engine: 'mixed',
  partial: true,
  segmentCount: 4,
});

function fakePrisma({ files = [], analyses = [] } = {}) {
  const fileRows = new Map(files.map((f) => [f.id, { deletedAt: null, ...f }]));
  const analysisRows = new Map(analyses.map((a) => [a.fileId, { ...a }]));
  const calls = { fileFind: [], analysisFind: [], upserts: [] };
  const prisma = {
    file: {
      async findFirst({ where, select }) {
        assertColumns('file.findFirst.where', FILE_FIELDS, where);
        assertColumns('file.findFirst.select', FILE_FIELDS, select);
        calls.fileFind.push(where);
        const row = fileRows.get(where.id);
        if (!row || row.userId !== where.userId) return null;
        if ('deletedAt' in where && where.deletedAt === null && row.deletedAt != null) return null;
        return Object.fromEntries(Object.keys(select || row).map((k) => [k, row[k]]));
      },
    },
    documentAnalysis: {
      async findUnique({ where, select }) {
        assertColumns('documentAnalysis.findUnique.where', ANALYSIS_FIELDS, where);
        assertColumns('documentAnalysis.findUnique.select', ANALYSIS_FIELDS, select);
        calls.analysisFind.push(where);
        const row = analysisRows.get(where.fileId);
        return row ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : null;
      },
      async upsert({ where, create, update }) {
        assertColumns('documentAnalysis.upsert.where', ANALYSIS_FIELDS, where);
        assertColumns('documentAnalysis.upsert.create', ANALYSIS_FIELDS, create);
        assertColumns('documentAnalysis.upsert.update', ANALYSIS_FIELDS, update);
        for (const required of ['userId', 'fileId']) assert.ok(create[required], `create.${required} is required`);
        calls.upserts.push({ where, create, update });
        const existing = analysisRows.get(where.fileId);
        const row = existing ? { ...existing, ...update } : { id: `an_${where.fileId}`, ...create };
        analysisRows.set(where.fileId, row);
        return row;
      },
    },
  };
  return { prisma, calls, analysisRows };
}

// ── sidecar I/O ─────────────────────────────────────────────────────────────

test('writeSidecar → readSidecar round trip: gzip, compact segments, atomic write', async (t) => {
  const root = tmpRoot(t);
  const written = await store.writeSidecar({ fileId: 'file_abc123', userId: 'user_1', result: RESULT }, { root, now: NOW });
  assert.equal(written.sidecarPath, path.join(root, 'file_abc123.json.gz'));
  assert.equal(written.segmentCount, 3, 'the empty segment is not stored');
  assert.deepEqual(fs.readdirSync(root), ['file_abc123.json.gz'], 'no temp file is left behind');
  const raw = fs.readFileSync(written.sidecarPath);
  assert.equal(written.bytes, raw.length);
  assert.deepEqual([raw[0], raw[1]], [0x1f, 0x8b], 'gzip magic');
  const onDisk = JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
  assert.deepEqual(onDisk, {
    version: 1,
    fileId: 'file_abc123',
    userId: 'user_1',
    language: 'es',
    durationSec: 3725.457,
    providers: { groq: 6, local: 1 },
    engine: 'mixed',
    coverage: 0.839,
    gaps: [{ start: 1200, end: 1800, reason: 'timeout' }],
    partial: true,
    segments: [
      { s: 0.123, e: 2.5, t: 'Hola a todos.', spk: 'SPEAKER_00', conf: 0.912 },
      { s: 2.7, e: 5.25, t: 'Hoy vemos la célula.', spk: 'SPEAKER_00' },
      { s: 3700, e: 3702.1, t: '¿Alguna pregunta?', spk: 'SPEAKER_01', conf: 0.3 },
    ],
    createdAt: '2026-10-15T15:00:00.000Z',
  });
  assert.deepEqual(await store.readSidecar('file_abc123', { root }), onDisk);

  // Overwrite in place (a retry) keeps one file.
  await store.writeSidecar({ fileId: 'file_abc123', userId: 'user_1', result: { ...RESULT, language: 'en' } }, { root, now: NOW });
  assert.equal((await store.readSidecar('file_abc123', { root })).language, 'en');
  assert.deepEqual(fs.readdirSync(root), ['file_abc123.json.gz']);
});

test('the default root lives under UPLOAD_DIR/.transcripts', () => {
  assert.equal(store.transcriptsRoot({ UPLOAD_DIR: '/data/uploads' }), path.join('/data/uploads', '.transcripts'));
  assert.equal(store.transcriptsRoot({}), path.join(path.resolve('uploads'), '.transcripts'));
  assert.equal(store.sidecarPathFor('f1', { env: { UPLOAD_DIR: '/x' } }), path.join('/x', '.transcripts', 'f1.json.gz'));
});

test('missing, corrupt, foreign or wrong-version sidecars read as null', async (t) => {
  const root = tmpRoot(t);
  assert.equal(await store.readSidecar('nope', { root }), null, 'missing');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'corrupt.json.gz'), Buffer.from('definitely not gzip'));
  assert.equal(await store.readSidecar('corrupt', { root }), null, 'corrupt gzip');
  const truncated = zlib.gzipSync(Buffer.from(JSON.stringify({ version: 1, fileId: 'trunc', userId: 'u', segments: [] }))).subarray(0, 12);
  fs.writeFileSync(path.join(root, 'trunc.json.gz'), truncated);
  assert.equal(await store.readSidecar('trunc', { root }), null, 'truncated gzip');
  fs.writeFileSync(path.join(root, 'badjson.json.gz'), zlib.gzipSync(Buffer.from('{"version":1,')));
  assert.equal(await store.readSidecar('badjson', { root }), null, 'gzip of invalid JSON');
  fs.writeFileSync(path.join(root, 'v2.json.gz'), zlib.gzipSync(Buffer.from(JSON.stringify({ version: 2, fileId: 'v2', userId: 'u', segments: [] }))));
  assert.equal(await store.readSidecar('v2', { root }), null, 'unknown version');
  fs.writeFileSync(path.join(root, 'moved.json.gz'), zlib.gzipSync(Buffer.from(JSON.stringify({ version: 1, fileId: 'other', userId: 'u', segments: [] }))));
  assert.equal(await store.readSidecar('moved', { root }), null, 'written for another file');
});

test('fileIds are plain tokens: no path traversal', async (t) => {
  const root = tmpRoot(t);
  for (const bad of ['../etc/passwd', 'a/b', '', '.hidden', 'x'.repeat(200), null, 42]) {
    assert.throws(() => store.sidecarPathFor(bad, { root }), /invalid fileId/);
    assert.equal(await store.readSidecar(bad, { root }), null);
    assert.equal(await store.deleteSidecar(bad, { root }), false);
  }
  await assert.rejects(store.writeSidecar({ fileId: '../x', userId: 'u', result: RESULT }, { root }), /invalid fileId/);
  await assert.rejects(store.writeSidecar({ fileId: 'ok', userId: '', result: RESULT }, { root }), /userId required/);
  assert.equal(fs.existsSync(root), false, 'nothing written on refusal');
});

test('deleteSidecar reports whether a sidecar existed', async (t) => {
  const root = tmpRoot(t);
  await store.writeSidecar({ fileId: 'f1', userId: 'u1', result: RESULT }, { root });
  assert.equal(await store.deleteSidecar('f1', { root }), true);
  assert.equal(await store.deleteSidecar('f1', { root }), false);
  assert.equal(await store.readSidecar('f1', { root }), null);
});

// ── owner-scoped load ───────────────────────────────────────────────────────

test('loadMediaTranscript is owner-scoped and returns the formatter-ready shape', async (t) => {
  const root = tmpRoot(t);
  await store.writeSidecar({ fileId: 'f_owned', userId: 'u1', result: RESULT }, { root, now: NOW });
  const { prisma, calls } = fakePrisma({ files: [{ id: 'f_owned', userId: 'u1', originalName: 'clase.mp4', filename: '1700-clase.mp4', mimeType: 'video/mp4' }] });

  const loaded = await store.loadMediaTranscript(prisma, { userId: 'u1', fileId: 'f_owned' }, { root });
  assert.deepEqual(calls.fileFind[0], { id: 'f_owned', userId: 'u1', deletedAt: null });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.fileName, 'clase.mp4');
  assert.equal(loaded.mimeType, 'video/mp4');
  assert.equal(loaded.engine, 'mixed');
  assert.equal(loaded.partial, true);
  assert.deepEqual(loaded.segments, [
    { start: 0.123, end: 2.5, text: 'Hola a todos.', speaker: 'SPEAKER_00', confidence: 0.912 },
    { start: 2.7, end: 5.25, text: 'Hoy vemos la célula.', speaker: 'SPEAKER_00' },
    { start: 3700, end: 3702.1, text: '¿Alguna pregunta?', speaker: 'SPEAKER_01', confidence: 0.3 },
  ]);

  // The loaded object feeds the formatter as is.
  const pack = fmt.buildTranscriptPack(loaded, { now: NOW });
  assert.match(pack.txt, /\nArchivo: clase\.mp4\n/);
  assert.match(pack.txt, /\n\[00:00:00\] Hablante 1: Hola a todos\. Hoy vemos la célula\.\n/);
  assert.match(pack.txt, /\n\[01:01:40\] Hablante 2: ¿Alguna pregunta\? \[\?\]\n/);
  assert.match(pack.txt, /\nTramos sin transcribir: 00:20:00–00:30:00 \(tiempo agotado\)\n/);
  assert.equal(pack.stats.speakers, 2);

  // Another user, even with the right fileId, gets nothing.
  assert.equal(await store.loadMediaTranscript(prisma, { userId: 'u2', fileId: 'f_owned' }, { root }), null);
  assert.equal(await store.loadMediaTranscript(prisma, { userId: '', fileId: 'f_owned' }, { root }), null);
  assert.equal(await store.loadMediaTranscript(null, { userId: 'u1', fileId: 'f_owned' }, { root }), null);
});

test('loadMediaTranscript: deleted file, missing sidecar, corrupt gzip, foreign sidecar → null', async (t) => {
  const root = tmpRoot(t);
  const { prisma } = fakePrisma({
    files: [
      { id: 'f_deleted', userId: 'u1', originalName: 'a.mp3', mimeType: 'audio/mpeg', deletedAt: new Date() },
      { id: 'f_nosidecar', userId: 'u1', originalName: 'b.mp3', mimeType: 'audio/mpeg' },
      { id: 'f_corrupt', userId: 'u1', originalName: 'c.mp3', mimeType: 'audio/mpeg' },
      { id: 'f_foreign', userId: 'u1', originalName: 'd.mp3', mimeType: 'audio/mpeg' },
    ],
  });
  await store.writeSidecar({ fileId: 'f_deleted', userId: 'u1', result: RESULT }, { root });
  fs.writeFileSync(path.join(root, 'f_corrupt.json.gz'), Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad]));
  // A sidecar written for another owner never leaks through the File row check.
  await store.writeSidecar({ fileId: 'f_foreign', userId: 'u9', result: RESULT }, { root });

  for (const fileId of ['f_deleted', 'f_nosidecar', 'f_corrupt', 'f_foreign', 'f_unknown']) {
    assert.equal(await store.loadMediaTranscript(prisma, { userId: 'u1', fileId }, { root }), null, fileId);
  }
  // A database error never escapes the loader.
  const broken = { file: { async findFirst() { throw new Error('db down'); } } };
  assert.equal(await store.loadMediaTranscript(broken, { userId: 'u1', fileId: 'f_deleted' }, { root }), null);
});

test('a legacy text-only result is stored as one synthetic segment and renders as plain text', async (t) => {
  const root = tmpRoot(t);
  const legacy = { ok: true, method: 'local-whisper', language: 'es', text: 'Transcripción local — 20 caracteres, modelo: base, idioma: es\n---\nSolo texto. Sin tiempos.' };
  const written = await store.writeSidecar({ fileId: 'f_legacy', userId: 'u1', result: legacy }, { root, now: NOW });
  assert.equal(written.segmentCount, 1);
  assert.deepEqual(written.sidecar.segments, [{ s: 0, e: 0, t: 'Solo texto. Sin tiempos.' }]);
  assert.equal(written.sidecar.synthetic, true);
  assert.equal(written.sidecar.engine, 'local');
  const { prisma } = fakePrisma({ files: [{ id: 'f_legacy', userId: 'u1', originalName: 'nota.ogg', mimeType: 'audio/ogg' }] });
  const loaded = await store.loadMediaTranscript(prisma, { userId: 'u1', fileId: 'f_legacy' }, { root });
  assert.equal(loaded.synthetic, true);
  assert.equal(fmt.renderText(loaded, { header: false }), 'Solo texto. Sin tiempos.\n');
  assert.equal(fmt.renderSrt(loaded), '');
});

// ── DocumentAnalysis pointer ────────────────────────────────────────────────

test('upsertMediaTranscriptAnalysis creates the row with schema columns and a small pointer', async () => {
  const { prisma, calls } = fakePrisma({ files: [{ id: 'f1', userId: 'u1', originalName: 'clase.mp4', mimeType: 'video/mp4' }] });
  const row = await store.upsertMediaTranscriptAnalysis(prisma, {
    fileId: 'f1', userId: 'u1', result: RESULT, sidecarPath: '/srv/uploads/.transcripts/f1.json.gz',
  });
  assert.equal(calls.upserts.length, 1);
  const { where, create, update } = calls.upserts[0];
  assert.deepEqual(where, { fileId: 'f1' });
  const metadata = {
    kind: 'media_transcript',
    sidecar: '.transcripts/f1.json.gz',
    durationSec: 3725.457,
    providers: { groq: 6, local: 1 },
    coverage: 0.839,
    speakers: 2,
    segmentCount: 3,
    language: 'es',
    partial: true,
    gaps: [{ start: 1200, end: 1800, reason: 'timeout' }],
    engine: 'mixed',
  };
  assert.deepEqual(create, {
    userId: 'u1', fileId: 'f1', status: 'ready', language: 'es', mimeType: 'video/mp4', charCount: 52, metadata,
  });
  assert.deepEqual(update, { status: 'ready', language: 'es', charCount: 52, metadata });
  assert.equal(row.metadata.kind, 'media_transcript');
  // The database never holds the segments or an absolute server path.
  const serialized = JSON.stringify(create);
  assert.ok(!serialized.includes('Hoy vemos la célula'));
  assert.ok(!serialized.includes('/srv/uploads'));
});

test('upsertMediaTranscriptAnalysis preserves existing analysis metadata and refuses other owners', async () => {
  const { prisma, calls, analysisRows } = fakePrisma({
    files: [
      { id: 'f1', userId: 'u1', originalName: 'clase.mp4', mimeType: 'video/mp4' },
      { id: 'f2', userId: 'u2', originalName: 'otra.mp4', mimeType: 'video/mp4' },
      { id: 'f3', userId: 'u1', originalName: 'borrado.mp4', mimeType: 'video/mp4', deletedAt: new Date() },
      { id: 'f4', userId: 'u1', originalName: 'raro.mp4', mimeType: 'video/mp4' },
    ],
    analyses: [
      { fileId: 'f1', userId: 'u1', metadata: { originalName: 'clase.mp4', analyzedAt: '2026-10-01T00:00:00.000Z', kind: 'document' } },
      { fileId: 'f4', userId: 'u7', metadata: {} },
    ],
  });
  await store.upsertMediaTranscriptAnalysis(prisma, { fileId: 'f1', userId: 'u1', result: RESULT, sidecarPath: 'x/f1.json.gz' });
  const merged = analysisRows.get('f1').metadata;
  assert.equal(merged.originalName, 'clase.mp4', 'document-intelligence keys survive');
  assert.equal(merged.analyzedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(merged.kind, 'media_transcript', 'the media keys win');
  assert.equal(merged.sidecar, '.transcripts/f1.json.gz');

  const before = calls.upserts.length;
  assert.equal(await store.upsertMediaTranscriptAnalysis(prisma, { fileId: 'f2', userId: 'u1', result: RESULT }), null, 'file of another user');
  assert.equal(await store.upsertMediaTranscriptAnalysis(prisma, { fileId: 'f3', userId: 'u1', result: RESULT }), null, 'deleted file');
  assert.equal(await store.upsertMediaTranscriptAnalysis(prisma, { fileId: 'f4', userId: 'u1', result: RESULT }), null, 'analysis row owned by someone else');
  assert.equal(await store.upsertMediaTranscriptAnalysis(prisma, { fileId: '../f1', userId: 'u1', result: RESULT }), null, 'invalid fileId');
  assert.equal(await store.upsertMediaTranscriptAnalysis({}, { fileId: 'f1', userId: 'u1', result: RESULT }), null, 'no documentAnalysis delegate');
  assert.equal(calls.upserts.length, before, 'no write on refusal');
});

test('mediaTranscriptMetadata derives coverage and stats from older results', () => {
  const legacy = { ok: true, method: 'whisper', text: 'Hola.', language: 'es' };
  assert.deepEqual(store.mediaTranscriptMetadata(legacy, { fileId: 'f9' }), {
    kind: 'media_transcript',
    sidecar: '.transcripts/f9.json.gz',
    durationSec: null,
    providers: {},
    coverage: null,
    speakers: 0,
    segmentCount: 0,
    language: 'es',
    partial: false,
    gaps: [],
    engine: 'cloud',
  });
  const timed = { segments: [{ start: 0, end: 10, text: 'a' }], durationSec: 100, gaps: [{ start: 50, end: 75 }] };
  const meta = store.mediaTranscriptMetadata(timed, { fileId: 'f9' });
  assert.equal(meta.coverage, 0.75);
  assert.equal(meta.partial, true);
  assert.equal(meta.segmentCount, 1);
});
