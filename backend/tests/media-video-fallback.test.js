'use strict';

// Contract C5, video fallbacks: when the engine finds no audio track or no
// speech in a video (or in a file with a text subtitle track), the user gets
// the text the file carries — its subtitle track (language-matched), else the
// text read on screen — never «no se detectó voz» while there is text. When
// speech exists and a text subtitle track does too, the track is kept as a
// cross-check. Offline: media-probe / video-onscreen-text / engine are fakes.

const test = require('node:test');
const assert = require('node:assert/strict');

const q = require('../src/services/media-transcription-queue');
const store = require('../src/services/media-transcript-store');
const fmt = require('../src/services/media-transcript-format');

const NOW = Date.parse('2026-10-16T12:00:00Z');
const row = (id, extra = {}) => ({ id, userId: 'u1', originalName: `${id}.mp4`, mimeType: 'video/mp4', size: 5_000_000,
  path: `/uploads/u1/${id}.mp4`, deletedAt: null, extractedText: null, processingError: null,
  processingStage: 'uploaded', processingStageAt: new Date(NOW - 300000), ...extra });

const probeOf = ({ audio = [], subtitles = [], video = [{ index: 0, codec: 'h264', attachedPic: false }], durationSec = 600 } = {}) => ({
  ok: true, durationSec, formatName: 'mov,mp4', audio, subtitles, video,
  hasAudio: audio.length > 0, hasVideo: video.some(v => !v.attachedPic), hasTextSubtitles: subtitles.some(s => s.textBased),
});
const SPA = { index: 2, streamOrdinal: 0, codec: 'subrip', language: 'es', isDefault: true, isForced: false, textBased: true };
const ENG = { index: 3, streamOrdinal: 1, codec: 'mov_text', language: 'en', isDefault: false, isForced: false, textBased: true };
const AUDIO = { index: 1, streamOrdinal: 0, codec: 'aac', channels: 2, language: 'es', isDefault: true };

function fixture(initial, { probe = probeOf(), subtitles = {}, onscreen = null, processFile = null, ...overrides } = {}) {
  const rows = new Map(initial.map(file => [file.id, { ...file }]));
  const jobs = new Map();
  const calls = { engine: [], subtitles: [], onscreen: [], sidecars: [], terminal: [], probes: 0 };
  const matches = (file, where) => file && file.id === where.id && file.userId === where.userId && file.deletedAt == null;
  const prisma = { file: {
    async findFirst({ where }) { const file = rows.get(where.id); return matches(file, where) ? { ...file } : null; },
    async updateMany({ where, data }) {
      const file = rows.get(where.id);
      if (!matches(file, where)) return { count: 0 };
      Object.assign(file, data);
      return { count: 1 };
    },
  } };
  const queue = {
    async getJob(id) { return jobs.get(id); },
    async add(name, data, opts) {
      const job = { id: opts.jobId, name, data, opts, state: 'waiting', attemptsMade: 0,
        async getState() { return this.state; }, async remove() { jobs.delete(this.id); }, discard() { this.discarded = true; } };
      jobs.set(opts.jobId, job);
      return job;
    },
  };
  const sidecars = new Map();
  const service = q.createMediaTranscriptionService({ prisma, getQueue: () => queue, now: () => NOW,
    validate: async (_l, file) => file.mimeType, offload: async file => file.path,
    materialize: async source => ({ path: source, cleanup: async () => {} }),
    createCheckpoint: file => ({ dir: `/ckpt/${file.id}`, clear: async () => {} }),
    formatter: fmt,
    processFile: processFile || (async (file, opts) => { calls.engine.push(opts); return { success: false, code: 'no_speech', error: 'No se detectó voz en el archivo.' }; }),
    mediaTools: {
      probe: async () => { calls.probes++; return probe; },
      extractSubtitles: async (file, ordinal, opts) => { calls.subtitles.push({ ordinal, opts }); return subtitles[ordinal] || { ok: false, error: 'subtitle_extract_failed', segments: [] }; },
      extractOnScreenText: async (file, opts) => { calls.onscreen.push(opts); return onscreen || { ok: true, items: [], framesRead: 0, framesSkipped: 0, partial: false }; },
    },
    transcriptStore: {
      async writeSidecar({ fileId, result }) { calls.sidecars.push(result); sidecars.set(fileId, store.normalizeSidecar(store.buildSidecar({ fileId, userId: 'u1', result }))); return { path: `/x/${fileId}.json.gz` }; },
      async upsertMediaTranscriptAnalysis() {},
    },
    onTerminal: payload => calls.terminal.push(payload), logger: { warn() {}, info() {} },
    ...overrides,
  });
  const run = async (id) => {
    await service.enqueueMediaTranscription({ fileId: id, userId: 'u1' });
    return service.processMediaJob([...jobs.values()].find(job => job.data.fileId === id));
  };
  return { service, rows, jobs, calls, sidecars, run };
}

