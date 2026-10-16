'use strict';

// Contract C6: the honest report travels with every delivered transcript —
// the quality level, the doubtful stretches, where the text came from (voice,
// embedded subtitles, the text on screen), the «Texto en pantalla» section,
// a kept subtitle track — and a refine («revisa el minuto 12») is posted as
// «Corregí el tramo …» with the updated files, only once its job reported.
// Every fixture goes through the real store/formatter shapes; no network, no
// real uploads dir.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const artifacts = require('../src/services/media-transcript-artifacts');
const transcriptStore = require('../src/services/media-transcript-store');
const delivery = require('../src/services/media-delivery');
const handoff = require('../src/services/media-handoff');
const { createMediaDeliveryStore, normalizeNewRecord, normalizeRefineOutcome } = require('../src/services/media-delivery-store');

const { createMediaDeliveryService, deliveryMessage, refineMessage, refineHandOffMessage, notificationCopy } = delivery;

const T0 = Date.parse('2026-10-16T10:00:00Z');
const MIN = 60 * 1000;
const ENABLED = { SIRAGPT_MEDIA_DELIVERY: '1' };

const decode = (artifact) => Buffer.from(artifact.base64, 'base64').toString('utf8');

/** What loadMediaTranscript returns for an engine result: the real sidecar round trip. */
function stored(result, fileId = 'clase') {
  const sidecar = transcriptStore.buildSidecar({ fileId, userId: 'u1', result }, { now: new Date(T0) });
  return transcriptStore.normalizeSidecar(JSON.parse(JSON.stringify(sidecar)), { fileName: `${fileId}.mp4` });
}

function lectureSegments({ minutes = 40, from = 0 } = {}) {
  const segments = [];
  for (let t = 0; t < minutes * 60; t += 30) segments.push({ start: from + t, end: from + t + 25, text: `Minuto ${Math.floor(t / 60)}: explicamos el tema ${t}.` });
  return segments;
}

function asrResult(extra = {}) {
  return { ok: true, language: 'es', durationSec: 40 * 60, coverage: 0.996, gaps: [], partial: false,
    providers: { local: 4 }, engine: 'local', segments: lectureSegments(),
    quality: { score: 0.91, level: 'alta', lowConfidence: [{ start: 750, end: 790, reason: 'noise' }], escalations: 1,
      enginesUsed: ['local'], notes: [] },
    ...extra };
}

const row = (id, extra = {}) => ({ id, userId: 'u1', originalName: `${id}.mp4`, filename: `${id}.mp4`, mimeType: 'video/mp4',
  processingStage: 'ready', processingError: null, extractedText: 'Texto guardado de la transcripción.', deletedAt: null, ...extra });

const fakeDocument = (calls) => async (userId, filename, markdown) => {
  calls.push({ userId, filename, markdown });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdq-doc-'));
  const file = path.join(dir, 'doc.bin');
  await fs.writeFile(file, markdown);
  return { filePath: file };
};

// ── headers of the files (TXT / Word / PDF) ────────────────────────────

test('TXT and Word headers carry the quality level, the doubtful stretches and the engine', async () => {
  const docs = [];
  const built = await artifacts.buildMediaTranscriptArtifacts({ rows: [row('clase')], transcripts: new Map([['clase', stored(asrResult())]]),
    output: { documentFormat: 'docx' }, userId: 'u1', createDocument: fakeDocument(docs) });
  const txt = decode(built.artifacts.find((a) => a.format === 'txt'));
  assert.match(txt, /^Calidad: alta$/m);
  assert.match(txt, /^Tramos dudosos: 12:30–13:10 \(ruido\)$/m);
  assert.match(txt, /^Motor: /m);
  assert.match(txt, /^Cobertura: 99(,6|\.6)? ?% del audio$|^Cobertura: .*% del audio$/m);
  assert.match(docs[0].markdown, /\| Calidad \| alta \|/);
  assert.match(docs[0].markdown, /\| Tramos dudosos \| 12:30–13:10 \(ruido\) \|/);
});

test('a PDF request renders the same header (Word and PDF share the Markdown)', async () => {
  const docs = [];
  const built = await artifacts.buildMediaTranscriptArtifacts({ rows: [row('clase')], transcripts: new Map([['clase', stored(asrResult())]]),
    output: { documentFormat: 'pdf' }, userId: 'u1', createDocument: fakeDocument(docs) });
  assert.ok(built.artifacts.some((a) => a.format === 'pdf'));
  assert.match(docs[0].filename, /\.pdf$/);
  assert.match(docs[0].markdown, /\| Calidad \| alta \|/);
});

test('a video without audio delivered from its on-screen text says so, with no invented audio coverage', async () => {
  const onscreen = { ok: true, source: 'onscreen', method: 'onscreen', language: 'es', durationSec: 600, coverage: null, gaps: [],
    providers: {}, engine: null,
    segments: [{ start: 0, end: 40, text: 'Bienvenidos al curso' }, { start: 40, end: 120, text: 'Tema 1: la célula' }],
    quality: { score: 0.9, level: 'alta', lowConfidence: [], escalations: 0, enginesUsed: ['ocr'],
      notes: ['El video no tiene audio; transcribí el texto que aparece en pantalla.'] } };
  const transcript = stored(onscreen);
  assert.equal(transcript.source, 'onscreen');
  const built = await artifacts.buildMediaTranscriptArtifacts({ rows: [row('clase')], transcripts: new Map([['clase', transcript]]),
    output: {}, userId: 'u1' });
  const txt = decode(built.artifacts[0]);
  assert.match(txt, /^Fuente: texto que aparece en pantalla$/m);
  assert.match(txt, /Nota: El video no tiene audio; transcribí el texto que aparece en pantalla\./);
  assert.doesNotMatch(txt, /Cobertura/, 'no audio was read: no «cobertura del audio», never 0 %');
  assert.doesNotMatch(txt, /TEXTO EN PANTALLA/, 'the body IS the screen text: no second section');

  const content = deliveryMessage({ delivery: { fileIds: ['clase'], fileNames: ['clase.mp4'] }, rows: [row('clase')],
    transcripts: { clase: transcript } });
  assert.match(content, /Fuente: texto que aparece en pantalla · calidad alta/);
  assert.match(content, /El video no tiene audio; transcribí el texto que aparece en pantalla\./);
  assert.doesNotMatch(content, /cobertura/);
});

