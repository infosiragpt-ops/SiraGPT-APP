'use strict';

// Contract C7 — what the user tells the chat about a recording («está en
// inglés», «los nombres son Huamán, Ayacucho», «son 3 hablantes»,
// «transcripción literal») reaches the transcriber: the queue job, the
// durable delivery, the link hand-off and the runner's inline tool.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const batch = require('../src/services/media-batch');

test('extractTranscriptionHints understands language, names, speakers and «literal»', () => {
  assert.deepEqual(batch.extractTranscriptionHints('está en inglés, transcríbelo'), { terms: [], language: 'en' });
  assert.deepEqual(batch.extractTranscriptionHints('los nombres son Huamán, Ayacucho y Quispe'), { terms: ['Huamán', 'Ayacucho', 'Quispe'] });
  assert.equal(batch.extractTranscriptionHints('son 3 hablantes').speakers, 3);
  assert.equal(batch.extractTranscriptionHints('transcripción literal, por favor').verbatim, true);
  assert.equal(batch.extractTranscriptionHints('una transcripción limpia, sin muletillas').verbatim, false);
  assert.equal(batch.extractTranscriptionHints('el profesor y dos alumnos').speakers, 3);
  assert.equal(batch.extractTranscriptionHints('habla solo una persona').speakers, 1);
  assert.equal(batch.extractTranscriptionHints('it is in English, 2 speakers').language, 'en');
  assert.deepEqual(batch.extractTranscriptionHints('el profe se llama Ccori, no Kori').terms, ['Ccori']);
  assert.deepEqual(batch.extractTranscriptionHints('el Dr. Pérez explica la "ATP sintasa"').terms, ['Pérez', 'ATP sintasa']);
});

test('hints never invent: negations, translation targets and device ids are ignored', () => {
  // The source language, not the target: «al inglés» says nothing about the audio.
  assert.equal(batch.extractTranscriptionHints('tradúcelo al inglés').language, undefined);
  assert.equal(batch.extractTranscriptionHints('la clase que está en alemán tradúcela al inglés').language, 'de');
  assert.equal(batch.extractTranscriptionHints('no está en inglés, está en quechua').language, 'qu');
  // «traducción literal» describes the translation, not the transcript.
  assert.equal(batch.extractTranscriptionHints('tradúcelo, traducción literal').verbatim, undefined);
  // A WhatsApp voice-note id is never a glossary term.
  assert.deepEqual(batch.extractTranscriptionHints('nombres: WA0012, PTT-20261003, Machu Picchu').terms, ['Machu Picchu']);
  // The list stops where the instruction resumes.
  assert.deepEqual(batch.extractTranscriptionHints('los nombres son Huamán y Quispe, y transcribe literal').terms, ['Huamán', 'Quispe']);
  assert.deepEqual(batch.extractTranscriptionHints(''), { terms: [] });
  assert.deepEqual(batch.extractTranscriptionHints(null, null), { terms: [] });
});

test('the current request wins over earlier turns; terms of every turn are merged', () => {
  const hints = batch.extractTranscriptionHints('ahora transcríbelo, está en portugués', [
    'el audio es en inglés', 'son dos personas', { content: 'los nombres son Huamán y Rojas' },
  ]);
  assert.equal(hints.language, 'pt');
  assert.equal(hints.speakers, 2);
  assert.deepEqual(hints.terms, ['Huamán', 'Rojas']);
  assert.deepEqual(batch.hintsForJob(hints), { language: 'pt', hints: { terms: ['Huamán', 'Rojas'], speakers: 2 } });
  assert.deepEqual(batch.hintsForJob({ terms: [] }), { language: null, hints: null });
});

test('waitForMediaBatch sends the hints with every job it queues, and nothing extra without them', async () => {
  const rows = [{ id: 'f1', userId: 'u', originalName: 'a.mp3', mimeType: 'audio/mpeg', processingStage: 'uploaded', extractedText: null }];
  const prisma = { file: { findMany: async () => rows.map(row => ({ ...row, processingStage: 'ready', extractedText: 'hola' })) } };
  const enqueued = [];
  await batch.waitForMediaBatch({ prisma, userId: 'u', rows, enqueue: async (payload) => { enqueued.push(payload); return { queued: true }; },
    wait: async () => {}, language: 'en', hints: { terms: ['Huamán'], speakers: 2 } });
  assert.deepEqual(enqueued, [{ fileId: 'f1', userId: 'u', retry: false, language: 'en', hints: { terms: ['Huamán'], speakers: 2 } }]);
  const plain = [];
  await batch.waitForMediaBatch({ prisma, userId: 'u', rows, enqueue: async (payload) => { plain.push(payload); return { queued: true }; }, wait: async () => {} });
  assert.deepEqual(plain, [{ fileId: 'f1', userId: 'u', retry: false }]);
});

