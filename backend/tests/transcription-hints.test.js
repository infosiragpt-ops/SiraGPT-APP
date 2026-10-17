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
  assert.match(runnerSrc, /owner: userId && chatId \? \{ userId, chatId, staged: stagedUploads \} : null,/);
  assert.match(runnerSrc, /else if \(f\.fileId\) stagedUploads\.push\(\{ rel: `uploads\/\$\{name\}`, fileId: String\(f\.fileId\) \}\);/,
    'each staged attachment is recorded with its File in the staging loop');
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

// ── second review: output-subject languages, chat subjects, staged files, lists ──

test('a language said about the bad transcript is never forced on the recording', () => {
  const goal = 'Vuelve a transcribir el audio, la transcripción está en inglés pero el audio es en español';
  assert.equal(batch.extractTranscriptionHints(goal).language, 'es');
  assert.equal(batch.hintsForJob(batch.extractTranscriptionHints(goal)).language, 'es');
  assert.equal(batch.extractChatTranscriptionHints('la transcripción está en inglés pero el audio es en español').language, 'es');
  assert.equal(batch.extractTranscriptionHints('the transcript is in English but the audio is in Spanish').language, 'es');
  // A lead-in «que» introduces the statement: its subject is still the transcript.
  for (const said of ['Vuelve a transcribir el audio, creo que la transcripción está en inglés pero el audio es en español',
    'me parece que la transcripción está en inglés pero el audio es en español',
    'veo que la transcripción está en inglés, el audio es en español',
    'lo que transcribiste está en inglés pero el audio es en español',
    'Vuelve a transcribir, está en inglés pero el audio es en español',
    'I think that the transcript is in English but the audio is in Spanish']) {
    assert.equal(batch.extractTranscriptionHints(said).language, 'es', said);
    // A refine's language stays with the refine: a plain chat turn never
    // forwards it to the other recordings still in the queue.
    assert.equal(batch.extractChatTranscriptionHints(said).language, batch.detectMediaFollowupIntent(said)?.kind === 'refine' ? undefined : 'es', said);
  }
  for (const said of ['la transcripción está en inglés', 'la transcripción que me diste está en inglés', 'lo que me diste está en inglés',
    'el resultado está en inglés, vuelve a transcribirlo', 'creo que la transcripción está en inglés']) {
    assert.equal(batch.extractTranscriptionHints(said).language, undefined, said);
  }
  // A relative clause still describes the recording it follows; a lead-in
  // before the recording keeps it.
  assert.equal(batch.extractTranscriptionHints('dame la transcripción del audio que está en inglés').language, 'en');
  assert.equal(batch.extractTranscriptionHints('ya te dije que el audio está en inglés').language, 'en');
  assert.equal(batch.extractTranscriptionHints('creo que el audio que te mandé está en inglés').language, 'en');
  // Two recordings in two languages: none is forced on both.
  assert.equal(batch.extractTranscriptionHints('el audio 1 está en inglés, el audio 2 está en portugués').language, undefined);
  // Nor one recording in two (Whisper forced to English would translate the Spanish parts).
  for (const said of ['el audio está en inglés y español', 'hablan en inglés y en español', 'está en inglés o portugués, no sé',
    'el audio está en inglés/español', 'the audio is in English and Spanish']) {
    assert.equal(batch.extractTranscriptionHints(said).language, undefined, said);
    assert.equal(batch.extractChatTranscriptionHints(said).language, undefined, said);
  }
  assert.equal(batch.extractTranscriptionHints('el audio está en inglés y no entiendo nada').language, 'en');
  // «porque / ya que / pues / because / since» and «donde / where» start the
  // recording's own statement: the transcript named before never claims it.
  for (const said of ['quiero la transcripción porque el audio está en inglés', 'necesito la transcripción ya que el audio está en inglés',
    'necesito la transcripción del video pues está en inglés', 'haz la transcripción del video donde hablan en inglés',
    'transcripción de un audio donde hablan en inglés', 'I need the transcript because the audio is in English',
    'I need the transcript since the audio is in English', 'dame la transcripción, porque la clase es en inglés']) {
    assert.equal(batch.extractTranscriptionHints(said).language, 'en', said);
  }
  assert.equal(batch.extractTranscriptionHints('la transcripción está en inglés porque el audio es en español').language, 'es');
  // The language to reply in, a place or how an event went is never the recording's language.
  for (const said of ['transcribe the audio and speak in Spanish to me', 'transcribe; then speak in English',
    'vuelve a transcribir del minuto 10 al 15, se escuchó mal; la reunión fue en Alemania', 'resume la conferencia, fue en Alemania',
    'transcribe la entrevista que fue en Alemania el año pasado']) {
    assert.equal(batch.hintsForJob(batch.extractTranscriptionHints(said)).language, null, said);
  }
  // A statement whose subject is the transcript stays out, whatever follows it.
  for (const said of ['la transcripción del audio está en inglés', 'pues la transcripción está en inglés',
    'la transcripción está en inglés porque sí']) {
    assert.equal(batch.extractTranscriptionHints(said).language, undefined, said);
  }
  // A statement with no subject of its own after the conjunction is still
  // about the transcript the clause started with: never a whole refine
  // forced to English on a Spanish recording.
  for (const said of ['la transcripción no sirve porque está en inglés',
    'Vuelve a transcribir el audio, la transcripción no sirve porque está en inglés',
    'la transcripción salió mal porque está en inglés', 'vuelve a transcribirlo, la transcripción está mal ya que está en inglés',
    'the transcript is useless because it is in English', 'the transcript is wrong since it is in English',
    'lo que me diste no sirve porque está en inglés', 'la transcripción no sirve pues está en inglés',
    'el texto que me pasaste no sirve porque está en inglés', 'la transcripción salió mal y está en inglés',
    'los subtítulos no me sirven porque están en inglés', 'creo que la transcripción no sirve porque todo está en inglés',
    'la transcripción está lista pero está en inglés']) {
    assert.equal(batch.hintsForJob(batch.extractTranscriptionHints(said)).language, null, said);
    assert.equal(batch.extractChatTranscriptionHints(said).language, undefined, said);
  }
  // Its own subject, an output noun as the object, or people speaking: the recording's language.
  for (const said of ['la transcripción no sirve porque el audio está en inglés', 'transcribe el audio porque está en inglés y no entiendo',
    'hazme la transcripción, ya que está en inglés', 'la transcripción está mal porque hablan en inglés',
    'the transcript is wrong because they speak in English', 'dame la transcripción del video donde hablan en inglés',
    'resume el video donde hablan en inglés']) {
    assert.equal(batch.extractTranscriptionHints(said).language, 'en', said);
  }
  assert.equal(batch.extractTranscriptionHints('la transcripción no sirve porque está en inglés y el audio es en español').language, 'es');
  // Only a clause that SAYS something about the output claims the reason
  // after it: asking for the transcript («la transcripción del video porque
  // está en inglés», «subtitula el video ya que…») keeps the recording's
  // language, in the media turn and in a plain chat turn.
  for (const said of ['transcripción del audio porque está en inglés', 'la transcripción del video porque está en inglés',
    'transcripción porque está en inglés', 'transcripción literal porque está en inglés',
    'la transcripción la necesito hoy porque está en inglés', 'la transcripción del audio la necesito porque está en inglés',
    'la transcripción en word porque está en inglés', 'transcript please because it is in English',
    'necesito la transcripción del video pues está en inglés', 'hazme la transcripción, ya que está en inglés',
    'la transcripción de esta clase porque está en inglés']) {
    assert.equal(batch.hintsForJob(batch.extractTranscriptionHints(said)).language, 'en', said);
    assert.equal(batch.extractChatTranscriptionHints(said).language, 'en', said);
  }
  for (const said of ['texto completo porque está en inglés', 'subtitula el video ya que está en inglés']) {
    assert.equal(batch.hintsForJob(batch.extractTranscriptionHints(said)).language, 'en', said);
  }
  // …and a comma before the conjunction changes nothing.
  for (const said of ['la transcripción no sirve, porque está en inglés', 'la transcripción salió mal, y está en inglés',
    'the transcript is useless, because it is in English']) {
    assert.equal(batch.hintsForJob(batch.extractTranscriptionHints(said)).language, null, said);
    assert.equal(batch.extractChatTranscriptionHints(said).language, undefined, said);
  }
  // A contrast with the output's own language is the recording's.
  for (const said of ['la transcripción está en inglés pero es en español', 'la transcripción salió en inglés pero es en español',
    'la transcripción está en inglés, pero es en español', 'la transcripción está en inglés cuando el audio es en español',
    'la transcripción está en inglés siendo que el audio es en español', 'the transcript is in English but it is in Spanish']) {
    assert.equal(batch.extractTranscriptionHints(said).language, 'es', said);
  }
  for (const said of ['la transcripción no sirve pero está en inglés', 'la transcripción está en inglés y es en inglés']) {
    assert.equal(batch.extractTranscriptionHints(said).language, undefined, said);
  }
});