const CUES = [{ start: 1, end: 4, text: 'Bienvenidos al curso.' }, { start: 5, end: 9, text: 'Hoy: la célula.' }];

test('a video without an audio track uses its text subtitle track: the engine is never run, the user gets text', async () => {
  const f = fixture([row('mudo')], { probe: probeOf({ subtitles: [SPA] }), subtitles: { 0: { ok: true, codec: 'subrip', segments: CUES } } });
  await f.run('mudo');
  assert.equal(f.calls.engine.length, 0, 'no decode of an audio stream that does not exist');
  const file = f.rows.get('mudo');
  assert.equal(file.processingStage, 'ready');
  assert.equal(file.processingError, null);
  // A 10-minute video keeps its timestamps; the note says where the text comes from.
  assert.equal(file.extractedText, '(El video no tiene audio; usé los subtítulos incrustados del video (español).)\n\n[00:01] Bienvenidos al curso. Hoy: la célula.\n');
  const saved = f.sidecars.get('mudo');
  assert.equal(saved.source, 'subtitles');
  assert.equal(saved.language, 'es');
  assert.equal(saved.coverage, null, 'subtitles never claim «cobertura del audio»');
  assert.deepEqual(saved.segments.map(s => s.text), ['Bienvenidos al curso.', 'Hoy: la célula.']);
  assert.equal(saved.quality.level, 'alta');
  assert.deepEqual(saved.quality.enginesUsed, ['subtitles']);
  assert.deepEqual(f.calls.terminal, [{ fileId: 'mudo', userId: 'u1', stage: 'ready' }]);
});

test('no speech and two subtitle tracks: the one in the requested language wins', async () => {
  const f = fixture([row('clip')], {
    probe: probeOf({ audio: [AUDIO], subtitles: [SPA, ENG] }),
    subtitles: { 1: { ok: true, codec: 'mov_text', segments: [{ start: 0, end: 3, text: 'Welcome.' }] }, 0: { ok: true, segments: CUES } },
  });
  await f.service.enqueueMediaTranscription({ fileId: 'clip', userId: 'u1', language: 'inglés' });
  await f.service.processMediaJob([...f.jobs.values()][0]);
  assert.equal(f.calls.engine.length, 1, 'the voice is tried first');
  assert.equal(f.calls.engine[0].language, 'en');
  assert.deepEqual(f.calls.subtitles.map(c => c.ordinal), [1]);
  const saved = f.sidecars.get('clip');
  assert.equal(saved.language, 'en');
  assert.match(saved.quality.notes[0], /^No se detectó voz en el audio; usé los subtítulos incrustados del video \(inglés\)\.$/);
});

test('pickSubtitleTrack: language, then not forced, default, not SDH; bitmap tracks never', () => {
  const forced = { ...SPA, streamOrdinal: 2, isForced: true, isDefault: true };
  const bitmap = { streamOrdinal: 3, codec: 'hdmv_pgs_subtitle', language: 'en', textBased: false };
  assert.equal(q.pickSubtitleTrack({ subtitles: [forced, SPA] }).streamOrdinal, 0);
  assert.equal(q.pickSubtitleTrack({ subtitles: [SPA, ENG, bitmap] }, 'en').streamOrdinal, 1);
  assert.equal(q.pickSubtitleTrack({ subtitles: [bitmap] }), null);
  assert.equal(q.pickSubtitleTrack(null), null);
});

