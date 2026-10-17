'use strict';

// Contract C7 — the chat agent reads a moment of a recording from its
// segments sidecar («¿qué dijo en el minuto 95?»), re-transcribes a stretch
// that was heard wrong (durable refine job + refine delivery) and renames a
// diarized speaker. Offline: a temp sidecar root, an in-memory Prisma, fake
// delivery / queue.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tools = require('../src/services/agent-harness/tools/transcript-tools');
const realStore = require('../src/services/media-transcript-store');
const mediaBatch = require('../src/services/media-batch');
const queue = require('../src/services/media-transcription-queue');

const SPEAKERS = ['spk0', 'spk1', 'spk2'];

/** A two-hour class: one segment every 30 s, three speakers, a gap and a doubtful stretch. */
function lectureResult() {
  const segments = [];
  for (let i = 0; i < 240; i++) {
    const start = i * 30;
    let text = `Frase número ${i} de la clase.`;
    if (i === 190) text = 'Aquí explicamos la mitocondria y la cadena respiratoria.';
    if (i === 10) text = 'Bienvenidos al curso de bioquímica.';
    segments.push({ start, end: start + 25, text, speaker: SPEAKERS[i % 3] });
  }
  return {
    ok: true, language: 'es', durationSec: 7200, providers: { local: 24 }, engine: 'local-whisper', coverage: 0.99,
    gaps: [{ start: 5700, end: 5730, reason: 'segment_failed' }], partial: false, segments, source: 'asr',
    quality: { score: 0.8, level: 'media', lowConfidence: [{ start: 5760, end: 5790, reason: 'noise' }], escalations: 0, enginesUsed: ['local'], notes: [] },
  };
}

