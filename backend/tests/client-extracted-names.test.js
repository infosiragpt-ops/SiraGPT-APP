'use strict';

// Audio the browser extracted (lib/media/client-audio-extract.ts) keeps the
// name of what the user uploaded in every deliverable: the stored
// transcript, its files, the translation and the analysis say
// «Entrevista.mp3» or «Clase 3.mp4», never «Entrevista.audio.ogg». Only
// audio extracted from a VIDEO stays a video: its silence names the video
// and asks for it again; silent audio keeps the usual answer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const q = require('../src/services/media-transcription-queue');
const store = require('../src/services/media-transcript-store');
const fmt = require('../src/services/media-transcript-format');
const handoff = require('../src/services/media-handoff');
const { normalizeClientExtracted } = require('../src/services/client-extracted-metadata');

const NOW = Date.parse('2026-11-05T12:00:00Z');
const AUDIO_SOURCE = { tier: 'opus', sourceName: 'Entrevista.mp3', sourceSize: 200_000_000, sourceType: 'audio/mpeg' };
const VIDEO_SOURCE = { tier: 'opus', sourceName: 'Clase 3.mp4', sourceSize: 900_000_000, sourceType: 'video/mp4' };
const SPEECH = { ok: true, durationSec: 600, language: 'es', providers: { local: 1 }, engine: 'local', partial: false, gaps: [], coverage: 1,
  transcript: 'Buenos días a todos.', segments: [{ start: 0, end: 4, text: 'Buenos días a todos.' }] };

function upload(id, originalName) {
  return { id, userId: 'u1', originalName, mimeType: 'audio/ogg', size: 90_000_000, path: `/uploads/u1/${id}.ogg`, deletedAt: null,
    extractedText: null, processingError: null, processingStage: 'uploaded', processingStageAt: new Date(NOW - 300_000) };
}

function fixture(file, clientExtracted, processFile) {
  const rows = new Map([[file.id, { ...file }]]);
  const jobs = new Map();
  const sidecars = new Map();
  const matches = (row, where) => row && row.id === where.id && row.userId === where.userId && row.deletedAt == null;
  const prisma = { file: {
    async findFirst({ where }) { const row = rows.get(where.id); return matches(row, where) ? { ...row } : null; },
    async updateMany({ where, data }) {
      const row = rows.get(where.id);
      if (!matches(row, where)) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  } };
  const queue = {
    async getJob(id) { return jobs.get(id); },
    async add(name, data, opts) {
      const job = { id: opts.jobId, name, data, opts, state: 'waiting', attemptsMade: 0,
        async getState() { return this.state; }, async remove() { jobs.delete(this.id); }, discard() {} };
      jobs.set(opts.jobId, job);
      return job;
    },
  };
  const service = q.createMediaTranscriptionService({ prisma, getQueue: () => queue, now: () => NOW,
    validate: async (_l, row) => row.mimeType, offload: async row => row.path,
    materialize: async source => ({ path: source, cleanup: async () => {} }),
    createCheckpoint: row => ({ dir: `/ckpt/${row.id}`, clear: async () => {} }),
    formatter: fmt,
    processFile,
    mediaTools: {
      probe: async () => ({ ok: true, durationSec: 600, formatName: 'ogg', audio: [{ index: 0, streamOrdinal: 0, codec: 'opus', channels: 1 }],
        subtitles: [], video: [], hasAudio: true, hasVideo: false, hasTextSubtitles: false }),
      extractSubtitles: async () => ({ ok: false, error: 'none', segments: [] }),
      extractOnScreenText: async () => ({ ok: true, items: [], framesRead: 0, framesSkipped: 0, partial: false }),
    },
    transcriptStore: {
      async readMediaAnalysisInfo() { return { mediaHints: null, durationSec: null, clientExtracted: normalizeClientExtracted(clientExtracted) }; },
      async writeSidecar({ fileId, result }) {
        sidecars.set(fileId, store.normalizeSidecar(store.buildSidecar({ fileId, userId: 'u1', result })));
        return { path: `/x/${fileId}.json.gz` };
      },
      async upsertMediaTranscriptAnalysis() {},
    },
    onTerminal: () => {}, logger: { warn() {}, info() {} },
  });
  const run = async () => {
    await service.enqueueMediaTranscription({ fileId: file.id, userId: 'u1' });
    return service.processMediaJob([...jobs.values()][0]);
  };
  return { run, rows, sidecars };
}

test('re-encoded audio keeps its own name in the stored transcript and stays audio', async () => {
  const f = fixture(upload('ent', 'Entrevista.audio.ogg'), AUDIO_SOURCE, async () => ({ success: true, extractedText: 'x', transcription: SPEECH }));
  await f.run();
  const saved = f.sidecars.get('ent');
  assert.equal(saved.sourceName, 'Entrevista.mp3');
  assert.equal(saved.sourceMedia, undefined, 'an audio source is never a video');
  const video = fixture(upload('cls', 'Clase 3.audio.ogg'), VIDEO_SOURCE, async () => ({ success: true, extractedText: 'x', transcription: SPEECH }));
  await video.run();
  assert.equal(video.sidecars.get('cls').sourceName, 'Clase 3.mp4');
  assert.equal(video.sidecars.get('cls').sourceMedia, 'video');
});

test('no speech: extracted video audio names the video and asks for it again; extracted audio keeps the usual answer', async () => {
  const silent = async () => ({ success: false, code: 'no_speech', error: 'No se detectó voz en el archivo.' });
  const video = fixture(upload('cls', 'Clase 3.audio.ogg'), VIDEO_SOURCE, silent);
  await assert.rejects(video.run(), { code: 'extracted_audio_no_speech' });
  assert.match(video.rows.get('cls').processingError, /Solo se subió el audio de «Clase 3\.mp4»/);
  const audio = fixture(upload('ent', 'Entrevista.audio.ogg'), AUDIO_SOURCE, silent);
  await assert.rejects(audio.run(), { code: 'no_speech' });
  assert.equal(audio.rows.get('ent').processingError, 'No se detectó voz en este archivo.');
});

test('the sidecar keeps the source name of re-encoded audio through a write and a read', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-extracted-names-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { sidecar } = await store.writeSidecar({ fileId: 'f1', userId: 'u1', result: { ...SPEECH, sourceName: 'Entre\u0000vista.mp3' } }, { root, now: new Date(NOW) });
  assert.equal(sidecar.sourceName, 'Entre vista.mp3');
  assert.equal(sidecar.sourceMedia, undefined);
  const back = store.normalizeSidecar(await store.readSidecar('f1', { root }));
  assert.equal(back.sourceName, 'Entre vista.mp3');
  assert.equal(back.sourceMedia, undefined);
});

