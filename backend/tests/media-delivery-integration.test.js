'use strict';

// Integration seams between the chat turn, the media queue and the durable
// delivery: the record keeps what the deliverables must look like, and a
// turn that handed its work off does not send «Tarea terminada» hours
// before the transcript exists.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMediaDeliveryStore, normalizeNewRecord, FORMATS } = require('../src/services/media-delivery-store');
const taskStore = require('../src/services/agents/task-store');

test('a delivery record keeps the requested output (Word/PDF, subtitles, clip clock) and a safe link source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdi-'));
  const store = createMediaDeliveryStore({ root });
  const record = await store.create({ userId: 'u1', chatId: 'c1', fileIds: ['f1'], fileNames: ['clase.m4a'],
    formats: ['txt', 'pdf', 'srt'], output: { documentFormat: 'pdf', wantsSubtitles: true, timeOffsetSec: 3600 },
    source: { url: 'https://www.youtube.com/watch?v=x', host: 'www.youtube.com', title: 'Clase' } });
  assert.deepEqual(record.output, { documentFormat: 'pdf', wantsSubtitles: true, timeOffsetSec: 3600, includeTranscript: false, alsoAnalysis: false });
  assert.deepEqual(record.source, { url: 'https://www.youtube.com/watch?v=x', host: 'www.youtube.com', title: 'Clase' });
  assert.ok(record.formats.includes('pdf'));
  assert.ok(FORMATS.includes('pdf'));
  const reread = await store.get(record.id);
  assert.deepEqual(reread.output, record.output);
});

test('junk output and non-http sources are dropped, never stored', () => {
  const record = normalizeNewRecord({ userId: 'u1', fileIds: ['f1'],
    output: { documentFormat: 'exe', wantsSubtitles: 'yes', timeOffsetSec: -5, includeTranscript: 'yes', alsoAnalysis: 1 },
    source: { url: 'javascript:alert(1)' } });
  assert.deepEqual(record.output, { documentFormat: null, wantsSubtitles: false, timeOffsetSec: 0, includeTranscript: false, alsoAnalysis: false });
  assert.equal(record.source, null);
  assert.deepEqual(normalizeNewRecord({ userId: 'u1', fileIds: ['f1'] }).output,
    { documentFormat: null, wantsSubtitles: false, timeOffsetSec: 0, includeTranscript: false, alsoAnalysis: false });
});

test('«transcribe y tradúcelo» / «resume y tradúcelo»: the record keeps both intents of a translation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdi-'));
  const store = createMediaDeliveryStore({ root });
  const record = await store.create({ userId: 'u1', chatId: 'c1', fileIds: ['f1'], mode: 'translation',
    goal: 'transcribe este audio, resúmelo y tradúcelo al inglés', output: { includeTranscript: true, alsoAnalysis: true } });
  assert.equal(record.output.includeTranscript, true);
  assert.equal(record.output.alsoAnalysis, true);
  assert.deepEqual((await store.get(record.id)).output, record.output);
});

test('a turn that handed a transcription off defers its «completed» notification to the delivery', () => {
  assert.equal(taskStore.deferredNotification({ stats: { stoppedReason: 'media_delivery_handoff' } }), true);
  assert.equal(taskStore.deferredNotification({ streamState: { stoppedReason: 'media_delivery_handoff' } }), true);
  assert.equal(taskStore.deferredNotification({ stats: { stoppedReason: 'transcription_finalize' } }), false);
  assert.equal(taskStore.deferredNotification({}), false);
});

// ── translation (full, never a summary) ───────────────────────────────

const batch = require('../src/services/media-batch');
const { createMediaDeliveryService } = require('../src/services/media-delivery');