// What a plain chat turn says, as a grid: about the queued recording itself
// (its language reaches it) or about something else (nothing is forced).
const RECORDING_LANGUAGE_STATEMENTS = Object.freeze([
  'está en inglés', 'todo está en inglés', 'la clase está en inglés', 'todo el audio está en inglés',
  'ojo, la grabación está en inglés', 'la clase de hoy está en inglés', 'el audio está en inglés; el profe dijo "Michaelis"',
  'subtitula el video que está en inglés', 'por cierto, el audio fue grabado en inglés', 'todos los audios están en inglés',
  'el archivo de audio está en inglés', 'the recording is in English', 'el audio está grabado en inglés',
  // which recording: a relative clause, a number, an order, a modifier, a complement
  'el audio que te acabo de mandar está en inglés', 'el video que te mandé hace rato está en inglés',
  'los dos audios están en inglés', 'las tres grabaciones están en inglés', 'el segundo audio está en inglés',
  'el audio nuevo está en inglés', 'el audio número 2 está en inglés', 'ambos audios están en inglés',
  'el audio de la clase de ayer está en inglés', 'la grabación de la reunión del lunes está en inglés',
  // a lead-in clause before the recording
  'olvidé decirte que el audio está en inglés', 'te comento que la clase está en inglés',
  'quería avisarte que los audios están en inglés', 'ah, y el último video está en inglés',
  // someone heard in the recording
  'en el audio el profesor habla en inglés', 'la profesora del audio habla en inglés', 'en el video hablan en inglés',
  'en el video de ayer hablan en inglés', 'el chico en el video habla en inglés',
  // longer lead-ins and complements, as people write them
  'se me olvidó decirte que el audio está en inglés', 'me olvidé de decirte que el audio está en inglés',
  'no te había dicho que el audio está en inglés', 'lo que pasa es que el audio está en inglés',
  'lo que te quería decir es que el audio está en inglés', 'el problema es que el audio está en inglés',
  'el audio número dos está en inglés', 'el audio que te mandé por whatsapp hace un rato está en inglés',
  'el audio que te acabo de subir hace un momento está en inglés', 'el audio de mi clase de biología del lunes está en inglés',
  'el audio de la reunión con el cliente de ayer está en inglés', 'la persona del audio habla en inglés', 'el señor del video habla en inglés',
  // what is heard in it: its speech, the people in it, most of it
  'la voz del audio es en inglés', 'las voces del video están en inglés', 'la conversación del audio está en inglés',
  'el diálogo del video está en inglés', 'la narración del audio está en inglés', 'la entrevista del audio está en inglés',
  'el que habla en el audio habla en inglés', 'los que hablan en el video hablan en inglés',
  'la persona que habla en el audio habla en inglés', 'lo que dicen en el audio está en inglés', 'lo que se dice en el video está en inglés',
  'en el audio la mayoría habla en inglés', 'en el video mi jefe habla en inglés', 'en la grabación el cliente habla en inglés',
  'el jefe del audio habla en inglés', 'las dos personas del audio hablan en inglés', 'olvidé decirte que la voz del audio es en inglés',
  'en todos los audios hablan en inglés', 'en ambos audios hablan en inglés', 'en cada audio hablan en inglés',
  'casi todo el audio está en inglés', 'la mayor parte del audio está en inglés', 'todo lo del audio está en inglés',
  'el contenido del audio está en inglés', 'el audio en realidad está en inglés', 'el audio en sí está en inglés',
  'el audio por cierto está en inglés', 'los audios están todos en inglés',
  // the recording introduced, then what is said about it
  'tengo un audio que está en inglés', 'te mandé el audio y está en inglés', 'te mandé el audio, y está en inglés',
  'subí la grabación pero está en inglés', 'ahí te paso el audio y ojo que está en inglés', 'te acabo de mandar el video y todo está en inglés',
  'es un audio de mi clase y está en inglés', 'es una grabación de 2 horas y está en inglés', 'es un audio donde hablan en inglés',
  'tengo un video en el que hablan en inglés', 'el audio está bien pero está en inglés', 'el audio 1 y el 2 están en inglés',
  'tengo dos audios, el primero está en inglés', 'mi jefe dice que el audio está en inglés', 'el audio fue en inglés',
  'mi clase fue grabada en inglés', 'olvidé decirte que mi reunión está grabada en inglés',
  'en el audio, el profesor habla en inglés', 'el video que te mandé, la profesora habla en inglés',
  'en el video que te mandé mi jefe habla en inglés', 'en el audio, todo está en inglés',
  'no sé, pero está en inglés', 'ya lo subí y está en inglés',
  // English
  'the second audio is in English', 'the speaker in the video speaks in English', 'the audio I sent you is in English',
  'btw the audio is in English', 'my audio is in English', 'the audio from yesterday is in English',
  'the audio of the meeting is in English', 'here is the audio and it is in English', 'fyi the audio is in English',
  'the people in the video speak in English', 'they speak in English in the audio', 'the recordings are in English',
]);
const OTHER_LANGUAGE_STATEMENTS = Object.freeze([
  'el examen es en inglés, ayúdame a prepararlo', 'mi profesor habla en inglés, ¿cómo mejoro?',
  'mi jefe habla en inglés y no entiendo nada', 'mi jefe habla en inglés en las reuniones y no entiendo nada',
  'el examen de la clase es en inglés, ayúdame a prepararlo', 'el examen es en inglés y dura 90 minutos, ayúdame a prepararlo',
  'el documento está en inglés', 'el archivo está en inglés', 'la tarea de la clase es en inglés',
  'en las reuniones mi jefe habla en inglés', 'en la clase mi profesor habla en inglés', 'el profesor de la clase habla en inglés y no entiendo',
  // a lead-in or a relative clause never makes another subject the recording
  'el examen que tengo es en inglés', 'mi jefe que habla en inglés me pidió el audio',
  'olvidé decirte que el examen es en inglés', 'te comento que mi jefe habla en inglés',
  // a part of the recording that is not its speech, or another subject after it
  'el título del video está en inglés', 'la tarea del audio es en inglés, ayúdame', 'el audio está bien pero mi jefe habla en inglés',
  'la música del video está en inglés pero hablan en español', 'las diapositivas del video están en inglés',
  'el ensayo del audio es en inglés, ayúdame a escribirlo', 'las preguntas del video son en inglés', 'el guion del video está en inglés',
  'la canción del video está en inglés', 'el link del video está en inglés', 'la página del video está en inglés',
  'en el video el título está en inglés', 'en el video las diapositivas están en inglés', 'en el video la música está en inglés',
  'el audio que te mandé está bien pero mi jefe habla en inglés', 'the title of the video is in English',
  // an event still to come is not the recording, with or without a lead-in
  'mi próxima clase es en inglés, ayúdame a prepararme', 'la nueva clase es en inglés', 'la otra llamada es en inglés',
  'la siguiente clase es en inglés', 'la reunión que tengo con mi jefe es en inglés', 'olvidé decirte que mi próxima clase es en inglés',
  'te comento que mi clase de mañana es en inglés', 'resulta que la reunión del lunes es en inglés',
  // a lead-in or a relative before something else
  'el examen que sale del audio es en inglés', 'la tarea que hice del video es en inglés', 'mi jefe dice que el examen es en inglés',
  'el problema es que mi jefe habla en inglés', 'lo que pasa es que el examen es en inglés',
  // what the recording says, not its language
  'el audio dice que el examen es en inglés', 'el video explica que el examen es en inglés', 'el audio menciona que la clase es en inglés',
  'el audio de mi jefe dice que todos hablan en inglés', 'el audio que me mandó mi jefe dice que la reunión es en inglés',
  // the user's own courses and meetings, or one still to come
  'mi clase del jueves es en inglés', 'todas mis clases son en inglés', 'en mis clases hablan en inglés', 'en mi clase hablan en inglés',
  'mis clases de la maestría son en inglés', 'la clase del lunes que viene es en inglés', 'la clase de mañana es en inglés',
  'mi última entrevista fue en inglés', 'mi primera reunión es en inglés',
  // a part of the recording only, someone not heard in it, a part that is not speech
  'la primera parte del audio está en inglés', 'el resto del audio está en inglés', 'el inicio del video está en inglés',
  'el que hizo el video habla en inglés', 'en el video la canción de fondo es en inglés', 'en el audio hay una canción que está en inglés',
  'la canción del video habla en inglés', 'en el video la canción habla en inglés', 'la música del video fue grabada en inglés',
  'el video del curso: el examen es en inglés', 'en el video, la música está en inglés', 'te mandé el audio, mi jefe habla en inglés',
  'en el video que te mandé el examen es en inglés', 'el audio está bien, mi jefe habla en inglés',
  'el examen es difícil y está en inglés', 'mi jefe dice que sí, pero está en inglés',
  // a statement that continues another subject, or one still unnamed
  'el examen es mañana, y está en inglés', 'la música del video es buena, pero está en inglés', 'te mandé el audio y mi jefe habla en inglés',
  'subí el audio pero el examen está en inglés', 'tengo dos clases, la primera es en inglés', 'tengo dos exámenes, el primero es en inglés',
  'necesito ayuda con el examen porque está en inglés', 'el resumen del audio está en inglés',
  'I need to speak in English tomorrow', 'my boss speaks in English', 'the music in the video is in English',
  // a place is no language; where or how an event went is not the recording's language
  'la conferencia fue en Alemania', 'la reunión de ayer fue en Alemania', 'the video was in Germany', 'the speakers are in Germany',
  'the people in the video are in Germany', 'la clase de ayer fue en inglés, ¿me explicas el tema?',
  'la entrevista de trabajo que tuve fue en inglés', 'las clases del semestre pasado fueron en inglés',
  'la llamada de ayer fue en inglés y no entendí nada',
  // the language to reply in, never the recording's
  'speak in English please', 'please, speak in English', 'ok, speak in English', 'the audio is ready? speak in English please',
  // a recording named in another sentence does not frame the next one
  'el audio que te mandé. Mi jefe habla en inglés, ¿cómo le respondo?', 'el audio nuevo. Mi profesor habla en inglés',
  '¿y el audio? Mi jefe habla en inglés', 'el audio: mi jefe habla en inglés',
]);