test('embedded subtitles used as the transcript: «Usé los subtítulos incrustados del video (español)»', async () => {
  const subs = { ok: true, source: 'subtitles', method: 'subtitles', language: 'es', durationSec: 300, coverage: null, gaps: [],
    providers: {}, engine: null, segments: [{ start: 1, end: 4, text: 'Hola a todos.' }, { start: 5, end: 9, text: 'Empezamos.' }] };
  const transcript = stored(subs);
  const built = await artifacts.buildMediaTranscriptArtifacts({ rows: [row('peli')], transcripts: new Map([['peli', transcript]]), output: {}, userId: 'u1' });
  const txt = decode(built.artifacts[0]);
  assert.match(txt, /^Fuente: subtítulos incrustados del video \(español\)$/m);
  assert.match(txt, /Nota: Usé los subtítulos incrustados del video \(español\)\./);
  const report = artifacts.transcriptQualityReport(artifacts.transcriptResultFor(row('peli'), transcript));
  assert.equal(report.line, 'Fuente: subtítulos incrustados del video (español)');
  assert.deepEqual(report.notes, ['Usé los subtítulos incrustados del video (español).']);
  assert.equal(report.sourceShort, 'desde los subtítulos del video');
});

test('voice + text on screen: a «Texto en pantalla» section in TXT and Word, announced in the header', async () => {
  const docs = [];
  const result = asrResult({ onScreenText: [{ start: 60, end: 90, text: 'Diapositiva 1: Mitocondria' }, { start: 300, end: 420, text: 'Diapositiva 2: ATP' }] });
  const built = await artifacts.buildMediaTranscriptArtifacts({ rows: [row('clase')], transcripts: new Map([['clase', stored(result)]]),
    output: { documentFormat: 'docx' }, userId: 'u1', createDocument: fakeDocument(docs) });
  const txt = decode(built.artifacts.find((a) => a.format === 'txt'));
  assert.match(txt, /TEXTO EN PANTALLA/);
  assert.match(txt, /\[01:00\] Diapositiva 1: Mitocondria/);
  assert.match(txt, /Nota: Al final está el texto que aparece en pantalla \(2 fragmentos\)\./);
  assert.match(docs[0].markdown, /^## Texto en pantalla$/m);
  assert.match(docs[0].markdown, /Diapositiva 2: ATP/);
});

test('voice + an embedded subtitle track: the note says the transcript is the audio; asked subtitles also get the track as SRT', async () => {
  const result = asrResult({ embeddedSubtitles: { language: 'en', codec: 'subrip',
    segments: [{ start: 2, end: 5, text: 'Good morning, everyone.' }, { start: 6, end: 9, text: 'Today: mitochondria.' }] } });
  const transcript = stored(result);
  assert.ok(transcript.embeddedSubtitles, 'the store keeps the track');
  const plain = await artifacts.buildMediaTranscriptArtifacts({ rows: [row('clase')], transcripts: new Map([['clase', transcript]]), output: {}, userId: 'u1', createDocument: fakeDocument([]) });
  const txt = decode(plain.artifacts.find((a) => a.format === 'txt'));
  assert.match(txt, /Nota: El video también trae subtítulos incrustados \(inglés\); esta transcripción es del audio\./);
  assert.ok(!plain.artifacts.some((a) => /subtítulos incrustados/.test(a.filename)), 'the track is attached only when subtitles are asked');

  const asked = await artifacts.buildMediaTranscriptArtifacts({ rows: [row('clase')], transcripts: new Map([['clase', transcript]]),
    output: { wantsSubtitles: true }, userId: 'u1', createDocument: fakeDocument([]) });
  const track = asked.artifacts.find((a) => a.filename === 'clase (subtítulos incrustados).srt');
  assert.ok(track, asked.artifacts.map((a) => a.filename).join(', '));
  assert.match(decode(track), /00:00:02,000 --> 00:00:05,000\nGood morning, everyone\./);
  assert.match(decode(asked.artifacts.find((a) => a.format === 'txt')), /esos subtítulos van aparte en SRT/);
});

test('a requested window cuts the doubtful stretches, the screen text and the kept track to that window', async () => {
  const result = asrResult({
    quality: { level: 'media', lowConfidence: [{ start: 120, end: 150, reason: 'overlap' }, { start: 1900, end: 1950, reason: 'music' }], enginesUsed: ['openai'], notes: [] },
    onScreenText: [{ start: 100, end: 110, text: 'Fuera del tramo' }, { start: 1850, end: 1900, text: 'Dentro del tramo' }],
    embeddedSubtitles: { language: 'es', segments: [{ start: 10, end: 12, text: 'Antes' }, { start: 1860, end: 1865, text: 'Durante' }] },
  });
  const output = { range: { start: 1800, end: 2100 }, wantsSubtitles: true };
  const built = await artifacts.buildMediaTranscriptArtifacts({ rows: [row('clase')], transcripts: new Map([['clase', stored(result)]]), output, userId: 'u1', createDocument: fakeDocument([]) });
  const txt = decode(built.artifacts.find((a) => a.format === 'txt'));
  assert.match(txt, /Tramos dudosos: 31:40–32:30 \(música\)/);
  assert.doesNotMatch(txt, /voces superpuestas/);
  assert.match(txt, /Dentro del tramo/);
  assert.doesNotMatch(txt, /Fuera del tramo/);
  const track = decode(built.artifacts.find((a) => /subtítulos incrustados 30\.00–35\.00/.test(a.filename)));
  assert.match(track, /Durante/);
  assert.doesNotMatch(track, /Antes/);
});

test('a clip offset moves the doubtful stretches and the screen text to the recording clock, never twice', async () => {
  const clip = asrResult({ durationSec: 1200, segments: lectureSegments({ minutes: 20 }),
    quality: { level: 'baja', lowConfidence: [{ start: 60, end: 90, reason: 'low_confidence' }], enginesUsed: ['groq', 'local'], notes: [] },
    onScreenText: [{ start: 30, end: 40, text: 'Pizarra' }] });
  const fresh = artifacts.transcriptView(row('tramo'), clip, { timeOffsetSec: 3600 });
  assert.deepEqual(fresh.result.quality.lowConfidence.map((i) => [i.start, i.end]), [[3660, 3690]]);
  assert.equal(fresh.result.onScreenText[0].start, 3630);
  const report = artifacts.transcriptQualityReport(fresh.result);
  assert.equal(report.doubtful, '01:01:00–01:01:30 (baja confianza)');
  assert.equal(report.line, 'Calidad: baja · cobertura 99 % · motores: Groq y Whisper local');
  // The queue stores a link clip already shifted: the offset is not added again.
  const shifted = stored({ ...clip, timeOffsetSec: 3600, segments: clip.segments.map((s) => ({ ...s, start: s.start + 3600, end: s.end + 3600 })),
    quality: { ...clip.quality, lowConfidence: [{ start: 3660, end: 3690, reason: 'low_confidence' }] },
    onScreenText: [{ start: 3630, end: 3640, text: 'Pizarra' }] });
  const kept = artifacts.transcriptView(row('tramo'), shifted, { timeOffsetSec: 3600 });
  assert.deepEqual(kept.result.quality.lowConfidence.map((i) => [i.start, i.end]), [[3660, 3690]]);
  assert.equal(kept.result.onScreenText[0].start, 3630);
});

test('the hints the engine was given are named back to the user', async () => {
  const transcript = stored(asrResult({ hints: { language: 'en', terms: ['Huamán', 'Ayacucho'], speakers: 3, verbatim: true } }));
  const built = await artifacts.buildMediaTranscriptArtifacts({ rows: [row('clase')], transcripts: new Map([['clase', transcript]]), output: {}, userId: 'u1', createDocument: fakeDocument([]) });
  const expected = 'Tuve en cuenta lo que me indicaste: idioma inglés · 3 hablantes · transcripción literal · nombres y términos: Huamán y Ayacucho.';
  assert.ok(decode(built.artifacts[0]).includes(`Nota: ${expected}`));
  const content = deliveryMessage({ delivery: {}, rows: [row('clase')], transcripts: { clase: transcript } });
  assert.ok(content.includes(expected));
});

test('an older transcript (no report) keeps today\'s files and message, and a stored «coverage: null» is never 0 %', async () => {
  const legacy = { language: 'es', durationSec: 1200, coverage: null, gaps: [], providers: { openai: 2 }, engine: 'cloud', segments: lectureSegments({ minutes: 20 }) };
  const built = await artifacts.buildMediaTranscriptArtifacts({ rows: [row('clase')], transcripts: new Map([['clase', legacy]]), output: {}, userId: 'u1', createDocument: fakeDocument([]) });
  const txt = decode(built.artifacts.find((a) => a.format === 'txt'));
  assert.doesNotMatch(txt, /Calidad|Tramos dudosos|Fuente/);
  assert.doesNotMatch(txt, /Cobertura: 0 %/);
  const content = deliveryMessage({ delivery: {}, rows: [row('clase')], transcripts: { clase: legacy } });
  assert.doesNotMatch(content, /Calidad|Tramos dudosos|revisa del minuto/);
  assert.equal(artifacts.transcriptQualityReport(artifacts.transcriptResultFor(row('clase'), legacy)).hasReport, false);
});

// ── the delivered chat message ─────────────────────────────────────────

test('a ready delivery leads with «Calidad: alta · cobertura 99 % · motor: …», the doubtful stretches and how to repair them', () => {
  const content = deliveryMessage({ delivery: { fileIds: ['clase'] }, rows: [row('clase')], transcripts: { clase: stored(asrResult()) } });
  assert.match(content, /\*\*Tu transcripción de «clase\.mp4» está lista\.\*\*/);
  assert.match(content, /Calidad: alta · cobertura 99 % · motor: Whisper local/);
  assert.match(content, /Tramos dudosos: 12:30–13:10 \(ruido\)/);
  assert.match(content, /dime «revisa del minuto 12 al 14»/);
});

test('a partial delivery prints its coverage once (details line), never twice', () => {
  const result = asrResult({ coverage: 0.93, partial: true, gaps: [{ start: 600, end: 760, reason: 'all_providers_failed' }] });
  const content = deliveryMessage({ delivery: {}, rows: [row('clase', { processingError: 'Parcial: 1 de 4 tramos fallaron.' })],
    transcripts: { clase: stored(result) } });
  assert.equal((content.match(/cobertura/g) || []).length, 1, content);
  assert.match(content, /Calidad: alta · motor: Whisper local/);
});

test('a window outside the recording shows no coverage in the report either', () => {
  const content = deliveryMessage({ delivery: { range: { start: 20000, end: 21000 } }, rows: [row('clase')], transcripts: { clase: stored(asrResult()) } });
  assert.match(content, /queda fuera de la grabación/);
  assert.doesNotMatch(content, /cobertura/);
});

test('a batch line carries the level, the doubtful count and a non-voice source', () => {
  const onscreen = stored({ ok: true, source: 'onscreen', durationSec: 300, coverage: null, segments: [{ start: 0, end: 10, text: 'Portada' }],
    quality: { level: 'media', lowConfidence: [{ start: 0, end: 10, reason: 'illegible' }], enginesUsed: ['ocr'], notes: ['El video no tiene audio; transcribí el texto que aparece en pantalla.'] } }, 'b');
  const content = deliveryMessage({ delivery: {}, rows: [row('a'), row('b')], transcripts: { a: stored(asrResult(), 'a'), b: onscreen } });
  assert.match(content, /- «a\.mp4»: lista · .*· calidad alta · 1 tramo dudoso/);
  assert.match(content, /- «b\.mp4»: lista · .*· calidad media · 1 tramo dudoso · desde el texto en pantalla/);
});

test('the inline chat preview card carries the same report', () => {
  const preview = artifacts.buildTranscriptChatPreview({ rows: [row('clase')],
    transcripts: new Map([['clase', stored(asrResult({ onScreenText: [{ start: 5, end: 9, text: 'Título' }] }))]]), output: {} });
  assert.match(preview, /_Calidad: alta · motor: Whisper local_/);
  assert.match(preview, /_Tramos dudosos: 12:30–13:10 \(ruido\)_/);
  assert.match(preview, /También leí el texto que aparece en pantalla \(1 fragmento\)/);
});

test('the analysis of a window reads the screen text of that window only', () => {
  const transcript = stored(asrResult({ onScreenText: [{ start: 100, end: 110, text: 'Antes' }, { start: 1850, end: 1860, text: 'Dentro' }] }));
  const [analysed] = handoff.mediaRowsForAnalysis([row('clase')], new Map([['clase', transcript]]), { start: 1800, end: 2100 });
  assert.match(analysed.extractedText, /Dentro/);
  assert.doesNotMatch(analysed.extractedText, /Antes/);
  assert.doesNotMatch(analysed.extractedText, /Minuto 5:/);
});

// ── refine records ─────────────────────────────────────────────────────

test('a refine record is one file with a closed window; it keeps hints and never runs an analysis', () => {
  const record = normalizeNewRecord({ userId: 'u1', fileIds: ['f1'], kind: 'refine', mode: 'analysis', range: { start: 720, end: 900 },
    hints: { terms: ['Ccori', 'WA0012'], speakers: 2 } });
  assert.equal(record.kind, 'refine');
  assert.equal(record.mode, 'transcript');
  assert.deepEqual(record.range, { start: 720, end: 900 });
  assert.deepEqual(record.hints, { terms: ['Ccori'], speakers: 2 }, 'device ids are not names');
  assert.equal(record.refine, null);
  assert.equal(normalizeNewRecord({ userId: 'u1', fileIds: ['f1'] }).kind, 'transcript');
  assert.throws(() => normalizeNewRecord({ userId: 'u1', fileIds: ['f1', 'f2'], kind: 'refine', range: { start: 1, end: 2 } }), /un solo archivo/);
  assert.throws(() => normalizeNewRecord({ userId: 'u1', fileIds: ['f1'], kind: 'refine', range: { start: 60 } }), /inicio y fin/);
  assert.deepEqual(normalizeRefineOutcome({ ok: false, code: 'no speech!' }, T0), { status: 'failed', unchanged: false, code: 'no_speech_', at: new Date(T0).toISOString() });
  assert.equal(normalizeRefineOutcome({}), null);
});

test('noteRefineOutcome keeps the first failure: the worker\'s generic report never hides the real reason', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdq-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createMediaDeliveryStore({ root, now: () => T0 });
  const refine = await store.create({ userId: 'u1', fileIds: ['f1'], kind: 'refine', range: { start: 60, end: 120 } });
  assert.equal((await store.noteRefineOutcome(refine.id, { ok: false, code: 'no_speech' })).refine.code, 'no_speech');
  const after = await store.noteRefineOutcome(refine.id, { ok: false, code: 'refine_failed' });
  assert.equal(after.refine.status, 'failed');
  assert.equal(after.refine.code, 'no_speech', 'the specific reason stays');
  assert.equal((await store.get(refine.id)).refine.code, 'no_speech');
  const upgraded = await store.noteRefineOutcome(refine.id, { ok: true });
  assert.equal(upgraded.refine.status, 'ok', 'a later success still upgrades a failure');
  assert.equal(upgraded.refine.code, null);
});