test('translation requests name a target language; plain transcription or unknown targets do not', () => {
  assert.deepEqual(batch.detectTranslationTarget('tradúcelo al inglés'), { code: 'en', name: 'inglés' });
  assert.deepEqual(batch.detectTranslationTarget('traduce la transcripción a portugués'), { code: 'pt', name: 'portugués' });
  assert.deepEqual(batch.detectTranslationTarget('translate it into English'), { code: 'en', name: 'inglés' });
  assert.deepEqual(batch.detectTranslationTarget('traduce del inglés al español'), { code: 'es', name: 'español' });
  assert.equal(batch.detectTranslationTarget('traduce esto'), null);
  assert.equal(batch.detectTranslationTarget('transcribe el audio'), null);
});

test('a 5-hour transcript is translated in full: every chunk, in order, markers kept, failures per file', async () => {
  const text = Array.from({ length: 40 }, (_, i) => `[00:${String(i).padStart(2, '0')}:00] Frase ${i} ${'x'.repeat(400)}`).join('\n');
  const rows = [{ id: 'a', originalName: 'a.mp4', processingStage: 'ready', extractedText: text },
    { id: 'b', originalName: 'b.mp4', processingStage: 'ready', extractedText: 'Hola.' }];
  const seen = [];
  const result = await batch.translateMediaBatch({ rows, target: { code: 'en', name: 'inglés' }, parallel: 3,
    complete: async (messages) => {
      const input = JSON.parse(messages[1].content);
      assert.match(messages[0].content, /sin resumir/);
      assert.match(messages[0].content, /\[hh:mm:ss\]/);
      if (input.source === 'b.mp4') throw new Error('provider down');
      seen.push(input.part);
      return `EN(${input.transcript})`;
    } });
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.failed, [{ id: 'b', name: 'b.mp4' }]);
  const chunks = batch.splitTranscript(text, batch.TRANSLATION_CHUNK_CHARS);
  assert.ok(chunks.length > 1);
  assert.deepEqual(seen, chunks.map((_, i) => i + 1));
  assert.equal(result.files[0].text, chunks.map(chunk => `EN(${chunk})`.trim()).join('\n\n'));
});

test('a delivered translation posts its own files under «Traducción», without re-sending the transcript files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdt-'));
  const posted = [];
  const saved = [];
  let built = 0;
  const service = createMediaDeliveryService({
    env: { SIRAGPT_MEDIA_DELIVERY: '1' }, logger: { info() {}, warn() {} },
    store: createMediaDeliveryStore({ root }),
    prisma: { message: { findFirst: async () => null } },
    loadFiles: async () => [{ id: 'clase', userId: 'u1', originalName: 'clase.mp4', mimeType: 'video/mp4', processingStage: 'ready', extractedText: 'Hola a todos.' }],
    loadTranscript: async () => null,
    buildArtifacts: async () => { built++; return [{ filename: 'clase.txt', base64: 'eA==', mime: 'text/plain' }]; },
    saveArtifact: ({ filename, mime }) => { const a = { id: `a${saved.length + 1}`, filename, mime, format: filename.split('.').pop() }; saved.push(a); return a; },
    persistArtifact: async () => {},
    postMessage: async ({ chatId, content, artifacts }) => { posted.push({ content, artifacts }); return { messageId: 'm1', chatId }; },
    ensureChat: async ({ chatId }) => ({ chatId, created: false }),
    notify: async () => {},
    analyze: async () => ({ text: 'Hello everyone.', artifacts: [{ filename: 'clase (traducción al inglés).txt', base64: 'eA==', mime: 'text/plain' }] }),
  });
  const record = await service.createDelivery({ userId: 'u1', chatId: 'c1', fileIds: ['clase'], fileNames: ['clase.mp4'],
    goal: 'tradúcelo al inglés', mode: 'translation' });
  assert.equal(record.mode, 'translation');
  assert.equal((await service.deliverOne(record.id)).status, 'delivered');
  assert.equal(built, 0, 'the transcript files are not rebuilt for a translation');
  assert.deepEqual(saved.map(a => a.filename), ['clase (traducción al inglés).txt']);
  assert.match(posted[0].content, /### Traducción\n\nHello everyone\./);
});