test('no subtitles: the text read on screen becomes the transcript, with times and honest notes', async () => {
  const items = [
    { start: 0, end: 40, text: 'Tema 3: La mitocondria', confidence: 0.92 },
    { start: 40, end: 95, text: 'Produce ATP mediante la respiración celular', confidence: 0.88 },
    { start: 95, end: 130, text: '[ilegible]', confidence: 0.2 },
    { start: 130, end: 150, text: '¡Gracias!', confidence: 0.9 },
  ];
  const f = fixture([row('slides')], { probe: probeOf({ durationSec: 150 }),
    onscreen: { ok: true, items, framesRead: 5, framesSkipped: 1, partial: true, escalated: 1, reason: 'budget_exhausted' } });
  await f.run('slides');
  assert.equal(f.calls.onscreen.length, 1);
  assert.equal(f.calls.onscreen[0].checkpointDir, '/ckpt/slides', 'frames are checkpointed with the job');
  assert.equal(f.calls.onscreen[0].durationSec, 150);
  const file = f.rows.get('slides');
  assert.equal(file.processingStage, 'ready');
  assert.match(file.extractedText, /^\(El video no tiene audio; transcribí el texto que aparece en pantalla\.\)\n\n/);
  assert.match(file.extractedText, /\[00:40\] Produce ATP/);
  assert.match(file.extractedText, /\[02:10\] ¡Gracias!/, 'an authored closing slide is not an «invented sign-off»');
  const saved = f.sidecars.get('slides');
  assert.equal(saved.source, 'onscreen');
  assert.deepEqual(saved.quality.enginesUsed, ['ocr', 'vision']);
  assert.ok(saved.quality.notes.some(n => /incompleta/.test(n)));
  assert.deepEqual(saved.quality.lowConfidence, [{ start: 95, end: 130, reason: 'illegible' }]);

  // The delivered TXT says where the text comes from and how good it is.
  const pack = fmt.buildTranscriptPack(saved, { fileName: 'slides.mp4', formats: ['txt', 'md'], now: NOW });
  assert.match(pack.txt, /\nFuente: texto que aparece en pantalla\n/);
  assert.doesNotMatch(pack.txt, /\nMotor:|Cobertura/);
  assert.match(pack.txt, /\nCalidad: media\n/);
  assert.match(pack.txt, /\nTramos dudosos: 01:35–02:10 \(texto ilegible\)\n/);
  assert.match(pack.txt, /Nota: El video no tiene audio; transcribí el texto que aparece en pantalla\./);
  assert.match(pack.txt, /\[00:00\] Tema 3: La mitocondria\n\n\[00:40\] Produce ATP/, 'one paragraph per screen');
  assert.match(pack.md, /\| Fuente \| texto que aparece en pantalla \|/);
});

test('a video with neither speech nor legible text fails honestly (no «damaged file», no retry storm)', async () => {
  const f = fixture([row('negro')], { probe: probeOf({ audio: [AUDIO] }),
    onscreen: { ok: true, items: [{ start: 0, end: 10, text: '[ilegible]', confidence: 0.1 }], framesRead: 2, framesSkipped: 0, partial: false } });
  await assert.rejects(f.run('negro'), { code: 'no_speech' });
  const file = f.rows.get('negro');
  assert.equal(file.processingStage, 'failed');
  assert.equal(file.processingError, 'No se detectó voz ni texto legible en pantalla en este video.');
  assert.equal([...f.jobs.values()][0].discarded, true);
  assert.deepEqual(f.calls.terminal, [{ fileId: 'negro', userId: 'u1', stage: 'failed' }]);
});