test('the transcript files of re-encoded audio carry its own name', async () => {
  const artifacts = require('../src/services/media-transcript-artifacts');
  const row = { ...upload('ent', 'Entrevista.audio.ogg'), processingStage: 'ready', extractedText: '[00:00] Buenos días a todos.' };
  const built = await artifacts.buildMediaTranscriptArtifacts({ rows: [row],
    transcripts: new Map([['ent', { ...SPEECH, durationSec: 300, sourceName: 'Entrevista.mp3' }]]),
    output: artifacts.resolveTranscriptOutput('transcribe'), userId: 'u1' });
  assert.deepEqual(built.artifacts.map(a => a.filename), ['Entrevista (transcripción).txt'], 'a 5-minute audio gets its TXT only, under its own name');
});

test('translation and analysis read the recordings under their own names, with or without a range', () => {
  const rows = [
    { id: 'cls', originalName: 'Clase 3.audio.ogg', extractedText: '[00:00:00] Hola.' },
    { id: 'ent', originalName: 'Entrevista.audio.ogg', extractedText: '[00:00:00] Buenos días.' },
    { id: 'nota', originalName: 'nota.ogg', extractedText: '[00:00:00] Recordatorio.' },
  ];
  const said = (text) => ({ ...SPEECH, transcript: text, segments: [{ start: 0, end: 4, text }] });
  const transcripts = new Map([
    ['cls', { ...said('Hola.'), sourceMedia: 'video', sourceName: 'Clase 3.mp4' }],
    ['ent', { ...said('Buenos días.'), sourceName: 'Entrevista.mp3' }],
    ['nota', said('Recordatorio.')],
  ]);
  assert.deepEqual(handoff.mediaRowsForAnalysis(rows, transcripts, null).map(row => row.originalName), ['Clase 3.mp4', 'Entrevista.mp3', 'nota.ogg']);
  assert.equal(rows[0].originalName, 'Clase 3.audio.ogg', 'the stored rows are never mutated');
  // With a range the model reads only that window, from the stored transcript.
  const windowed = handoff.mediaRowsForAnalysis(rows, transcripts, { start: 0, end: 60 });
  assert.deepEqual(windowed.map(row => row.originalName), ['Clase 3.mp4', 'Entrevista.mp3', 'nota.ogg']);
  assert.match(windowed[0].extractedText, /Hola\./);
  assert.match(windowed[1].extractedText, /Buenos días\./);
});