test('a plain chat turn about something else never forwards a language to a queued recording', async () => {
  const { forwardTranscriptionHints } = require('../src/services/message-attachments');
  const rows = [{ id: 'clase', userId: 'u', mimeType: 'audio/mpeg', originalName: 'clase.mp3', processingStage: 'extracting', extractedText: null }];
  const prisma = { file: { findMany: async ({ where }) => rows.filter(row => where.id.in.includes(row.id) && row.userId === where.userId) } };
  const messages = [{ files: [{ id: 'clase', name: 'clase.mp3', mimeType: 'audio/mpeg' }] }];
  // A word like «clase», «minutos» or «reuniones» does not make the turn about the recording.
  for (const prompt of OTHER_LANGUAGE_STATEMENTS) {
    assert.equal(batch.extractChatTranscriptionHints(prompt).language, undefined, prompt);
    assert.equal(await forwardTranscriptionHints(prisma, { userId: 'u', messages, prompt,
      enqueue: async () => assert.fail(`«${prompt}» is not about the recording`) }), 0, prompt);
  }
  // A statement with no subject of its own, or about the recording itself,
  // still reaches the queued recording.
  for (const prompt of RECORDING_LANGUAGE_STATEMENTS) {
    const enqueued = [];
    assert.equal(await forwardTranscriptionHints(prisma, { userId: 'u', messages, prompt,
      enqueue: async (payload) => { enqueued.push(payload); return { queued: true }; } }), 1, prompt);
    assert.equal(enqueued[0].language, 'en', prompt);
  }
});