// The on-screen pass reads nothing when OCR or ffmpeg is down: that is no
// verdict about the video, so the job is retried and the message never says
// the screen was read.
test('a silent video whose screen could not be read (OCR unavailable) is retried, never «no tiene texto en pantalla»', async () => {
  const outcomes = [
    ['ocr', { ok: false, reason: 'ocr_unavailable', items: [], framesRead: 0, framesSkipped: 0, partial: true }],
    ['ffmpeg', { ok: false, reason: 'ffmpeg_unavailable', items: [], framesRead: 0, framesSkipped: 0, partial: false }],
    ['frames', { ok: false, reason: 'no_frames', items: [], framesRead: 0, framesSkipped: 3, partial: false }],
    ['interno', { ok: false, reason: 'internal_error', items: [], framesRead: 0, framesSkipped: 0, partial: false }],
    ['abandono', { ok: true, reason: 'ocr_unavailable', items: [], framesRead: 2, framesSkipped: 0, partial: true }],
  ];
  for (const [id, onscreen] of outcomes) {
    const f = fixture([row(id)], { probe: probeOf({ video: [{ index: 0, codec: 'h264', attachedPic: false }] }), onscreen,
      processFile: async () => ({ success: false, code: 'no_speech', error: 'x' }) });
    await f.service.enqueueMediaTranscription({ fileId: id, userId: 'u1' });
    const job = [...f.jobs.values()][0];
    const err = await f.service.processMediaJob(job).then(() => null, e => e);
    assert.equal(err?.code, 'no_audio_track', id);
    assert.equal(err.videoChecked, false, id);
    assert.equal(err.textUnread, 'screen', id);
    assert.equal(err.retryable, true, id);
    assert.equal(err.message, 'No se pudo leer el texto en pantalla de este video; se reintentará.', id);
    assert.equal(q.isTransientMediaError(err), true, id);
    assert.notEqual(job.discarded, true, `${id}: not discarded`);
    assert.equal(f.rows.get(id).processingStage, 'uploaded', `${id}: queued again, no verdict shown`);
    assert.equal(f.rows.get(id).processingError, null, id);
    assert.deepEqual(f.calls.terminal, [], id);
  }
});

test('the last attempt of an unread video fails honestly: the voice verdict stands, the screen was not read', async () => {
  const f = fixture([row('mudo')], { probe: probeOf({ audio: [AUDIO] }),
    onscreen: { ok: false, reason: 'ocr_unavailable', items: [], framesRead: 0, framesSkipped: 0, partial: true } });
  await f.service.enqueueMediaTranscription({ fileId: 'mudo', userId: 'u1' });
  const job = [...f.jobs.values()][0];
  job.attemptsMade = q.ATTEMPTS - 1;
  await assert.rejects(f.service.processMediaJob(job), { code: 'no_speech' });
  const message = f.rows.get('mudo').processingError;
  assert.equal(f.rows.get('mudo').processingStage, 'failed');
  assert.equal(message, 'No se detectó voz en este video y no se pudo leer su texto en pantalla. Puedes reintentar este archivo.');
  assert.doesNotMatch(message, /ni texto legible/);
  assert.deepEqual(f.calls.terminal, [{ fileId: 'mudo', userId: 'u1', stage: 'failed' }]);
});

test('a thrown screen reading is no verdict either; a reading with no picture at all is one', async () => {
  const thrown = fixture([row('roto')], { probe: probeOf({ audio: [AUDIO] }) });
  const service = q.createMediaTranscriptionService({ prisma: { file: {
    async findFirst({ where }) { const file = thrown.rows.get(where.id); return file && file.userId === where.userId ? { ...file } : null; },
    async updateMany({ where, data }) { const file = thrown.rows.get(where.id); if (!file) return { count: 0 }; Object.assign(file, data); return { count: 1 }; },
  } }, getQueue: () => ({ async getJob(id) { return thrown.jobs.get(id); }, async add(name, data, opts) { const job = { id: opts.jobId, data, opts, attemptsMade: 0, async getState() { return 'waiting'; }, discard() { this.discarded = true; } }; thrown.jobs.set(opts.jobId, job); return job; } }),
  now: () => NOW, validate: async (_l, file) => file.mimeType, materialize: async source => ({ path: source, cleanup: async () => {} }),
  createCheckpoint: file => ({ dir: `/ckpt/${file.id}`, clear: async () => {} }),
  processFile: async () => ({ success: false, code: 'no_speech' }),
  mediaTools: { probe: async () => probeOf({ audio: [AUDIO] }), extractOnScreenText: async () => { throw new Error('tesseract init: out of memory'); } },
  logger: { warn() {}, info() {} } });
  await service.enqueueMediaTranscription({ fileId: 'roto', userId: 'u1' });
  const err = await service.processMediaJob([...thrown.jobs.values()][0]).then(() => null, e => e);
  assert.equal(err?.code, 'no_speech');
  assert.equal(err.textUnread, 'screen');
  assert.equal(q.isTransientMediaError(err), true);
  assert.equal(thrown.rows.get('roto').processingStage, 'uploaded');

  // The stream list had a picture but the reader found none: that is an answer.
  const blind = fixture([row('ciego')], { probe: probeOf({ audio: [AUDIO] }),
    onscreen: { ok: false, reason: 'no_video_stream', items: [], framesRead: 0, framesSkipped: 0, partial: false } });
  await assert.rejects(blind.run('ciego'), { code: 'no_speech' });
  assert.equal(blind.rows.get('ciego').processingError, 'No se detectó voz ni texto legible en pantalla en este video.');
  assert.equal([...blind.jobs.values()][0].discarded, true);
});