test('noteRefineOutcome records the outcome under the lock and never downgrades an «ok»', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdq-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createMediaDeliveryStore({ root, now: () => T0 });
  const refine = await store.create({ userId: 'u1', fileIds: ['f1'], kind: 'refine', range: { start: 60, end: 120 } });
  const plain = await store.create({ userId: 'u1', fileIds: ['f1'] });
  assert.equal(await store.noteRefineOutcome(plain.id, { ok: true }), null, 'only refines take an outcome');
  assert.equal((await store.noteRefineOutcome(refine.id, { ok: true, unchanged: true })).refine.status, 'ok');
  assert.equal((await store.noteRefineOutcome(refine.id, { ok: false, code: 'refine_failed' })).refine.status, 'ok', 'a duplicate failure never downgrades');
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith('.lock')), [], 'the lock is released');
  const claimed = await store.claim(refine.id);
  assert.equal(await store.noteRefineOutcome(refine.id, { ok: true }, { tries: 2, waitMs: 1 }), null, 'a held lock is not stolen');
  await store.markDelivered(refine.id, claimed.token, {});
  assert.equal(await store.noteRefineOutcome(refine.id, { ok: true }), null, 'a delivered record is not touched');
});

// ── refine deliveries (service) ────────────────────────────────────────

async function harness(t, { files = [], transcripts = {}, overrides = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdq-delivery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const clock = { t: T0 };
  const now = () => clock.t;
  const state = { files: new Map(files.map((r) => [r.id, { ...r }])), messages: [], notifications: [], saved: [], built: [], chats: new Set(['chat1']) };
  const prisma = { message: { async findFirst({ where }) {
    const filters = [where.metadata, ...(where.AND || []).map((c) => c.metadata)].filter(Boolean);
    const found = state.messages.find((m) => m.chatId === where.chatId && filters.every((f) => m.metadata?.[f.path[0]] === f.equals));
    return found ? { id: found.id, chatId: found.chatId } : null;
  } } };
  const store = createMediaDeliveryStore({ root, now });
  const service = createMediaDeliveryService({
    env: ENABLED, now, prisma, store, logger: { info() {}, warn() {} },
    loadFiles: async (userId, ids) => ids.map((id) => state.files.get(id)).filter((r) => r && r.userId === userId).map((r) => ({ ...r })),
    loadTranscript: async (_p, { fileId }) => transcripts[fileId] || null,
    buildArtifacts: async ({ rows, delivery: rec }) => {
      state.built.push({ ids: rows.map((r) => r.id), range: rec.range });
      return [{ filename: 'clase (transcripción).txt', base64: Buffer.from('full').toString('base64'), mime: 'text/plain' }];
    },
    saveArtifact: ({ filename, mime }) => { const a = { id: `art${state.saved.length + 1}`, filename, mime, format: filename.split('.').pop() }; state.saved.push(a); return a; },
    persistArtifact: async () => {},
    postMessage: async ({ chatId, content, metadata, artifacts: list }) => {
      const message = { id: `msg${state.messages.length + 1}`, chatId, content, metadata, artifacts: list };
      state.messages.push(message);
      return { messageId: message.id, chatId };
    },
    ensureChat: async ({ chatId }) => ({ chatId: chatId || 'chat1', created: false }),
    notify: async (payload) => { state.notifications.push(payload); },
    analyze: async () => { throw new Error('a refine never runs an analysis'); },
    ...overrides,
  });
  return { service, state, clock, store };
}

const refineRecord = (extra = {}) => ({ userId: 'u1', chatId: 'chat1', taskId: 't1', fileIds: ['clase'], fileNames: ['clase.mp4'],
  goal: 'revisa del minuto 12 al 15, se escuchó mal', kind: 'refine', range: { start: 720, end: 900 }, ...extra });

test('a refine waits for its job (the file is already ready) and then posts «Corregí el tramo …» with the updated files', async (t) => {
  const transcript = stored(asrResult({ quality: { level: 'media', lowConfidence: [{ start: 760, end: 770, reason: 'noise' }], enginesUsed: ['openai'], notes: [] } }));
  const { service, state, clock } = await harness(t, { files: [row('clase', { processingStageAt: new Date(T0 - 60 * MIN) })], transcripts: { clase: transcript } });
  const record = await service.createDelivery(refineRecord());
  assert.equal(record.kind, 'refine');
  clock.t += 5 * MIN;
  const swept = await service.sweepPendingDeliveries();
  assert.deepEqual(swept.results.map((r) => [r.status, r.awaitingRefine]), [['waiting', true]], 'a ready file is not a finished refine');
  // A normal terminal of the same file (another job) is not the refine's outcome.
  await service.onMediaTerminal({ fileId: 'clase', userId: 'u1', stage: 'ready' });
  assert.equal(state.messages.length, 0);

  const hook = await service.onMediaTerminal({ fileId: 'clase', userId: 'u1', stage: 'ready', refine: true, range: { start: 720, end: 900 }, deliveryId: record.id, ok: true });
  assert.deepEqual(hook.results.map((r) => r.status), ['delivered']);
  const [message] = state.messages;
  assert.match(message.content, /^\*\*Corregí el tramo 00:12:00–00:15:00 de «clase\.mp4»\.\*\*/);
  assert.match(message.content, /### Tramo corregido/);
  assert.match(message.content, /\\\[12:00\\\] Minuto 12: explicamos/, 'the corrected window, escaped, on the recording clock');
  assert.doesNotMatch(message.content, /Minuto 20: explicamos/, 'only the window is previewed');
  assert.match(message.content, /Todavía hay dudas en este tramo: 12:40–12:50 \(ruido\)\./);
  assert.match(message.content, /\*\*Descargas:\*\* clase \(transcripción\)\.txt/);
  assert.deepEqual(state.built, [{ ids: ['clase'], range: null }], 'the updated files are the whole transcript, not the window');
  assert.equal(message.metadata.source, 'media-delivery');
  assert.equal(message.metadata.mediaDelivery, record.id);
  assert.equal(message.metadata.deliveryKind, 'refine');
  assert.deepEqual(message.metadata.refineRange, { start: 720, end: 900 });
  assert.equal(message.metadata.refineOutcome, 'ok');
  assert.equal(message.metadata.stoppedReason, 'transcription_refine');
  assert.equal(state.notifications[0].title, 'Corregí el tramo 00:12:00–00:15:00 de «clase.mp4»');
  assert.equal(state.notifications[0].type, 'media_transcription_refine');

  // Idempotent: the same report again posts nothing.
  await service.onMediaTerminal({ fileId: 'clase', userId: 'u1', stage: 'ready', refine: true, range: { start: 720, end: 900 }, deliveryId: record.id, ok: true });
  assert.equal(state.messages.length, 1);
  assert.equal((await service.deliverOne(record.id)).status, 'delivered');
  assert.equal(state.messages.length, 1);
});

test('a refine already posted by a process that crashed before marking it is never posted twice', async (t) => {
  const { service, state } = await harness(t, { files: [row('clase')], transcripts: { clase: stored(asrResult()) } });
  const record = await service.createDelivery(refineRecord());
  state.messages.push({ id: 'msg_prev', chatId: 'chat1', content: 'x', metadata: { source: 'media-delivery', mediaDelivery: record.id } });
  const hook = await service.onMediaTerminal({ fileId: 'clase', userId: 'u1', refine: true, range: { start: 720, end: 900 }, ok: true });
  assert.deepEqual(hook.results.map((r) => r.status), ['already_delivered']);
  assert.equal(state.messages.length, 1);
});

test('an unchanged window says so and sends no files; a failed refine says why and keeps the transcript', async (t) => {
  const same = await harness(t, { files: [row('clase')], transcripts: { clase: stored(asrResult()) } });
  const a = await same.service.createDelivery(refineRecord());
  await same.service.onMediaTerminal({ fileId: 'clase', userId: 'u1', refine: true, range: { start: 720, end: 900 }, ok: true, unchanged: true, deliveryId: a.id });
  assert.match(same.state.messages[0].content, /\*\*Volví a transcribir el tramo 00:12:00–00:15:00 de «clase\.mp4»\.\*\*/);
  assert.match(same.state.messages[0].content, /no cambié nada/);
  assert.match(same.state.messages[0].content, /### Lo que se escucha en ese tramo/);
  assert.equal(same.state.saved.length, 0);
  assert.equal(same.state.messages[0].metadata.refineOutcome, 'unchanged');
  assert.equal(same.state.notifications[0].title, 'Revisé el tramo 00:12:00–00:15:00 de «clase.mp4»');

  const bad = await harness(t, { files: [row('clase')], transcripts: { clase: stored(asrResult()) } });
  await bad.service.createDelivery(refineRecord());
  await bad.service.onMediaTerminal({ fileId: 'clase', userId: 'u1', stage: 'failed', refine: true, range: { start: 720, end: 900 }, ok: false, code: 'no_speech' });
  const content = bad.state.messages[0].content;
  assert.match(content, /\*\*No pude corregir el tramo 00:12:00–00:15:00 de «clase\.mp4»\.\*\*/);
  assert.match(content, /Motivo: no se detectó voz en ese tramo\./);
  assert.match(content, /La transcripción sigue como estaba/);
  assert.equal(bad.state.saved.length, 0);
  assert.equal(bad.state.messages[0].metadata.stoppedReason, 'transcription_refine_failed');
  assert.equal(bad.state.notifications[0].type, 'media_transcription_refine_failed');
});

test('one refine job answers the identical requests it served; an overlapping one is matched only without an id', async (t) => {
  const { service, state, store } = await harness(t, { files: [row('clase')], transcripts: { clase: stored(asrResult()) } });
  const first = await service.createDelivery(refineRecord());
  // An identical request reuses the running job, which carries only the first id.
  const twin = await service.createDelivery(refineRecord());
  // 720.2 s is another job for the queue (its key keeps the window to the millisecond).
  const nudged = await service.createDelivery(refineRecord({ range: { start: 720.2, end: 900 } }));
  const other = await service.createDelivery(refineRecord({ range: { start: 1800, end: 1900 } }));
  await service.onMediaTerminal({ fileId: 'clase', userId: 'u1', refine: true, range: { start: 720, end: 900 }, ok: true, deliveryId: first.id });
  assert.deepEqual(state.messages.map((m) => m.metadata.mediaDelivery).sort(), [first.id, twin.id].sort());
  assert.equal((await store.get(nudged.id)).status, 'pending', 'its own job has not reported yet');
  assert.equal((await store.get(other.id)).status, 'pending', 'another window keeps waiting');
  await service.onMediaTerminal({ fileId: 'clase', userId: 'u1', refine: true, range: { start: 720.2, end: 900 }, ok: true, deliveryId: nudged.id });
  assert.equal(state.messages.length, 3);
  await service.onMediaTerminal({ fileId: 'clase', userId: 'u1', refine: true, range: { start: 1795, end: 1905 }, ok: true });
  assert.equal(state.messages.length, 4, 'the queue rounded the window: the overlapping open refine takes it');
  assert.equal(state.messages[3].metadata.mediaDelivery, other.id);
});

test('same window, other hints: each request is answered by its own job, never by the other one', async (t) => {
  const { service, state, store } = await harness(t, { files: [row('clase')], transcripts: { clase: stored(asrResult()) },
    overrides: { recordHints: async () => ({ ok: true }) } });
  const plain = await service.createDelivery(refineRecord());
  const named = await service.createDelivery(refineRecord({ hints: { terms: ['Ccori'] }, goal: 'revisa del minuto 12 al 15, el profesor se llama Ccori' }));
  const english = await service.createDelivery(refineRecord({ language: 'en' }));
  assert.notEqual(delivery.refineJobKeyOf(plain), delivery.refineJobKeyOf(named));
  assert.notEqual(delivery.refineJobKeyOf(plain), delivery.refineJobKeyOf(english));
  // Job A (no hints) read the window exactly as before.
  await service.onMediaTerminal({ fileId: 'clase', userId: 'u1', refine: true, range: { start: 720, end: 900 }, ok: true, unchanged: true, deliveryId: plain.id });
  assert.deepEqual(state.messages.map((m) => m.metadata.mediaDelivery), [plain.id]);
  assert.equal((await store.get(named.id)).status, 'pending', 'the request with «Ccori» waits for its own job');
  assert.equal((await store.get(named.id)).refine, null, 'and never takes job A\'s outcome');
  assert.equal((await store.get(english.id)).status, 'pending');
  // Job B (with «Ccori») corrected it.
  await service.onMediaTerminal({ fileId: 'clase', userId: 'u1', refine: true, range: { start: 720, end: 900 }, ok: true, deliveryId: named.id });
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[1].metadata.mediaDelivery, named.id);
  assert.match(state.messages[1].content, /^\*\*Corregí el tramo 00:12:00–00:15:00 de «clase\.mp4»\.\*\*/);
  assert.equal(state.messages[1].metadata.refineOutcome, 'ok');
  assert.equal((await store.get(english.id)).status, 'pending');
});

test('a job whose own record already closed answers only the open requests with its job key', async (t) => {
  const { service, state, store } = await harness(t, { files: [row('clase')], transcripts: { clase: stored(asrResult()) },
    overrides: { recordHints: async () => ({ ok: true }) } });
  const first = await service.createDelivery(refineRecord());
  const twin = await service.createDelivery(refineRecord());
  const named = await service.createDelivery(refineRecord({ hints: { terms: ['Ccori'] } }));
  const claimed = await store.claim(first.id);
  await store.markDelivered(first.id, claimed.token, {});
  await service.onMediaTerminal({ fileId: 'clase', userId: 'u1', refine: true, range: { start: 720, end: 900 }, ok: true, deliveryId: first.id });
  assert.deepEqual(state.messages.map((m) => m.metadata.mediaDelivery), [twin.id]);
  assert.equal((await store.get(named.id)).status, 'pending');
});

test('a missed outcome report: after the grace the rewritten file is posted without claiming a correction; at the ceiling an untouched one is a failure', async (t) => {
  const { service, state, clock } = await harness(t, { files: [row('clase', { processingStageAt: new Date(T0 + 10 * MIN) })], transcripts: { clase: stored(asrResult()) } });
  await service.createDelivery(refineRecord());
  clock.t = T0 + 20 * MIN;
  assert.deepEqual((await service.sweepPendingDeliveries()).results.map((r) => r.status), ['waiting']);
  clock.t = T0 + 31 * MIN;
  assert.deepEqual((await service.sweepPendingDeliveries()).results.map((r) => r.status), ['delivered']);
  assert.match(state.messages[0].content, /Aquí tienes el tramo 00:12:00–00:15:00 de «clase\.mp4» con la transcripción más reciente/);
  assert.doesNotMatch(state.messages[0].content, /Corregí/);
  assert.equal(state.messages[0].metadata.refineOutcome, 'inferred');

  const idle = await harness(t, { files: [row('clase', { processingStageAt: new Date(T0 - 60 * MIN) })], transcripts: { clase: stored(asrResult()) } });
  await idle.service.createDelivery(refineRecord());
  idle.clock.t = T0 + 23 * 60 * MIN;
  assert.deepEqual((await idle.service.sweepPendingDeliveries()).results.map((r) => r.status), ['waiting']);
  idle.clock.t = T0 + 24 * 60 * MIN;
  await idle.service.sweepPendingDeliveries();
  assert.match(idle.state.messages[0].content, /No pude corregir el tramo .*\n\nMotivo: la corrección no terminó a tiempo\./);
});

test('a refine whose file is still being transcribed at the ceiling says so, never «no está disponible»', async (t) => {
  const { service, state, clock } = await harness(t, { files: [row('clase', { processingStage: 'transcribing', extractedText: null,
    processingStageAt: new Date(T0 - 60 * MIN) })], transcripts: {} });
  await service.createDelivery(refineRecord());
  clock.t = T0 + 24 * 60 * MIN;
  await service.sweepPendingDeliveries();
  const content = state.messages[0].content;
  assert.match(content, /\*\*No pude corregir el tramo 00:12:00–00:15:00 de «clase\.mp4»\.\*\*\n\nMotivo: la transcripción de este archivo todavía no estaba lista\./);
  assert.match(content, /Cuando esté lista, pídeme de nuevo/);
  assert.doesNotMatch(content, /ya no está disponible/);
  const failed = refineMessage({ delivery: { kind: 'refine', fileNames: ['clase.mp4'], range: { start: 720, end: 900 } },
    rows: [row('clase', { processingStage: 'failed', extractedText: null, processingError: 'El audio está dañado.' })], outcome: { status: 'ok' } });
  assert.match(failed, /Motivo: El audio está dañado\./);
});

test('a refine of a deleted file is answered at once, honestly', async (t) => {
  const { service, state } = await harness(t, { files: [], transcripts: {} });
  const record = await service.createDelivery(refineRecord());
  assert.equal((await service.deliverOne(record.id)).status, 'delivered');
  assert.match(state.messages[0].content, /No pude corregir el tramo 00:12:00–00:15:00 de «clase\.mp4»\.\*\*\n\nMotivo: El archivo ya no está disponible\./);
});

test('a refine of a link clip previews the window on the recording clock', () => {
  const clip = stored({ ...asrResult({ durationSec: 1200, quality: null }), timeOffsetSec: 3600,
    segments: lectureSegments({ minutes: 20, from: 3600 }) }, 'tramo');
  const content = refineMessage({ delivery: { kind: 'refine', fileNames: ['tramo.m4a'], range: { start: 3720, end: 3900 } },
    rows: [row('tramo', { originalName: 'tramo.m4a' })], transcripts: { tramo: clip }, outcome: { status: 'ok' } });
  assert.match(content, /Corregí el tramo 01:02:00–01:05:00 de «tramo\.m4a»/);
  assert.match(content, /\\\[01:02:00\\\] Minuto 2: explicamos/);
  assert.doesNotMatch(content, /Minuto 10: explicamos/);
});

test('refine copy for the turn that asks for it, and refine notifications', () => {
  assert.equal(refineHandOffMessage({ fileName: 'clase.mp4', range: { start: 720, end: 900 } }),
    'Voy a volver a transcribir el tramo 00:12:00–00:15:00 de «clase.mp4». Te aviso aquí y en notificaciones cuando esté listo; puedes seguir usando el chat.');
  const copy = notificationCopy({ delivery: { kind: 'refine', range: { start: 720, end: 900 }, fileNames: ['clase.mp4'] }, rows: [row('clase')],
    outcome: { status: 'failed', code: 'refine_untimed' } });
  assert.equal(copy.kind, 'refine_failed');
  assert.equal(copy.title, 'No pude corregir el tramo 00:12:00–00:15:00 de «clase.mp4»');
  assert.equal(delivery.chatTitleFor({ kind: 'refine', fileNames: ['clase.mp4'] }), 'Corrección: clase.mp4');
  const failure = delivery.deliveryFailureCopy({ delivery: { kind: 'refine', range: { start: 720, end: 900 }, fileNames: ['clase.mp4'] } });
  assert.match(failure.body, /corrección del tramo 00:12:00–00:15:00 de «clase\.mp4»/);
});

test('the default builder re-sends the whole updated transcript for a refine (never only the window)', async () => {
  const shortAudio = { ...asrResult({ durationSec: 300, segments: lectureSegments({ minutes: 5 }) }) };
  const built = await delivery.professionalBuildArtifacts({ rows: [row('nota', { originalName: 'nota.ogg', mimeType: 'audio/ogg' })],
    transcripts: { nota: stored(shortAudio, 'nota') }, delivery: { kind: 'refine', range: { start: 60, end: 120 }, formats: ['txt'], userId: 'u1' } });
  const txt = decode(built.find((a) => a.format === 'txt'));
  assert.match(txt, /Minuto 0: explicamos/);
  assert.match(txt, /Minuto 4: explicamos/);
  assert.doesNotMatch(built[0].filename, /01\.00/, 'no window in the file name');
});

test('the preview of a screen-text transcript does not repeat the source note the report already gave', () => {
  const note = 'El video no tiene audio; transcribí el texto que aparece en pantalla.';
  const transcript = stored({ ok: true, source: 'onscreen', durationSec: 120, coverage: null,
    segments: [{ start: 0, end: 30, text: 'Bienvenidos' }], quality: { level: 'alta', enginesUsed: ['ocr'], notes: [note] } });
  const content = deliveryMessage({ delivery: {}, rows: [row('clase', { extractedText: `(${note})\n\n[00:00] Bienvenidos` })],
    transcripts: { clase: transcript } });
  assert.equal(content.split(note).length - 1, 1, content);
  assert.match(content, /### Transcripción\n\n\\\[00:00\\\] Bienvenidos/);
});

test('a delivery that carries hints keeps them durably per file, best-effort', async (t) => {
  const calls = [];
  const { service } = await harness(t, { files: [row('clase')], overrides: {
    recordHints: async (args) => { calls.push(args); if (args.fileId === 'b') throw new Error('db down'); return { ok: true }; } } });
  const record = await service.createDelivery({ userId: 'u1', chatId: 'chat1', fileIds: ['clase', 'b'], language: 'en',
    hints: { terms: ['Huamán', 'PTT-20261003-WA0012'], speakers: 3 } });
  assert.ok(record, 'a failed hint write never costs the delivery');
  assert.deepEqual(record.hints, { terms: ['Huamán'], speakers: 3 });
  assert.deepEqual(calls.map((c) => [c.fileId, c.userId, c.language, c.hints?.terms]), [['clase', 'u1', 'en', ['Huamán']], ['b', 'u1', 'en', ['Huamán']]]);
  calls.length = 0;
  await service.createDelivery({ userId: 'u1', chatId: 'chat1', fileIds: ['clase'] });
  assert.equal(calls.length, 0, 'nothing to remember, nothing written');
});

test('the inline preview of a screen-text transcript names its source and never claims audio coverage', () => {
  const transcript = stored({ ok: true, source: 'onscreen', durationSec: 120, coverage: null,
    segments: [{ start: 0, end: 30, text: 'Bienvenidos' }],
    quality: { level: 'media', enginesUsed: ['ocr'], notes: ['El video no tiene audio; transcribí el texto que aparece en pantalla.'] } });
  const preview = artifacts.buildTranscriptChatPreview({ rows: [row('clase')], transcripts: new Map([['clase', transcript]]), output: {} });
  assert.doesNotMatch(preview, /cobertura/);
  assert.match(preview, /_Fuente: texto que aparece en pantalla · calidad media_/);
  assert.match(preview, /_El video no tiene audio; transcribí el texto que aparece en pantalla\._/);
  assert.match(preview, /Bienvenidos/);
});

// ── review fixes: engine names, window cleanup, attached files, renamed tracks ──

test('the report names engines, never internal identifiers («openai:whisper-1», «local:ggml-base.bin+loudnorm»)', () => {
  const transcript = stored(asrResult({ quality: { level: 'media', lowConfidence: [], escalations: 1,
    enginesUsed: ['openai:whisper-1', 'local:ggml-base.bin+loudnorm', 'local:ggml-base.bin'], notes: [] } }));
  const content = deliveryMessage({ delivery: {}, rows: [row('clase')], transcripts: { clase: transcript } });
  assert.match(content, /Calidad: media · cobertura 99 % · motores: OpenAI y Whisper local/);
  assert.doesNotMatch(content, /ggml|whisper-1|loudnorm|openai:/);
  assert.equal(artifacts.engineNameEs('local:ggml-large-v3-turbo-q5_0.bin'), 'Whisper local reforzado');
  assert.equal(artifacts.engineNameEs('groq:whisper-large-v3-turbo'), 'Groq');
  assert.equal(artifacts.engineNameEs('xai:grok-stt+loudnorm'), 'xAI');
  assert.equal(artifacts.engineNameEs('unknown'), '');
  assert.equal(artifacts.engineNameEs('unknown:model'), '');
  assert.equal(artifacts.engineNameEs('acme:model-x+v2'), '', 'an unknown identifier is never printed as is');
  // Nothing nameable among the engines: the providers name them.
  const fallback = stored(asrResult({ providers: { groq: 3 }, quality: { level: 'alta', lowConfidence: [], enginesUsed: ['unknown', 'acme:x'], notes: [] } }));
  const report = artifacts.transcriptQualityReport(artifacts.transcriptResultFor(row('clase'), fallback));
  assert.match(report.line, /· motor: Groq$/);
});

test('a window header never claims the cleanup counted over the whole recording', async () => {
  const transcript = stored(asrResult({ cleanup: { input: 120, kept: 80, hallucinations: 30, repeats: 10 } }));
  assert.ok(transcript.cleanup, 'the sidecar keeps the queue\'s cleanup counts');
  const whole = await artifacts.buildMediaTranscriptArtifacts({ rows: [row('clase')], transcripts: new Map([['clase', transcript]]),
    output: {}, userId: 'u1', createDocument: fakeDocument([]) });
  assert.match(decode(whole.artifacts.find((a) => a.format === 'txt')), /Se omitieron 40 fragmentos repetidos o inventados/);
  const docs = [];
  const windowed = await artifacts.buildMediaTranscriptArtifacts({ rows: [row('clase')], transcripts: new Map([['clase', transcript]]),
    output: { range: { start: 1800, end: 1900 }, documentFormat: 'docx' }, userId: 'u1', createDocument: fakeDocument(docs) });
  const txt = decode(windowed.artifacts.find((a) => a.format === 'txt'));
  assert.match(txt, /Minuto 30: explicamos/);
  assert.doesNotMatch(txt, /fragmentos? repetidos? o inventados?/, 'the whole recording\'s count is not this window\'s');
  assert.doesNotMatch(docs[0].markdown, /fragmentos? repetidos? o inventados?/);
  assert.equal(artifacts._internals.applyRange(artifacts.transcriptResultFor(row('clase'), transcript), { start: 1800, end: 1900 },
    require('../src/services/media-transcript-format')).result.cleanup, undefined);
});

test('the on-screen note points at the files\' section only when the transcript files are attached', async (t) => {
  const transcript = stored(asrResult({ onScreenText: [{ start: 60, end: 90, text: 'Diapositiva 1' }, { start: 300, end: 420, text: 'Diapositiva 2' }] }));
  const section = /También leí el texto que aparece en pantalla \(2 fragmentos\); está en la sección «Texto en pantalla» de los archivos\./;
  const bare = /También leí el texto que aparece en pantalla \(2 fragmentos\)\.(?!;)/;
  // Direct callers: read from the artifacts.
  const withTxt = deliveryMessage({ delivery: {}, rows: [row('clase')], transcripts: { clase: transcript },
    artifacts: [{ filename: 'clase (transcripción).txt', format: 'txt' }] });
  assert.match(withTxt, section);
  const translationOnly = deliveryMessage({ delivery: { mode: 'translation' }, rows: [row('clase')], transcripts: { clase: transcript },
    artifacts: [{ filename: 'clase (traducción al inglés).txt', format: 'txt', role: 'translation' }], analysisText: 'Hello everyone.' });
  assert.match(translationOnly, bare);
  assert.doesNotMatch(translationOnly, /sección «Texto en pantalla»/);
  assert.doesNotMatch(deliveryMessage({ delivery: {}, rows: [row('clase')], transcripts: { clase: transcript }, artifacts: [] }), /sección «Texto en pantalla»/,
    'no files at all (a failed build)');
  assert.doesNotMatch(artifacts.buildTranscriptChatPreview({ rows: [row('clase')], transcripts: new Map([['clase', transcript]]), output: {},
    transcriptFilesAttached: false }), /sección «Texto en pantalla»/);
  assert.match(artifacts.buildTranscriptChatPreview({ rows: [row('clase')], transcripts: new Map([['clase', transcript]]), output: {} }), section);

  // The service: a translation-only delivery attaches only the translation.
  const translating = await harness(t, { files: [row('clase')], transcripts: { clase: transcript }, overrides: {
    analyze: async () => ({ text: 'Hello everyone.', artifacts: [{ filename: 'clase (traducción al inglés).txt',
      base64: Buffer.from('Hello').toString('base64'), mime: 'text/plain' }] }) } });
  await translating.service.createDelivery({ userId: 'u1', chatId: 'chat1', fileIds: ['clase'], fileNames: ['clase.mp4'], mode: 'translation' });
  await translating.service.onMediaTerminal({ fileId: 'clase', userId: 'u1', stage: 'ready' });
  assert.equal(translating.state.built.length, 0, 'no transcript files were built');
  assert.match(translating.state.messages[0].content, bare);
  assert.doesNotMatch(translating.state.messages[0].content, /sección «Texto en pantalla»/);

  // A failed build attaches nothing either; a normal delivery points at the section.
  const empty = await harness(t, { files: [row('clase')], transcripts: { clase: transcript }, overrides: { buildArtifacts: async () => [] } });
  await empty.service.createDelivery({ userId: 'u1', chatId: 'chat1', fileIds: ['clase'], fileNames: ['clase.mp4'] });
  await empty.service.onMediaTerminal({ fileId: 'clase', userId: 'u1', stage: 'ready' });
  assert.doesNotMatch(empty.state.messages[0].content, /sección «Texto en pantalla»/);
  const normal = await harness(t, { files: [row('clase')], transcripts: { clase: transcript } });
  await normal.service.createDelivery({ userId: 'u1', chatId: 'chat1', fileIds: ['clase'], fileNames: ['clase.mp4'] });
  await normal.service.onMediaTerminal({ fileId: 'clase', userId: 'u1', stage: 'ready' });
  assert.match(normal.state.messages[0].content, section);
});

test('the embedded track counts as attached even when the artifact store renames it', async (t) => {
  const transcript = stored(asrResult({ embeddedSubtitles: { language: 'en', codec: 'subrip',
    segments: [{ start: 2, end: 5, text: 'Good morning, everyone.' }] } }));
  const { service, state } = await harness(t, { files: [row('clase')], transcripts: { clase: transcript }, overrides: {
    buildArtifacts: async ({ rows, transcripts: map }) => (await artifacts.buildMediaTranscriptArtifacts({ rows,
      transcripts: new Map(Object.entries(map)), output: { wantsSubtitles: true }, userId: 'u1', createDocument: fakeDocument([]) })).artifacts,
    // Like task-tools.saveArtifact: the stored name is sanitized.
    saveArtifact: ({ filename, mime }) => {
      const clean = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const a = { id: `art${state.saved.length + 1}`, filename: clean, mime, format: clean.split('.').pop() };
      state.saved.push(a);
      return a;
    },
  } });
  await service.createDelivery({ userId: 'u1', chatId: 'chat1', fileIds: ['clase'], fileNames: ['clase.mp4'], formats: ['srt'] });
  await service.onMediaTerminal({ fileId: 'clase', userId: 'u1', stage: 'ready' });
  assert.ok(state.saved.some((a) => a.filename === 'clase__subt_tulos_incrustados_.srt'), state.saved.map((a) => a.filename).join(', '));
  const content = state.messages[0].content;
  assert.match(content, /El video también trae subtítulos incrustados \(inglés\); esta transcripción es del audio y esos subtítulos van aparte en SRT\./);
  // A track that was not attached is never claimed.
  const bare = await harness(t, { files: [row('clase')], transcripts: { clase: transcript } });
  await bare.service.createDelivery({ userId: 'u1', chatId: 'chat1', fileIds: ['clase'], fileNames: ['clase.mp4'] });
  await bare.service.onMediaTerminal({ fileId: 'clase', userId: 'u1', stage: 'ready' });
  assert.match(bare.state.messages[0].content, /esta transcripción es del audio\./);
  assert.doesNotMatch(bare.state.messages[0].content, /van aparte en SRT/);
});