test('recent user turns are read owner-scoped and never throw', async () => {
  const prisma = {
    chat: { findFirst: async ({ where }) => (where.userId === 'u' && where.id === 'c' ? { id: 'c' } : null) },
    message: { findMany: async ({ where, take }) => { assert.equal(where.role, 'USER'); return [{ content: 'está en inglés' }, { content: 'hola' }].slice(0, take); } },
  };
  assert.deepEqual(await batch.loadRecentUserTurns(prisma, { userId: 'u', chatId: 'c' }), ['está en inglés', 'hola']);
  assert.deepEqual(await batch.loadRecentUserTurns(prisma, { userId: 'otro', chatId: 'c' }), []);
  assert.deepEqual(await batch.loadRecentUserTurns({ message: { findMany: async () => { throw new Error('db down'); } } }, { userId: 'u', chatId: 'c' }), []);
  assert.deepEqual(await batch.loadRecentUserTurns({}, { userId: 'u', chatId: 'c' }), []);
});

test('hints said in a plain chat turn reach only the recordings still in the queue', async () => {
  const { forwardTranscriptionHints } = require('../src/services/message-attachments');
  const rows = [
    { id: 'cola', userId: 'u', mimeType: 'audio/mpeg', originalName: 'cola.mp3', processingStage: 'extracting', extractedText: null },
    { id: 'lista', userId: 'u', mimeType: 'audio/mpeg', originalName: 'lista.mp3', processingStage: 'ready', extractedText: 'texto' },
  ];
  const prisma = { file: { findMany: async ({ where }) => rows.filter(row => where.id.in.includes(row.id) && row.userId === where.userId) } };
  const messages = [{ files: [{ id: 'cola', name: 'cola.mp3', mimeType: 'audio/mpeg' }, { id: 'lista', name: 'lista.mp3', mimeType: 'audio/mpeg' }] }];
  const enqueued = [];
  const count = await forwardTranscriptionHints(prisma, { userId: 'u', messages, prompt: 'está en inglés; los nombres son Huamán y Quispe',
    enqueue: async (payload) => { enqueued.push(payload); return { queued: true }; } });
  assert.equal(count, 1);
  assert.deepEqual(enqueued, [{ fileId: 'cola', userId: 'u', language: 'en', hints: { terms: ['Huamán', 'Quispe'] } }]);
  assert.equal(await forwardTranscriptionHints(prisma, { userId: 'u', messages, prompt: 'gracias', enqueue: async () => assert.fail('no hints, no job') }), 0);
});

// ── the runner's media branch (executed from the real source) ───────────────