test('a text subtitle track that could not be read keeps the job retryable; a bitmap track is an answer', async () => {
  // ffmpeg timed out reading the track and the screen shows nothing legible.
  const f = fixture([row('subs')], { probe: probeOf({ audio: [AUDIO], subtitles: [SPA] }),
    subtitles: { 0: { ok: false, error: 'timeout', segments: [] } },
    onscreen: { ok: true, items: [], framesRead: 4, framesSkipped: 0, partial: false } });
  await f.service.enqueueMediaTranscription({ fileId: 'subs', userId: 'u1' });
  const job = [...f.jobs.values()][0];
  const err = await f.service.processMediaJob(job).then(() => null, e => e);
  assert.equal(err?.code, 'no_speech');
  assert.equal(err.textUnread, 'subtitles');
  assert.equal(err.videoChecked, false);
  assert.equal(q.isTransientMediaError(err), true);
  assert.notEqual(job.discarded, true);
  job.attemptsMade = q.ATTEMPTS - 1;
  await assert.rejects(f.service.processMediaJob(job), { code: 'no_speech' });
  assert.equal(f.rows.get('subs').processingError, 'No se detectó voz en este video y no se pudieron leer sus subtítulos. Puedes reintentar este archivo.');

  // Both unread: the message names both.
  const both = fixture([row('nada')], { probe: probeOf({ subtitles: [SPA] }),
    subtitles: { 0: { ok: false, error: 'ffmpeg_missing', segments: [] } },
    onscreen: { ok: false, reason: 'ffmpeg_unavailable', items: [], framesRead: 0, framesSkipped: 0, partial: false } });
  await both.service.enqueueMediaTranscription({ fileId: 'nada', userId: 'u1' });
  const bothJob = [...both.jobs.values()][0];
  bothJob.attemptsMade = q.ATTEMPTS - 1;
  await assert.rejects(both.service.processMediaJob(bothJob), { code: 'no_audio_track' });
  assert.equal(both.rows.get('nada').processingError,
    'Este video no tiene pista de audio y no se pudieron leer sus subtítulos ni su texto en pantalla. Puedes reintentar este archivo.');

  // A track ffmpeg says is not text (or not there) is a verdict about the track.
  const bitmap = fixture([row('pgs')], { probe: probeOf({ audio: [AUDIO], subtitles: [SPA] }),
    subtitles: { 0: { ok: false, error: 'bitmap_subtitles', segments: [] } },
    onscreen: { ok: true, items: [], framesRead: 4, framesSkipped: 0, partial: false } });
  await assert.rejects(bitmap.run('pgs'), { code: 'no_speech' });
  assert.equal(bitmap.rows.get('pgs').processingError, 'No se detectó voz ni texto legible en pantalla en este video.');
  assert.equal([...bitmap.jobs.values()][0].discarded, true);
});

test('isTransientMediaError: only the unread-text marker makes a voice verdict retryable', () => {
  assert.equal(q.isTransientMediaError({ code: 'no_speech', retryable: true }), false, 'an engine flag alone never does');
  assert.equal(q.isTransientMediaError({ code: 'no_speech', textUnread: 'screen', retryable: true }), true);
  assert.equal(q.isTransientMediaError({ code: 'no_audio_track', textUnread: 'subtitles', retryable: true }), true);
  assert.equal(q.isTransientMediaError({ code: 'drm_protected', textUnread: 'screen', retryable: true }), false);
});

test('a decode failure on a video the probe saw without audio is «no audio track», not damage, and is not retried', async () => {
  // The probe listed no stream at all (only data): the engine still runs and fails its decode.
  const f = fixture([row('pantalla')], { probe: probeOf({ video: [] }),
    processFile: async () => ({ success: false, code: 'audio_decode_failed', error: 'x' }) });
  await assert.rejects(f.run('pantalla'), { code: 'no_audio_track' });
  assert.equal(f.rows.get('pantalla').processingError, 'Este video no tiene pista de audio ni texto legible en pantalla para transcribir.');
  assert.equal(q.isTransientMediaError({ code: 'no_audio_track' }), false);
  assert.equal(q.isTransientMediaError({ code: 'media_busy' }), true);
});