test('an earlier chat turn about something else never lends its language to the next media turn', () => {
  // recentUserTurns holds the turns since the recording arrived; a chat turn
  // in between («el examen es en inglés…») is not about it.
  const current = '¿ya está lista la transcripción de la clase? resúmela';
  for (const earlier of OTHER_LANGUAGE_STATEMENTS) {
    assert.equal(batch.hintsForJob(batch.extractTranscriptionHints(current, [earlier, 'transcribe esta clase'])).language, null, earlier);
  }
  // A statement about the recording, or with no subject of its own, still counts.
  for (const earlier of [...RECORDING_LANGUAGE_STATEMENTS, 'el audio es en inglés']) {
    assert.equal(batch.hintsForJob(batch.extractTranscriptionHints(current, [earlier])).language, 'en', earlier);
  }
  assert.equal(batch.extractChatTranscriptionHints('la clase está hablada en quechua').language, 'qu');
});

test('a bare «reintenta» never inherits the language given for an earlier refine window', () => {
  // The newest user turn is the current one (already stored); the refine
  // turn before it named the language of its window only.
  for (const refine of ['revisa del minuto 12 al 15, está en inglés', 'vuelve a transcribir del minuto 10 al 15, el audio está en inglés',
    'el minuto 12 se escuchó mal, está en inglés', 'revisa el minuto 40 de la transcripción, está en portugués',
    'vuelve a transcribir el audio, está en inglés']) {
    assert.equal(batch.detectMediaFollowupIntent(refine)?.kind, 'refine', refine);
    const hints = batch.extractTranscriptionHints('reintenta', ['reintenta', `${refine}; los nombres son Huamán y Quispe`, 'transcribe esta clase']);
    assert.equal(batch.hintsForJob(hints).language, null, refine);
    // Names, speakers and «literal» still hold for the whole recording.
    assert.deepEqual(hints.terms, ['Huamán', 'Quispe'], refine);
  }
  // A statement about the whole recording still reaches the retry.
  assert.equal(batch.hintsForJob(batch.extractTranscriptionHints('reintenta', ['reintenta', 'el audio está en inglés'])).language, 'en');
  // The refine turn itself keeps its language for its own job.
  assert.equal(batch.extractTranscriptionHints('revisa del minuto 12 al 15, está en inglés').language, 'en');
});