function runMediaBranch(context) {
  const filename = path.resolve(__dirname, '../src/services/agents/agent-task-runner.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('    if (mediaBatchRows) {');
  const end = source.indexOf('    // ── Image-only analysis turn', start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(`(async () => { ${source.slice(start, end)} })()`, context, { filename });
}

function branchContext(overrides = {}) {
  const handoff = require('../src/services/media-handoff');
  return {
    loadMediaDeliveryService: () => null,
    mediaInlineWaitMs: handoff.mediaInlineWaitMs, shouldHandOffMediaWait: handoff.shouldHandOffMediaWait,
    estimateMediaBatchEta: handoff.estimateMediaBatchEta, totalProgressDuration: handoff.totalProgressDuration,
    mediaRowsForAnalysis: handoff.mediaRowsForAnalysis, describeTranscriptDownloads: handoff.describeTranscriptDownloads,
    process, console, assistantMessageId: null, model: 'deepseek-v4-flash',
    runtimeModelProfile: { runtimeModel: 'deepseek-v4-flash', runtimeProvider: 'DeepSeek' },
    prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [],
    backfillUserMessageFilesForTranscription: async () => {}, emit() {},
    controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
    saveArtifact: (artifact) => ({ id: 'a', filename: artifact.filename }), artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
    plainTranscriptionRequest: true, openai: {}, task: {}, documentPolicy: {},
    require: (name) => require(name === '../media-transcript-artifacts' ? '../src/services/media-transcript-artifacts' : name),
    throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
    ...overrides,
  };
}

test('the runner sends the turn\'s hints to the wait (jobs) and to the durable delivery', async () => {
  const rows = [{ id: 'clase', originalName: 'clase.mp4', processingStage: 'extracting', extractedText: null, size: 4e9 }];
  const waits = [];
  const created = [];
  const delivery = {
    isMediaDeliveryEnabled: () => true,
    estimateTranscriptionSeconds: ({ durationSec }) => Math.round(durationSec * 0.15),
    createDelivery: async (record) => { created.push(record); return { id: 'md_1', ...record }; },
    handOffMessage: () => 'Te aviso aquí.',
  };
  const goal = 'transcribe este video, está en inglés y los nombres son Huamán y Quispe, son 3 hablantes';
  const result = await runMediaBranch(branchContext({
    mediaBatchRows: rows, displayGoal: goal, goal,
    mediaBatch: { ...batch, waitForMediaBatch: async (options) => {
      waits.push(options);
      return { rows, total: 1, ready: 0, failed: 0, pending: 1, partial: 0, progress: { clase: { durationSeconds: 18000, completed: 1, total: 30 } }, stoppedEarly: true };
    } },
    loadMediaDeliveryService: () => delivery,
  }));
  assert.equal(result.stoppedReason, 'media_delivery_handoff');
  assert.equal(waits[0].language, 'en');
  assert.deepEqual(JSON.parse(JSON.stringify(waits[0].hints)), { terms: ['Huamán', 'Quispe'], speakers: 3 });
  assert.equal(created[0].language, 'en', 'the delivery carries the language instead of null');
  assert.deepEqual(JSON.parse(JSON.stringify(created[0].hints)), { terms: ['Huamán', 'Quispe'], speakers: 3 });
  assert.equal(result.metadata.mediaDeliveryHandoff, 'md_1');
});

// ── links and the runner's own tool ────────────────────────────────────────

test('the link hand-off keeps the title\'s accents and carries the language and glossary to the job', async () => {
  const tool = require('../src/services/agent-harness/tools/transcribe-url-tool');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hints-handoff-'));
  const clipPath = path.join(dir, 'clip.m4a');
  fs.writeFileSync(clipPath, 'aac');
  const created = [];
  const enqueued = [];
  const files = [];
  const services = {
    prisma: { file: { create: async ({ data }) => { const row = { id: 'f1', ...data }; files.push(row); return row; }, delete: async () => ({}) } },
    transcriptStore: { recordMediaClipOffset: async () => ({ ok: true }) },
    delivery: { isMediaDeliveryEnabled: () => true, createDelivery: async (record) => { created.push(record); return { id: 'md_2', ...record }; },
      handOffMessage: ({ fileNames }) => `Recibí «${fileNames[0]}».` },
    enqueueMediaTranscription: async (payload) => { enqueued.push(payload); return { queued: true }; },
  };
  const result = await tool.defaultDurableHandoff({ clipPath, title: 'Clase de Bioquímica: enzimas (Dr. Pérez)', url: new URL('https://www.youtube.com/watch?v=x'),
    rangeStart: 0, rangeEnd: null, spanSec: 7200, sectioned: false, subtitles: false, ctx: { userId: 'u1', chatId: 'c1' },
    env: { UPLOAD_DIR: path.join(dir, 'uploads') }, language: 'inglés', hints: { terms: ['Michaelis'] }, services });
  assert.equal(result.ok, true);
  assert.equal(files[0].originalName, 'Clase de Bioquímica enzimas (Dr. Pérez).m4a');
  assert.equal(created[0].language, 'en');
  assert.deepEqual(created[0].hints, { terms: ['Michaelis'] });
  assert.deepEqual(enqueued[0], { fileId: 'f1', userId: 'u1', timeOffsetSec: 0, language: 'en', hints: { terms: ['Michaelis'] } });
  assert.deepEqual(tool.titleTerms('Clase 12 · Bioquímica (Dr. Pérez) GMT20261003 1920x1080'), ['Bioquímica', 'Pérez']);
});

function fakeSandbox(files) {
  return {
    async readFile(rel) { if (!files[rel]) throw new Error('ENOENT'); return files[rel]; },
    async listFiles(dir) { return Object.keys(files).filter(f => path.posix.dirname(f) === dir).map(f => ({ path: f, size: files[f].length })); },
  };
}

test('transcribe_audio accepts every media container and passes the language and terms', async () => {
  const voice = require('../src/services/agent-runner/multimodal/voice');
  for (const name of ['nota.flac', 'clase.mkv', 'llamada.amr', 'video.avi', 'audio.aac', 'grabacion.3gp', 'x.wma']) {
    assert.ok(voice.audioMimeFor(name), name);
  }
  assert.equal(voice.audioMimeFor('informe.pdf'), null);
  const calls = [];
  const exec = voice.makeTranscribeAudioExecutor({
    sandbox: fakeSandbox({ 'uploads/nota.flac': Buffer.from('flac-bytes') }), env: {},
    probeDuration: async () => 42,
    transcribeImpl: async (filePath, mime, name, opts) => { calls.push({ mime, name, opts }); return { transcript: 'hello world', language: 'en', model: 'm' }; },
  });
  const out = await exec({ path: 'uploads/nota.flac', language: 'inglés', terms: ['Huamán', 'WA0012'] }, {});
  assert.match(out, /<transcripcion archivo="nota\.flac"/);
  assert.equal(calls[0].mime, 'audio/flac');
  assert.equal(calls[0].opts.language, 'en');
  assert.deepEqual(calls[0].opts.hints, { terms: ['Huamán'] });
});

test('a long workspace recording goes to the durable queue when the chat is known, and is refused honestly otherwise', async () => {
  const voice = require('../src/services/agent-runner/multimodal/voice');
  const files = { 'uploads/clase.mp4': Buffer.from('mp4-bytes') };
  const handed = [];
  const durable = voice.makeTranscribeAudioExecutor({
    sandbox: fakeSandbox(files), env: {}, owner: { userId: 'u1', chatId: 'c1' }, probeDuration: async () => 3 * 3600,
    durableHandoff: async (payload) => { handed.push({ ...payload, exists: fs.existsSync(payload.sourcePath) }); return { ok: true, fileId: 'f9', deliveryId: 'md_9', message: 'Te aviso aquí.' }; },
    transcribeImpl: async () => assert.fail('a 3-hour recording is never transcribed inside the runner turn'),
  });
  const res = JSON.parse(await durable({ path: 'uploads/clase.mp4', language: 'es' }, {}));
  assert.equal(res.deferred, true);
  assert.equal(res.delivery, 'md_9');
  assert.equal(res.userMessage, 'Te aviso aquí.');
  assert.equal(handed[0].exists, true, 'the staged copy exists while it is handed off');
  assert.equal(handed[0].originalName, 'clase.mp4');
  assert.equal(handed[0].language, 'es');
  assert.deepEqual(handed[0].ctx, { userId: 'u1', chatId: 'c1', taskId: null });
  const noOwner = voice.makeTranscribeAudioExecutor({ sandbox: fakeSandbox(files), env: {}, probeDuration: async () => 3 * 3600,
    transcribeImpl: async () => assert.fail('never inline') });
  assert.match(await noOwner({ path: 'uploads/clase.mp4' }, {}), /^ERROR: .*dura 3 h.*adjunte la grabación en el chat/);
  const tooBig = voice.makeTranscribeAudioExecutor({ sandbox: fakeSandbox(files), env: { SIRAGPT_RUNNER_AUDIO_MAX_BYTES: '4' } });
  assert.match(await tooBig({ path: 'uploads/clase.mp4' }, {}), /^ERROR: .*pesa/);
});

// ── verifier fixes: output language, stale turns, chat forwarding, wiring ──

test('a language that names the OUTPUT is never forced on the recording', () => {
  const none = [
    'resume la reunión en inglés',
    'hazme el acta de la reunión en inglés',
    'haz un resumen del audio en inglés',
    'dame los puntos clave de la clase en portugués',
    'quiero el video en inglés con subtítulos',
    'traduce el audio en inglés',
    'traduce el audio que está en inglés',
    'dame el resumen en idioma inglés',
    'quiero el acta, idioma: inglés',
    'the summary is in English',
    'los subtítulos están en inglés',
  ];
  for (const goal of none) assert.equal(batch.extractTranscriptionHints(goal).language, undefined, goal);
  // What the recording IS stays a source language.
  assert.equal(batch.extractTranscriptionHints('resume la clase que está en inglés').language, 'en');
  assert.equal(batch.extractTranscriptionHints('hazme el acta, está en inglés').language, 'en');
  assert.equal(batch.extractTranscriptionHints('la reunión está en inglés, hazme el acta').language, 'en');
  assert.equal(batch.extractTranscriptionHints('idioma: francés').language, 'fr');
  assert.equal(batch.extractTranscriptionHints('transcribe esto, idioma: inglés').language, 'en');
});

test('earlier turns about another recording lend names, never the language or the speaker count', async () => {
  const stale = 'transcribe esta entrevista, está en inglés, son 2 hablantes; los nombres son Huamán y Quispe';
  assert.deepEqual(batch.extractTranscriptionHints('transcríbelo', [stale], { historyTermsOnly: true }), { terms: ['Huamán', 'Quispe'] });
  // Turns are read only from the recordings' arrival on.
  const queries = [];
  const prisma = {
    chat: { findFirst: async () => ({ id: 'c' }) },
    message: { findMany: async (args) => { queries.push(args); return [{ content: 'transcríbelo' }]; } },
  };
  const since = new Date('2026-10-10T10:00:00Z');
  await batch.loadRecentUserTurns(prisma, { userId: 'u', chatId: 'c', since });
  assert.equal(queries[0].where.timestamp.gte.toISOString(), '2026-10-10T09:59:55.000Z');
  await batch.loadRecentUserTurns(prisma, { userId: 'u', chatId: 'c' });
  assert.equal(queries[1].where.timestamp, undefined);
  assert.equal(batch.earliestRowTime([{ createdAt: '2026-10-10T11:00:00Z' }, { createdAt: since }, {}]).toISOString(), since.toISOString());
  assert.equal(batch.earliestRowTime([{ id: 'x' }]), null);
});

test('the runner never forces a stale «está en inglés» on a new Spanish recording', async () => {
  const createdAt = new Date('2026-10-10T10:00:00Z');
  const rows = [{ id: 'nueva', originalName: 'clase.mp3', processingStage: 'extracting', extractedText: null, size: 1e6, createdAt }];
  const waits = [];
  const turnQueries = [];
  const prisma = {
    chat: { findFirst: async () => ({ id: 'chat' }) },
    message: { findMany: async ({ where }) => {
      turnQueries.push(where);
      // Only turns at or after the upload are returned by the database.
      const all = [{ at: new Date('2026-10-10T10:00:30Z'), content: 'transcríbelo' },
        { at: new Date('2026-10-09T08:00:00Z'), content: 'transcribe esta entrevista, está en inglés, son 2 hablantes' }];
      return all.filter(turn => !where.timestamp || turn.at >= where.timestamp.gte).map(turn => ({ content: turn.content }));
    } },
  };
  await runMediaBranch(branchContext({
    prisma, mediaBatchRows: rows, displayGoal: 'transcríbelo', goal: 'transcríbelo',
    mediaBatch: { ...batch, waitForMediaBatch: async (options) => { waits.push(options); return { rows, total: 1, ready: 0, failed: 0, pending: 1, partial: 0, progress: {} }; } },
  }));
  assert.equal(turnQueries[0].timestamp.gte.toISOString(), '2026-10-10T09:59:55.000Z');
  assert.equal(waits[0].language, null, 'no language from a turn about another recording');
  assert.equal(waits[0].hints, null);
});

test('a plain chat turn forwards hints to THIS turn\'s queued recording, and an unrelated quote never becomes a term', async () => {
  const { forwardTranscriptionHints } = require('../src/services/message-attachments');
  const rows = [{ id: 'nueva', userId: 'u', mimeType: 'audio/mpeg', originalName: 'nueva.mp3', processingStage: 'uploaded', extractedText: null }];
  const prisma = { file: { findMany: async ({ where }) => rows.filter(row => where.id.in.includes(row.id) && row.userId === where.userId) } };
  const enqueued = [];
  const enqueue = async (payload) => { enqueued.push(payload); return { queued: true }; };
  const count = await forwardTranscriptionHints(prisma, { userId: 'u', messages: [], prompt: 'los nombres son Huamán y Quispe',
    currentFiles: [{ id: 'nueva', name: 'nueva.mp3', mimeType: 'audio/mpeg', extractedText: null }], enqueue });
  assert.equal(count, 1, 'the recording attached in this turn gets the hints');
  assert.deepEqual(enqueued[0], { fileId: 'nueva', userId: 'u', hints: { terms: ['Huamán', 'Quispe'] } });
  const history = [{ files: [{ id: 'nueva', name: 'nueva.mp3', mimeType: 'audio/mpeg' }] }];
  assert.equal(await forwardTranscriptionHints(prisma, { userId: 'u', messages: history, prompt: 'Escribe un poema sobre «la luna»',
    enqueue: async () => assert.fail('a quoted fragment of an unrelated turn is never a term') }), 0);
  assert.equal(await forwardTranscriptionHints(prisma, { userId: 'u', messages: history, prompt: 'el documento está en inglés',
    enqueue: async () => assert.fail('another subject\'s language is not the recording\'s') }), 0);
  assert.deepEqual(batch.extractChatTranscriptionHints('el audio está en inglés; el profe dijo "Michaelis"'), { terms: ['Michaelis'], language: 'en' });
  const { mediaInTurnOrHistory } = require('../src/services/message-attachments');
  assert.equal(mediaInTurnOrHistory({ files: [{ id: 'a', mimeType: 'video/mp4', name: 'clase.mp4' }] }), true);
  assert.equal(mediaInTurnOrHistory({ messages: [{ files: [{ id: 'd', mimeType: 'application/pdf', name: 'x.pdf' }] }] }), false);
  const ai = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');
  assert.match(ai, /forwardTranscriptionHints\?\.\(prisma, \{\s*userId: req\.user\?\.id, messages: historyMessages, prompt, currentFiles: processedFiles,/);
  assert.match(ai, /mediaTranscript: __mediaTranscriptTurn,/);
});

test('the runner wiring hands a long workspace recording to the durable queue (owner threaded through F7)', async () => {
  const runnerSrc = fs.readFileSync(path.join(__dirname, '../src/services/agent-runner/index.js'), 'utf8');
  assert.match(runnerSrc, /owner: userId && chatId \? \{ userId, chatId \} : null,/);
  const { prepareF7Extras } = require('../src/services/agent-runner/multimodal');
  const probe = require('../src/services/media-probe');
  const urlTool = require('../src/services/agent-harness/tools/transcribe-url-tool');
  const originalProbe = probe.probeMediaStreams;
  const originalHandOff = urlTool.handOffMediaFile;
  const handed = [];
  probe.probeMediaStreams = async () => ({ ok: true, durationSec: 25 * 60 });
  urlTool.handOffMediaFile = async (payload) => { handed.push(payload); return { ok: true, fileId: 'f1', deliveryId: 'md_1', message: 'Te aviso aquí.' }; };
  try {
    const f7 = prepareF7Extras({ files: [], sandbox: fakeSandbox({ 'uploads/clase.m4a': Buffer.from('m4a') }),
      env: { NODE_ENV: 'test', SIRAGPT_AGENT_VOICE: '1', SIRAGPT_AGENT_VISION: '0', SIRAGPT_AGENT_COMPUTER: '0' }, owner: { userId: 'u1', chatId: 'c1' } });
    const res = JSON.parse(await f7.executors.transcribe_audio({ path: 'uploads/clase.m4a' }, {}));
    assert.equal(res.deferred, true, 'a 25-min recording never runs inside the 6–8 min runner turn');
    assert.deepEqual(handed[0].ctx, { userId: 'u1', chatId: 'c1', taskId: null });
    const noOwner = prepareF7Extras({ files: [], sandbox: fakeSandbox({ 'uploads/clase.m4a': Buffer.from('m4a') }),
      env: { NODE_ENV: 'test', SIRAGPT_AGENT_VOICE: '1', SIRAGPT_AGENT_VISION: '0', SIRAGPT_AGENT_COMPUTER: '0' } });
    assert.ok(noOwner.executors.transcribe_audio, 'still offered without an owner (short recordings run inline)');
  } finally {
    probe.probeMediaStreams = originalProbe;
    urlTool.handOffMediaFile = originalHandOff;
  }
});