test('the engine\'s own no_audio_track code (contract C4) triggers the same fallbacks', async () => {
  const f = fixture([row('mudo')], { probe: { ok: false, error: 'probe_failed', audio: [], subtitles: [], video: [] },
    processFile: async () => ({ success: false, code: 'no_audio_track', error: 'x' }),
    onscreen: { ok: true, items: [{ start: 3, end: 20, text: 'Paso 1: abrir la terminal', confidence: 0.9 }], framesRead: 1, framesSkipped: 0, partial: false } });
  await f.run('mudo');
  assert.equal(f.rows.get('mudo').processingStage, 'ready');
  assert.equal(f.sidecars.get('mudo').source, 'onscreen');
  assert.equal(f.calls.subtitles.length, 0, 'no stream list, no subtitle extraction');
});

test('an audio file without speech keeps today\'s behaviour: no video tools, the plain message', async () => {
  const f = fixture([row('nota', { originalName: 'nota.opus', mimeType: 'audio/ogg', path: '/u/nota.opus' })]);
  await assert.rejects(f.run('nota'), { code: 'no_speech' });
  assert.equal(f.calls.probes, 0, 'an opus voice note is never probed for streams');
  assert.equal(f.calls.onscreen.length, 0);
  assert.equal(f.rows.get('nota').processingError, 'No se detectó voz en este archivo.');
});

test('speech plus a text subtitle track: the transcript is the voice, the track is kept as a cross-check', async () => {
  const transcription = { ok: true, durationSec: 600, language: 'es', providers: { local: 1 }, engine: 'local', partial: false, gaps: [], coverage: 1,
    transcript: 'Bienvenidos al curso.', segments: [{ start: 1, end: 4, text: 'Bienvenidos al curso.' }] };
  const f = fixture([row('clase')], { probe: probeOf({ audio: [AUDIO], subtitles: [SPA] }),
    subtitles: { 0: { ok: true, codec: 'subrip', segments: CUES } },
    processFile: async () => ({ success: true, extractedText: 'x', transcription }) });
  await f.run('clase');
  const saved = f.sidecars.get('clase');
  assert.equal(saved.source, 'asr');
  assert.deepEqual(saved.segments.map(s => s.text), ['Bienvenidos al curso.']);
  assert.deepEqual(saved.embeddedSubtitles, { language: 'es', codec: 'subrip', segments: [
    { start: 1, end: 4, text: 'Bienvenidos al curso.' }, { start: 5, end: 9, text: 'Hoy: la célula.' }] });
  assert.equal(f.calls.subtitles[0].opts.timeoutMs, 60_000, 'the cross-check is bounded');
});

test('a link clip\'s on-screen text moves to the recording clock with the rest', async () => {
  const f = fixture([row('tramo')], { probe: probeOf({ durationSec: 60 }),
    onscreen: { ok: true, items: [{ start: 10, end: 20, text: 'Diapositiva final', confidence: 0.9 }], framesRead: 1, framesSkipped: 0, partial: false } });
  await f.service.enqueueMediaTranscription({ fileId: 'tramo', userId: 'u1', timeOffsetSec: 3600 });
  await f.service.processMediaJob([...f.jobs.values()][0]);
  const saved = f.sidecars.get('tramo');
  assert.equal(saved.timeOffsetSec, 3600);
  assert.deepEqual(saved.segments.map(s => [s.start, s.end]), [[3610, 3620]]);
});