test('a refine said in a plain chat turn never forwards its language to another queued recording', async () => {
  const { forwardTranscriptionHints } = require('../src/services/message-attachments');
  const rows = [
    { id: 'clase', userId: 'u', mimeType: 'audio/mpeg', originalName: 'clase.mp3', processingStage: 'ready', extractedText: 'texto' },
    { id: 'otra', userId: 'u', mimeType: 'audio/mpeg', originalName: 'otra.mp3', processingStage: 'extracting', extractedText: null },
  ];
  const prisma = { file: { findMany: async ({ where }) => rows.filter(row => where.id.in.includes(row.id) && row.userId === where.userId) } };
  const messages = [{ files: [{ id: 'clase', name: 'clase.mp3', mimeType: 'audio/mpeg' }, { id: 'otra', name: 'otra.mp3', mimeType: 'audio/mpeg' }] }];
  for (const prompt of ['revisa del minuto 12 al 15 de clase.mp3, está en inglés', 'vuelve a transcribir del minuto 10 al 15, el audio está en inglés',
    'el minuto 12 se escuchó mal, está en inglés']) {
    assert.equal(batch.detectMediaFollowupIntent(prompt)?.kind, 'refine', prompt);
    assert.equal(await forwardTranscriptionHints(prisma, { userId: 'u', messages, prompt,
      enqueue: async () => assert.fail(`«${prompt}» is about the refined window, never otra.mp3`) }), 0, prompt);
    // Names, speakers and «literal» still reach it.
    const enqueued = [];
    assert.equal(await forwardTranscriptionHints(prisma, { userId: 'u', messages, prompt: `${prompt}; los nombres son Huamán y Quispe`,
      enqueue: async (payload) => { enqueued.push(payload); return { queued: true }; } }), 1, prompt);
    assert.deepEqual(enqueued, [{ fileId: 'otra', userId: 'u', hints: { terms: ['Huamán', 'Quispe'] } }], prompt);
  }
  // A plain statement about the recording still reaches it.
  const enqueued = [];
  assert.equal(await forwardTranscriptionHints(prisma, { userId: 'u', messages, prompt: 'el audio está en inglés',
    enqueue: async (payload) => { enqueued.push(payload); return { queued: true }; } }), 1);
  assert.equal(enqueued[0].language, 'en');
});