test('the background delivery translates and analyses under the recordings\' own names', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'media-delivery.js'), 'utf8');
  const rowsIn = source.slice(source.indexOf('const rowsIn = (range) => {'), source.indexOf('const analysisRows = rowsIn('));
  assert.ok(rowsIn.length > 0, 'rowsIn exists');
  assert.doesNotMatch(rowsIn, /if \(!range\) return rows;/, 'without a range the rows are still renamed');
  assert.match(rowsIn, /mediaRowsForAnalysis\(rows, transcripts, range \|\| null\)/);
});

// ── the turn, the delivery and a refine by name (review of #1134) ───────

const extracted = (sourceName) => ({ tier: 'opus', sourceName, sourceSize: 900_000_000, sourceType: 'video/mp4', durationSeconds: 3600 });

test('a refine by name finds an extracted recording by what the user uploaded', async () => {
  const batch = require('../src/services/media-batch');
  const rows = [{ id: 'f3', originalName: 'Clase 3.audio.ogg' }, { id: 'f4', originalName: 'Clase 4.audio.ogg' }];
  // The upload's own name answers to «Clase 3» too.
  assert.equal(batch.pickRowByName(rows, 'revisa del minuto 12 al 15 de Clase 3, se escuchó mal')?.id, 'f3');
  const prisma = { documentAnalysis: { findMany: async ({ where }) => where.fileId.in.map(fileId => ({ fileId,
    metadata: { clientExtracted: extracted(fileId === 'f3' ? 'Clase 3.mp4' : 'Clase 4.mp4') } })) } };
  const names = await batch.loadPresentedNames(prisma, { userId: 'u1', rows });
  assert.deepEqual([...names.entries()], [['f3', 'Clase 3.mp4'], ['f4', 'Clase 4.mp4']]);
  const presented = batch.presentRows(rows, names);
  assert.equal(batch.pickRowByName(presented, 'revisa el minuto 12 de «Clase 4.mp4»')?.id, 'f4');
  // Unknown or unreadable: no names, never a throw.
  assert.equal((await batch.loadPresentedNames({ documentAnalysis: { findMany: async () => { throw new Error('db'); } } }, { userId: 'u1', rows })).size, 0);
  assert.equal((await batch.loadPresentedNames(null, { userId: 'u1', rows })).size, 0);
});

test('the live progress names what the user uploaded', async () => {
  const batch = require('../src/services/media-batch');
  const labels = [];
  await batch.waitForMediaBatch({ prisma: null, userId: 'u1', timeoutMs: 0, enqueue: async () => ({ queued: false }),
    rows: [{ id: 'f3', originalName: 'Clase 3.audio.ogg', processingStage: 'extracting' }],
    names: new Map([['f3', 'Clase 3.mp4']]),
    readProgress: async () => ({ f3: { stage: 'transcribing', percent: 40, completed: 2, total: 5 } }),
    onProgress: progress => labels.push(batch.describeBatchProgress(progress)) });
  assert.ok(labels.some(label => label.includes('«Clase 3.mp4»')), labels.join(' | '));
  assert.ok(labels.every(label => !label.includes('.audio.ogg')));
});

test('the inline preview is headed with what the user uploaded', () => {
  const artifacts = require('../src/services/media-transcript-artifacts');
  const rows = [{ id: 'f3', originalName: 'Clase 3.audio.ogg', processingStage: 'ready', extractedText: '[00:00:01] Buenos días.' },
    { id: 'f4', originalName: 'Clase 4.audio.ogg', processingStage: 'ready', extractedText: '[00:00:01] Hola.' }];
  const transcripts = new Map([['f3', { sourceName: 'Clase 3.mp4' }], ['f4', { sourceName: 'Clase 4.mp4' }]]);
  const preview = artifacts.buildTranscriptChatPreview({ rows, transcripts, output: {} });
  assert.match(preview, /Clase 3\.mp4/);
  assert.doesNotMatch(preview, /\.audio\.ogg/);
});