test('a deploy during the screen reading parks the job (it resumes from the frame checkpoints)', async () => {
  let release;
  const f = fixture([row('largo')], { probe: probeOf() });
  const service = q.createMediaTranscriptionService({ prisma: { file: {
    async findFirst({ where }) { const file = f.rows.get(where.id); return file && file.userId === where.userId && !file.deletedAt ? { ...file } : null; },
    async updateMany({ where, data }) { const file = f.rows.get(where.id); if (!file || file.userId !== where.userId) return { count: 0 }; Object.assign(file, data); return { count: 1 }; },
  } }, getQueue: () => ({ async getJob(id) { return f.jobs.get(id); }, async add(name, data, opts) { const job = { id: opts.jobId, data, opts, attemptsMade: 0, async getState() { return 'waiting'; } }; f.jobs.set(opts.jobId, job); return job; } }),
  now: () => NOW, validate: async (_l, file) => file.mimeType, materialize: async source => ({ path: source, cleanup: async () => {} }),
  createCheckpoint: file => ({ dir: `/ckpt/${file.id}`, clear: async () => {} }),
  processFile: async () => ({ success: false, code: 'no_speech' }),
  mediaTools: { probe: async () => probeOf(), extractOnScreenText: (_file, { signal }) => new Promise(resolve => {
    release = resolve;
    signal.addEventListener('abort', () => resolve({ ok: false, reason: 'aborted', items: [], partial: true }), { once: true });
  }) }, logger: { warn() {}, info() {} } });
  await service.enqueueMediaTranscription({ fileId: 'largo', userId: 'u1' });
  const job = [...f.jobs.values()][0];
  const delayed = [];
  job.moveToDelayed = async ts => { delayed.push(ts); };
  const running = service.processMediaJob(job, 'tok');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(service.abortActive(), 1);
  await assert.rejects(running, err => err.name === 'DelayedError');
  assert.equal(delayed.length, 1);
  assert.equal(f.rows.get('largo').processingStage, 'uploaded');
  assert.ok(release);
});

test('without the media tools (older wiring) a silent video fails exactly as before', async () => {
  const f = fixture([row('mudo')], { mediaTools: null });
  await assert.rejects(f.run('mudo'), { code: 'no_speech' });
  assert.equal(f.rows.get('mudo').processingError, 'No se detectó voz en este archivo.');
});

test('a link clip with no voice falls back to its stored platform captions, on the file clock, labelled as platform captions', async () => {
  const audioOnly = row('link', { originalName: 'clase-min-60-90.m4a', mimeType: 'audio/mp4' });
  const read = [];
  const f = fixture([audioOnly], {
    probe: probeOf({ audio: [AUDIO], video: [], durationSec: 1800 }),
    readLinkCaptions: async (_db, ref) => {
      read.push(ref);
      return { source: 'platform_captions', clock: 'recording', language: 'es', kind: 'auto', coverage: 0.95,
        segments: [{ start: 3590, end: 3600, text: 'antes del tramo' }, { start: 3601, end: 3604, text: 'Bienvenidos.' }, { start: 3605, end: 3610, text: 'Hoy: la célula.' }] };
    },
  });
  // The clip starts at 01:00:00 on the recording's clock.
  await f.service.enqueueMediaTranscription({ fileId: 'link', userId: 'u1', timeOffsetSec: 3600 });
  await f.service.processMediaJob([...f.jobs.values()].find(job => job.data.fileId === 'link'));
  assert.deepEqual(read, [{ fileId: 'link', userId: 'u1' }]);
  const file = f.rows.get('link');
  assert.equal(file.processingStage, 'ready');
  const saved = f.sidecars.get('link');
  assert.equal(saved.source, 'subtitles');
  assert.equal(saved.subtitleOrigin, 'platform');
  assert.deepEqual(saved.segments.map(s => s.text), ['Bienvenidos.', 'Hoy: la célula.'], 'cues before the clip are dropped');
  assert.equal(saved.segments[0].start, 3601, 'the stored transcript is back on the recording clock');
  assert.equal(saved.quality.level, 'media', 'automatic captions are never «alta»');
  assert.match(saved.quality.notes[0], /subtítulos automáticos de la plataforma/);
  assert.equal(fmt.sourceNoteEs(fmt.normalizeTranscriptResult(saved)), 'Usé los subtítulos de la plataforma del video (español).');
});

test('a transient engine failure never uses the captions: the job retries', async () => {
  let read = 0;
  const f = fixture([row('busy', { mimeType: 'audio/mp4', originalName: 'a.m4a' })], {
    probe: probeOf({ audio: [AUDIO], video: [] }),
    processFile: async () => ({ success: false, code: 'local_unavailable', error: 'motor ocupado' }),
    readLinkCaptions: async () => { read++; return { language: 'es', kind: 'manual', segments: [{ start: 0, end: 2, text: 'hola' }] }; },
  });
  await assert.rejects(f.run('busy'));
  assert.equal(read, 0);
});