test('a glossary after «son:» keeps no separator in its first term', () => {
  assert.deepEqual(batch.extractTranscriptionHints('los nombres son: Pérez y Quispe').terms, ['Pérez', 'Quispe']);
  assert.deepEqual(batch.extractTranscriptionHints('transcribe el audio, las palabras clave son: ATP, ADN, mitocondria').terms, ['ATP', 'ADN', 'mitocondria']);
  assert.deepEqual(batch.extractChatTranscriptionHints('los nombres son: Pérez y Quispe').terms, ['Pérez', 'Quispe']);
});

test('transcribe_audio on a long STAGED attachment reuses its File and job, never copies it', async () => {
  const voice = require('../src/services/agent-runner/multimodal/voice');
  const files = { 'uploads/clase.mp3': Buffer.from('mp3-bytes'), 'outputs/descarga.mp3': Buffer.from('mp3-bytes') };
  const created = [];
  const enqueued = [];
  const copied = [];
  const services = {
    delivery: { isMediaDeliveryEnabled: () => true, createDelivery: async (record) => { created.push(record); return { id: 'md_s', ...record }; },
      estimateTranscriptionSeconds: ({ durationSec }) => Math.round(durationSec * 0.15),
      handOffMessage: ({ fileNames }) => `Recibí «${fileNames[0]}». Te aviso aquí.` },
    enqueueMediaTranscription: async (payload) => { enqueued.push(payload); return { id: payload.fileId, queued: true }; },
  };
  // The model may name the file by its absolute workspace path.
  const base = fakeSandbox(files);
  const sandbox = { ...base, readFile: async (rel) => base.readFile(String(rel).replace(/^\/workspace\//, '')) };
  const exec = voice.makeTranscribeAudioExecutor({
    sandbox, env: {}, probeDuration: async () => 3600,
    owner: { userId: 'u1', chatId: 'c1', staged: [{ rel: 'uploads/clase.mp3', fileId: 'f-upload' }] },
    durableHandoff: async (payload) => { copied.push(payload.originalName); return { ok: true, fileId: 'f-copy', deliveryId: 'md_c', message: 'copia' }; },
    stagedHandoff: (payload) => voice.defaultStagedHandoff({ ...payload, services }),
    transcribeImpl: async () => assert.fail('a 60-min recording is never transcribed inside the runner turn'),
  });
  const res = JSON.parse(await exec({ path: '/workspace/uploads/clase.mp3', language: 'español', terms: ['Huamán'] }, {}));
  assert.equal(res.deferred, true);
  assert.equal(res.fileId, 'f-upload', 'the attachment\'s own File');
  assert.equal(res.delivery, 'md_s');
  assert.equal(res.userMessage, 'Recibí «clase.mp3». Te aviso aquí.');
  assert.deepEqual(copied, [], 'never a second File for a staged upload');
  assert.deepEqual(created[0].fileIds, ['f-upload']);
  assert.equal(created[0].chatId, 'c1');
  assert.equal(created[0].language, 'es');
  assert.deepEqual(enqueued, [{ fileId: 'f-upload', userId: 'u1', language: 'es', hints: { terms: ['Huamán'] } }]);
  // Its upload-time job failed: the new request is the retry, never a
  // delivery that can only post the old failure.
  const attempts = [];
  const afterFailure = await voice.defaultStagedHandoff({ fileId: 'f-upload', originalName: 'clase.mp3', spanSec: 3600,
    ctx: { userId: 'u1', chatId: 'c1' }, env: {}, services: { ...services, enqueueMediaTranscription: async (payload) => {
      attempts.push(payload);
      return payload.retry ? { id: payload.fileId, queued: true, stage: 'uploaded' } : { id: payload.fileId, queued: false, stage: 'failed' };
    } } });
  assert.equal(afterFailure.ok, true);
  assert.deepEqual(attempts, [{ fileId: 'f-upload', userId: 'u1' }, { fileId: 'f-upload', userId: 'u1', retry: true }]);
  // A workspace file with no originating upload is still handed off as before.
  const other = JSON.parse(await exec({ path: 'outputs/descarga.mp3' }, {}));
  assert.equal(other.fileId, 'f-copy');
  assert.deepEqual(copied, ['descarga.mp3']);
  // Without a delivery a 2-hour staged attachment gets an honest error, still no copy.
  const noDelivery = voice.makeTranscribeAudioExecutor({
    sandbox: fakeSandbox(files), env: {}, probeDuration: async () => 2 * 3600,
    owner: { userId: 'u1', chatId: 'c1', staged: [{ rel: 'uploads/clase.mp3', fileId: 'f-upload' }] },
    durableHandoff: async () => assert.fail('never copies a staged upload'),
    stagedHandoff: (payload) => voice.defaultStagedHandoff({ ...payload, services: { ...services, delivery: { ...services.delivery, isMediaDeliveryEnabled: () => false } } }),
    transcribeImpl: async () => assert.fail('never inline'),
  });
  assert.match(await noDelivery({ path: 'uploads/clase.mp3' }, {}), /^ERROR: .*dura 2 h.*ya está adjunta/);
});
