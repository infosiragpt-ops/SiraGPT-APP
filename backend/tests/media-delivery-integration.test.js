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
  assert.deepEqual(record.output, { documentFormat: 'pdf', wantsSubtitles: true, timeOffsetSec: 3600 });
  assert.deepEqual(record.source, { url: 'https://www.youtube.com/watch?v=x', host: 'www.youtube.com', title: 'Clase' });
  assert.ok(record.formats.includes('pdf'));
  assert.ok(FORMATS.includes('pdf'));
  const reread = await store.get(record.id);
  assert.deepEqual(reread.output, record.output);
});

test('junk output and non-http sources are dropped, never stored', () => {
  const record = normalizeNewRecord({ userId: 'u1', fileIds: ['f1'],
    output: { documentFormat: 'exe', wantsSubtitles: 'yes', timeOffsetSec: -5 }, source: { url: 'javascript:alert(1)' } });
  assert.deepEqual(record.output, { documentFormat: null, wantsSubtitles: false, timeOffsetSec: 0 });
  assert.equal(record.source, null);
  assert.deepEqual(normalizeNewRecord({ userId: 'u1', fileIds: ['f1'] }).output, { documentFormat: null, wantsSubtitles: false, timeOffsetSec: 0 });
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