test('the real translation step: «resume y tradúcelo» runs both, labels the batch preview and names the file that failed', async (t) => {
  // Only the model runtime is faked; media-batch and the translation builder are real.
  const runnerPath = require.resolve('../src/services/agents/agent-task-runner');
  const runtimePath = require.resolve('../src/services/media-analysis-runtime');
  const previous = { runner: require.cache[runnerPath], runtime: require.cache[runtimePath] };
  t.after(() => {
    for (const [file, entry] of [[runnerPath, previous.runner], [runtimePath, previous.runtime]]) {
      if (entry) require.cache[file] = entry; else delete require.cache[file];
    }
  });
  const calls = { translate: [], analyze: 0, final: 0 };
  require.cache[runnerPath] = { id: runnerPath, filename: runnerPath, loaded: true, exports: {
    normalizeAgentRuntimeModel: id => ({ runtimeModel: id }),
    resolveAgentRuntimeClient: () => ({ client: {}, model: 'deepseek-v4-flash', provider: 'DeepSeek' }),
  } };
  require.cache[runtimePath] = { id: runtimePath, filename: runtimePath, loaded: true, exports: {
    createMediaAnalysisCompletion: () => ({ usage: {}, complete: async (messages) => {
      const system = String(messages[0].content);
      const input = JSON.parse(messages[1].content);
      if (/^Traduce/.test(system)) {
        calls.translate.push(input.source);
        if (input.source === 'b.mp4') throw new Error('provider down');
        return `EN(${input.transcript})`;
      }
      if (/^Responde en español a la petición/.test(system)) { calls.final++; return 'Resumen final de las clases.'; }
      calls.analyze++;
      return 'Nota parcial de la clase.';
    } }),
  } };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const posted = [];
  const saved = [];
  let built = 0;
  const service = createMediaDeliveryService({
    env: { SIRAGPT_MEDIA_DELIVERY: '1' }, logger: { info() {}, warn() {} },
    store: createMediaDeliveryStore({ root }),
    prisma: { message: { findFirst: async () => null } },
    loadFiles: async () => [
      { id: 'a', userId: 'u1', originalName: 'a.mp4', mimeType: 'video/mp4', processingStage: 'ready', extractedText: '[00:00:00] Hola a todos.' },
      { id: 'b', userId: 'u1', originalName: 'b.mp4', mimeType: 'video/mp4', processingStage: 'ready', extractedText: '[00:00:00] Buenas tardes.' },
    ],
    loadTranscript: async () => null,
    buildArtifacts: async () => { built++; return [{ filename: 'transcripciones.txt', base64: 'eA==', mime: 'text/plain' }]; },
    saveArtifact: ({ filename, mime }) => { const a = { id: `a${saved.length + 1}`, filename, mime, format: filename.split('.').pop() }; saved.push(a); return a; },
    persistArtifact: async () => {},
    postMessage: async ({ chatId, content }) => { posted.push(content); return { messageId: 'm1', chatId }; },
    ensureChat: async ({ chatId }) => ({ chatId, created: false }),
    notify: async () => {},
  });
  const record = await service.createDelivery({ userId: 'u1', chatId: 'c1', fileIds: ['a', 'b'], fileNames: ['a.mp4', 'b.mp4'],
    goal: 'resume y tradúcelo al inglés', mode: 'translation', model: { id: 'deepseek-v4-flash' }, output: { alsoAnalysis: true } });
  assert.equal((await service.deliverOne(record.id)).status, 'delivered');
  assert.deepEqual(calls.translate.sort(), ['a.mp4', 'b.mp4']);
  assert.equal(calls.final, 1, 'the requested summary ran');
  assert.equal(built, 0, 'a translation without «transcribe» does not re-send the transcript');
  assert.deepEqual(saved.map(a => a.filename), ['a (traducción al inglés).txt']);
  const content = posted[0];
  assert.match(content, /### Análisis\n\nResumen final de las clases\./);
  assert.match(content, /### Traducción\n\n#### «a\.mp4»\n\nEN\(\\\[00:00:00\\\] Hola a todos\.\)/);
  assert.match(content, /No pude traducir «b\.mp4»\. Su transcripción sigue guardada/);
});