function setup({ rows = null, sidecars = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-tools-'));
  const store = {
    ...realStore,
    loadMediaTranscript: (prisma, ref) => realStore.loadMediaTranscript(prisma, ref, { root }),
    writeSidecar: (args, opts = {}) => realStore.writeSidecar(args, { ...opts, root }),
    readSidecar: (id) => realStore.readSidecar(id, { root }),
  };
  const files = new Map((rows || [
    { id: 'clase1', userId: 'u1', originalName: 'Clase de Bioquímica.mp4', mimeType: 'video/mp4', processingStage: 'ready',
      processingError: null, extractedText: '[00:00:00] Hablante 1: inicio de la clase.', deletedAt: null },
  ]).map(row => [row.id, { ...row }]));
  const pick = (row, select) => {
    if (!select) return { ...row };
    const out = {};
    for (const key of Object.keys(select)) if (select[key]) out[key] = row[key];
    return out;
  };
  const matches = (row, where) => (!where.id || (typeof where.id === 'string' ? row.id === where.id : where.id.in.includes(row.id)))
    && row.userId === where.userId && (where.deletedAt !== null || !row.deletedAt);
  const prisma = { file: {
    findMany: async ({ where, select }) => [...files.values()].filter(row => matches(row, where)).map(row => pick(row, select)),
    findFirst: async ({ where, select }) => { const row = [...files.values()].find(r => matches(r, where)); return row ? pick(row, select) : null; },
    updateMany: async ({ where, data }) => {
      const row = [...files.values()].find(r => matches(r, where));
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  } };
  // `delivery: null`: never the real delivery store (it reads the uploads dir).
  const over = { store, mediaBatch: { ...mediaBatch, resolveChatMediaFileIds: async () => [] }, queue, delivery: null };
  return { root, store, files, prisma, over, async write(fileId, userId, result) { await store.writeSidecar({ fileId, userId, result }); },
    ctx: (extra = {}) => ({ prisma, userId: 'u1', chatId: 'chat1', fileIds: [...files.keys()], ...extra }) };
}

test('transcript_lookup reads the window around minute 95 from the sidecar, never the head', async () => {
  const s = setup();
  await s.write('clase1', 'u1', lectureResult());
  const tool = tools.buildTranscriptLookupTool(s.over);
  assert.ok(tool.inputSchema.safeParse({ start: '1:35:00' }).success);
  const res = await tool.execute({ start: '1:35:00' }, s.ctx());
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.source, 'sidecar');
  assert.deepEqual(res.window, { start: 5640, end: 5940, label: '01:34:00–01:39:00' });
  assert.match(res.text, /^\[01:34:00\] Hablante \d: Frase número 188/m);
  assert.match(res.text, /mitocondria/);
  assert.doesNotMatch(res.text, /Bienvenidos al curso/, 'the head of the class is not in the window');
  assert.ok(res.gaps.some(g => g.label === '01:35:00–01:35:30'), 'the untranscribed stretch is reported');
  assert.ok(res.doubtful.some(d => d.reason === 'noise'), 'doubtful stretches in the window are reported');
  assert.equal(res.language, 'es');
  assert.match(res.hint, /\[hh:mm:ss\]/);
});

test('transcript_lookup finds where something is said, with the time and a line of context', async () => {
  const s = setup();
  await s.write('clase1', 'u1', lectureResult());
  const res = await tools.buildTranscriptLookupTool(s.over).execute({ query: '¿dónde habla de la mitocondria?' }, s.ctx());
  assert.equal(res.ok, true);
  assert.ok(res.hits >= 1);
  assert.match(res.text, /\[01:35:00\] Aquí explicamos la mitocondria/);
  assert.match(res.text, /\[01:34:30\] Frase número 189/, 'context before the hit');
});

test('transcript_lookup validates times and stays inside the recording', async () => {
  const s = setup();
  await s.write('clase1', 'u1', lectureResult());
  const tool = tools.buildTranscriptLookupTool(s.over);
  assert.equal((await tool.execute({ start: '5:00:00' }, s.ctx())).code, 'out_of_range');
  assert.equal((await tool.execute({ start: 'ayer' }, s.ctx())).code, 'invalid_range');
  assert.equal((await tool.execute({ start: '10:00', end: '05:00' }, s.ctx())).code, 'invalid_range');
  const explicit = await tool.execute({ start: '30:00', end: '31:00' }, s.ctx());
  assert.equal(explicit.window.label, '00:30:00–00:31:00');
});

test('without a sidecar the stored «[hh:mm:ss]» text is windowed instead', async () => {
  const text = Array.from({ length: 200 }, (_, i) => {
    const t = i * 60;
    const two = n => String(n).padStart(2, '0');
    return `[${two(Math.floor(t / 3600))}:${two(Math.floor((t % 3600) / 60))}:00] Párrafo ${i}.`;
  }).join('\n\n');
  const s = setup({ rows: [{ id: 'viejo', userId: 'u1', originalName: 'viejo.mp3', mimeType: 'audio/mpeg', processingStage: 'ready', extractedText: text }] });
  const res = await tools.buildTranscriptLookupTool(s.over).execute({ start: 95 * 60 }, s.ctx());
  assert.equal(res.ok, true);
  assert.equal(res.source, 'text');
  assert.match(res.text, /\[01:35:00\] Párrafo 95\./);
  assert.doesNotMatch(res.text, /Párrafo 3\./);
});

test('files are resolved owner-scoped: several recordings ask for `file`, another user\'s id is never read', async () => {
  const s = setup({ rows: [
    { id: 'clase1', userId: 'u1', originalName: 'Clase de Bioquímica.mp4', mimeType: 'video/mp4', processingStage: 'ready' },
    { id: 'reunion1', userId: 'u1', originalName: 'Reunión directorio.m4a', mimeType: 'audio/mp4', processingStage: 'ready' },
    { id: 'ajeno99999', userId: 'u2', originalName: 'privado.mp3', mimeType: 'audio/mpeg', processingStage: 'ready' },
  ] });
  await s.write('clase1', 'u1', lectureResult());
  const tool = tools.buildTranscriptLookupTool(s.over);
  const ambiguous = await tool.execute({ start: 60 }, s.ctx({ fileIds: ['clase1', 'reunion1'] }));
  assert.equal(ambiguous.code, 'file_ambiguous');
  assert.equal(ambiguous.files.length, 2);
  const named = await tool.execute({ file: 'bioquímica', start: 60 }, s.ctx({ fileIds: ['clase1', 'reunion1'] }));
  assert.equal(named.ok, true);
  assert.equal(named.file.id, 'clase1');
  const foreign = await tool.execute({ file: 'ajeno99999', start: 60 }, s.ctx({ fileIds: ['clase1', 'reunion1'] }));
  assert.equal(foreign.ok, false);
  assert.notEqual(foreign.file?.id, 'ajeno99999');
  const none = await tool.execute({ start: 60 }, s.ctx({ fileIds: [] }));
  assert.equal(none.code, 'no_media');
});

test('retranscribe_range creates the refine delivery first, then queues the refine with its id', async () => {
  const s = setup();
  await s.write('clase1', 'u1', lectureResult());
  const log = [];
  const delivery = {
    isMediaDeliveryEnabled: () => true,
    createDelivery: async (record) => { log.push(['delivery', record]); return { id: 'md_refine', ...record }; },
    refineHandOffMessage: ({ fileName, range }) => `Voy a volver a transcribir ${range.start}-${range.end} de «${fileName}».`,
  };
  const enqueueRefine = async (payload) => { log.push(['enqueue', payload]); return { queued: true, jobId: 'job1' }; };
  const tool = tools.buildRetranscribeRangeTool({ ...s.over, refineDeps: { delivery, enqueueRefine, transcriptStore: s.store } });
  const res = await tool.execute({ start: '12:00', end: '15:00', language: 'inglés', terms: ['Huamán', 'WA0012', 'Ayacucho'] },
    s.ctx({ userQuery: 'revisa del minuto 12 al 15, los nombres son Huamán y Ayacucho' }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(log.map(([kind]) => kind), ['delivery', 'enqueue']);
  const [, record] = log[0];
  assert.equal(record.kind, 'refine');
  assert.deepEqual(record.range, { start: 720, end: 900 });
  assert.deepEqual(record.fileIds, ['clase1']);
  assert.equal(record.language, 'en');
  assert.deepEqual(record.hints, { terms: ['Huamán', 'Ayacucho'] }, 'device ids never become terms');
  const [, job] = log[1];
  assert.equal(job.deliveryId, 'md_refine');
  assert.deepEqual(job.range, { start: 720, end: 900 });
  assert.match(res.userMessage, /720-900 de «Clase de Bioquímica\.mp4»/);
});

test('retranscribe_range refuses what it cannot do, and a refused queue cancels the delivery silently', async () => {
  const s = setup();
  await s.write('clase1', 'u1', lectureResult());
  const tool = tools.buildRetranscribeRangeTool(s.over);
  assert.equal((await tool.execute({ start: '0:00', end: '2:00:00' }, s.ctx())).code, 'range_too_long');
  assert.equal((await tool.execute({ start: '15:00', end: '12:00' }, s.ctx())).code, 'invalid_range');
  s.files.get('clase1').processingStage = 'extracting';
  assert.equal((await tool.execute({ start: '12:00', end: '15:00' }, s.ctx())).code, 'transcript_not_ready');
  s.files.get('clase1').processingStage = 'ready';
  const cancelled = [];
  const delivery = {
    isMediaDeliveryEnabled: () => true,
    createDelivery: async (record) => ({ id: 'md_x', ...record }),
    getMediaDeliveryService: () => ({ store: { claim: async () => ({ token: 't' }), markFailed: async (id) => { cancelled.push(id); return {}; } } }),
  };
  const failing = tools.buildRetranscribeRangeTool({ ...s.over, refineDeps: { delivery, transcriptStore: s.store,
    enqueueRefine: async () => { throw Object.assign(new Error('redis down'), { code: 'media_queue_unavailable' }); } } });
  const res = await failing.execute({ start: '12:00', end: '15:00' }, s.ctx());
  assert.equal(res.ok, false);
  assert.equal(res.code, 'media_queue_unavailable');
  assert.match(res.userMessage, /sigue como estaba/);
  assert.deepEqual(cancelled, ['md_x']);
});

test('rename_speaker renames one speaker in the sidecar and the stored text, and reports the new labels', async () => {
  const s = setup();
  const result = lectureResult();
  await s.write('clase1', 'u1', result);
  const before = await s.store.readSidecar('clase1');
  const res = await tools.buildRenameSpeakerTool(s.over).execute({ from: 'Hablante 2', to: 'Dra. Rojas' }, s.ctx());
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.renamed, { from: 'Hablante 2', to: 'Dra. Rojas' });
  assert.deepEqual(res.speakers, ['Hablante 1', 'Dra. Rojas', 'Hablante 2']);
  assert.match(res.summary, /Hablante 2 → Dra\. Rojas/);
  assert.match(res.summary, /Hablante 3 → Hablante 2/, 'renumbering is told, never hidden');
  const after = await s.store.readSidecar('clase1');
  assert.equal(after.segments.filter(seg => seg.spk === 'Dra. Rojas').length, 80);
  assert.equal(after.segments.filter(seg => seg.spk === 'spk1').length, 0);
  assert.equal(after.createdAt, before.createdAt, 'the transcript keeps its date');
  assert.deepEqual(after.gaps, before.gaps);
  assert.deepEqual(after.quality, before.quality);
  assert.equal(res.textUpdated, true);
  assert.match(s.files.get('clase1').extractedText, /Dra\. Rojas: /);
  // An unknown speaker lists the real ones; a transcript without speakers says so.
  const missing = await tools.buildRenameSpeakerTool(s.over).execute({ from: 'Hablante 9', to: 'Juan' }, s.ctx());
  assert.equal(missing.code, 'speaker_not_found');
  assert.deepEqual(missing.speakers, ['Hablante 1', 'Dra. Rojas', 'Hablante 2']);
  const plain = lectureResult();
  plain.segments = plain.segments.map(({ speaker, ...seg }) => seg);
  await s.write('clase1', 'u1', plain);
  assert.equal((await tools.buildRenameSpeakerTool(s.over).execute({ from: '1', to: 'Juan' }, s.ctx())).code, 'no_speakers');
});

test('the speaker label resolves by «Hablante N», by number and by its raw id', () => {
  const labels = new Map([['spk0', 'Hablante 1'], ['spk1', 'Hablante 2'], ['Dr. Pérez', 'Dr. Pérez']]);
  assert.equal(tools.resolveSpeaker('hablante 2', labels), 'spk1');
  assert.equal(tools.resolveSpeaker('2', labels), 'spk1');
  assert.equal(tools.resolveSpeaker('spk0', labels), 'spk0');
  assert.equal(tools.resolveSpeaker('dr. perez', labels), 'Dr. Pérez');
  assert.equal(tools.resolveSpeaker('Hablante 7', labels), null);
});

test('the tools are registered: harness, tool selector, loop labels and the policy line', () => {
  const { buildHarnessTools } = require('../src/services/agent-harness/run-agent-turn');
  const names = buildHarnessTools(new Set()).map(def => def.name);
  for (const name of ['transcript_lookup', 'retranscribe_range', 'rename_speaker']) assert.ok(names.includes(name), name);
  assert.ok(!buildHarnessTools(new Set(['transcript_lookup'])).filter(def => def.name === 'transcript_lookup').length);
  const { selectTools } = require('../src/services/agents/tool-selector');
  const pool = ['web_search', 'read_url', 'read_file', 'search_docs', 'transcript_lookup', 'retranscribe_range', 'rename_speaker',
    ...Array.from({ length: 30 }, (_, i) => `misc_tool_${i}`)].map(name => ({ name, description: name }));
  // Pinned only with a recording in the turn or history AND a cue in the
  // query: «recuérdame a las 10:30» without recordings spends no slots.
  const picked = selectTools({ tools: pool, userQuery: '¿qué dijo el profesor en el minuto 95?', intent: 'code_generation', maxTools: 8, signals: { mediaTranscript: true } }, { skillAdapter: null });
  for (const name of ['transcript_lookup', 'retranscribe_range', 'rename_speaker']) assert.ok(picked.selectedNames.includes(name), name);
  // The transcript tools last in the pool: nothing but the core rule could keep them.
  const tail = [...pool.filter(t => !/^(transcript_lookup|retranscribe_range|rename_speaker)$/.test(t.name)),
    ...pool.filter(t => /^(transcript_lookup|retranscribe_range|rename_speaker)$/.test(t.name))];
  const noMedia = selectTools({ tools: tail, userQuery: 'recuérdame a las 10:30 revisar los minutos de la junta', intent: 'code_generation', maxTools: 8, signals: {} }, { skillAdapter: null });
  const withMedia = selectTools({ tools: tail, userQuery: 'recuérdame a las 10:30 revisar los minutos de la junta', intent: 'code_generation', maxTools: 8, signals: { mediaTranscript: true } }, { skillAdapter: null });
  assert.ok(withMedia.selectedNames.includes('transcript_lookup'), 'with a recording the cue pins them');
  assert.equal(noMedia.selectedNames.filter(name => /^(transcript_lookup|retranscribe_range|rename_speaker)$/.test(name)).length, 0);
  const selectorSrc = fs.readFileSync(path.join(__dirname, '../src/services/agents/tool-selector.js'), 'utf8');
  assert.match(selectorSrc, /signals\.mediaTranscript && TRANSCRIPT_FOLLOWUP_RE\.test/);
  const loop = fs.readFileSync(path.join(__dirname, '../src/services/agentic-chat-stream.js'), 'utf8');
  assert.match(loop, /transcript_lookup: \['leer la transcripción'/);
  assert.match(loop, /retranscribe_range: \['volver a transcribir un tramo'/);
  assert.match(loop, /rename_speaker: \['renombrar un hablante'/);
  assert.match(loop, /nunca respondas sobre un minuto que no leíste con esa herramienta/);
  for (const def of tools.buildTranscriptTools()) {
    assert.equal(def.permissionTier, 'auto');
    assert.equal(typeof def.humanDescription({}), 'string');
  }
  assert.equal(tools.buildRetranscribeRangeTool().inputSchema.safeParse({ start: '1:00' }).success, false, 'end is required');
});

test('the plain chat path reads the named moment and forwards hints to queued recordings (ai.js wiring)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');
  assert.match(src, /loadHistoryMediaTranscripts\(prisma, \{\s*userId: req\.user\?\.id, messages: historyMessages, query: prompt,/);
  assert.match(src, /forwardTranscriptionHints\?\.\(prisma, \{/);
  assert.equal((src.match(/capHistoryFileText\(f, /g) || []).length, 2, 'both history renderings use the media-aware cap');
  assert.match(src, /usa transcript_lookup \(por minuto o por palabras\)/);
});

// ── verifier fixes: clip clock, per-turn budget, rename vs refine ──────────

test('a moment before a link clip\'s start is out of range with the covered span, never an invalid range', async () => {
  const s = setup();
  const result = lectureResult();
  // A link stretch 01:00:00–01:30:00 stored on the recording's clock.
  result.timeOffsetSec = 3600;
  result.durationSec = 1800;
  result.segments = result.segments.slice(0, 60).map(seg => ({ ...seg, start: seg.start + 3600, end: seg.end + 3600 }));
  result.gaps = [];
  result.quality.lowConfidence = [];
  await s.write('clase1', 'u1', result);
  const tool = tools.buildTranscriptLookupTool(s.over);
  const early = await tool.execute({ start: '10:00' }, s.ctx());
  assert.equal(early.code, 'out_of_range', JSON.stringify(early));
  assert.match(early.userMessage, /^Esta transcripción cubre 01:00:00–01:30:00; ese minuto queda fuera\.$/);
  assert.equal((await tool.execute({ start: '10:00', end: '20:00' }, s.ctx())).code, 'out_of_range');
  const late = await tool.execute({ start: '2:00:00' }, s.ctx());
  assert.match(late.userMessage, /cubre 01:00:00–01:30:00/);
  const inside = await tool.execute({ start: '1:05:00' }, s.ctx());
  assert.equal(inside.ok, true);
});

test('retranscribe_range keeps a per-turn budget: no overlapping stretch, at most one hour per message', async () => {
  const s = setup();
  await s.write('clase1', 'u1', lectureResult());
  const queued = [];
  const refineDeps = { delivery: null, transcriptStore: s.store,
    enqueueRefine: async (payload) => { queued.push(payload.range); return { queued: true, jobId: `j${queued.length}` }; } };
  const tool = tools.buildRetranscribeRangeTool({ ...s.over, refineDeps });
  const ctx = s.ctx();
  assert.equal((await tool.execute({ start: '10:00', end: '40:00' }, ctx)).ok, true);
  const twice = await tool.execute({ start: '30:00', end: '35:00' }, ctx);
  assert.equal(twice.code, 'refine_already_queued');
  assert.equal((await tool.execute({ start: '40:00', end: '1:05:00' }, ctx)).ok, true);
  const over = await tool.execute({ start: '1:10:00', end: '1:20:00' }, ctx);
  assert.equal(over.code, 'refine_budget');
  assert.match(over.userMessage, /máximo una hora por mensaje/);
  assert.equal(queued.length, 2);
  // A new message (a new turn context) starts a new budget.
  assert.equal((await tool.execute({ start: '1:10:00', end: '1:20:00' }, s.ctx())).ok, true);
});

test('rename_speaker refuses while a refine of the file is queued or running', async () => {
  const s = setup();
  await s.write('clase1', 'u1', lectureResult());
  const pending = tools.buildRenameSpeakerTool({ ...s.over, refineInFlight: async ({ fileId, userId }) => fileId === 'clase1' && userId === 'u1' });
  const refused = await pending.execute({ from: 'Hablante 2', to: 'Dra. Rojas' }, s.ctx());
  assert.equal(refused.code, 'refine_in_progress');
  assert.match(refused.userMessage, /hay una corrección en curso/i);
  assert.equal((await s.store.readSidecar('clase1')).segments.filter(seg => seg.spk === 'Dra. Rojas').length, 0, 'nothing rewritten');
  // The delivery store's pending refine records count too.
  const delivery = { isMediaDeliveryEnabled: () => true,
    getMediaDeliveryService: () => ({ store: { findPendingByFile: async (fileId, { userId }) => (fileId === 'clase1' && userId === 'u1' ? [{ kind: 'refine' }] : []) } }) };
  assert.equal((await tools.buildRenameSpeakerTool({ ...s.over, delivery }).execute({ from: '2', to: 'Juan' }, s.ctx())).code, 'refine_in_progress');
  const transcriptOnly = { ...delivery, getMediaDeliveryService: () => ({ store: { findPendingByFile: async () => [{ kind: 'transcript' }] } }) };
  assert.equal((await tools.buildRenameSpeakerTool({ ...s.over, delivery: transcriptOnly }).execute({ from: '2', to: 'Juan' }, s.ctx())).ok, true);
  // A refine this turn queued blocks a rename in the same turn.
  const s2 = setup();
  await s2.write('clase1', 'u1', lectureResult());
  const ctx = s2.ctx();
  const refine = tools.buildRetranscribeRangeTool({ ...s2.over, refineDeps: { delivery: null, transcriptStore: s2.store,
    enqueueRefine: async () => ({ queued: true, jobId: 'j' }) } });
  assert.equal((await refine.execute({ start: '10:00', end: '12:00' }, ctx)).ok, true);
  assert.equal((await tools.buildRenameSpeakerTool(s2.over).execute({ from: '2', to: 'Juan' }, ctx)).code, 'refine_in_progress');
});
