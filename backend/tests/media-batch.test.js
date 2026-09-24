'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const batch = require('../src/services/media-batch');

function fixture(n = 50) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: `f${i}`, userId: 'u',
    originalName: `Audio ${i + 1}.mp3`, mimeType: 'audio/mpeg', deletedAt: null,
    processingStage: 'uploaded', extractedText: null }));
  const reads = [];
  const prisma = { file: { findMany: async ({ where }) => {
    reads.push(where);
    return rows.filter(row => row.userId === where.userId && row.deletedAt === null && where.id.in.includes(row.id)).map(row => ({ ...row })).reverse();
  } } };
  return { rows, prisma, reads };
}

test('50 uploaded files retain user order; database access is owner/deletion scoped', async () => {
  const { rows, prisma, reads } = fixture();
  const actual = await batch.loadMediaBatch(prisma, { userId: 'u', fileIds: rows.map(row => row.id) });
  assert.deepEqual(actual.map(row => row.id), rows.map(row => row.id));
  assert.equal(actual.length, 50);
  assert.equal(reads[0].userId, 'u');
  assert.equal(reads[0].deletedAt, null);
  await assert.rejects(batch.loadMediaBatch(prisma, { userId: 'u', fileIds: [...rows.map(row => row.id), 'not-owned'] }), /cuenta/);
});

test('51 media files produce explicit limit; mixed documents retain their own workflow', async () => {
  const { rows, prisma } = fixture(51);
  await assert.rejects(batch.loadMediaBatch(prisma, { userId: 'u', fileIds: rows.map(row => row.id) }), /50/);
  rows[0].mimeType = 'application/pdf';
  rows[0].originalName = 'documento.pdf';
  assert.equal(await batch.loadMediaBatch(prisma, { userId: 'u', fileIds: rows.map(row => row.id) }), null);
});

test('wait covers all 50, preserves 49 completed when one fails, reload reuses every result', async () => {
  const { rows, prisma } = fixture();
  const enqueued = [];
  const progress = [];
  let clock = 0;
  const result = await batch.waitForMediaBatch({ prisma, userId: 'u', rows,
    enqueue: async ({ fileId }) => enqueued.push(fileId), now: () => clock,
    onProgress: p => progress.push(p), wait: async () => {
      clock += 100;
      rows.forEach((row, i) => {
        row.processingStage = i === 19 ? 'failed' : 'ready';
        row.extractedText = i === 19 ? null : `Hola, audio ${i + 1}.`;
      });
    },
  });
  assert.equal(enqueued.length, 50);
  assert.equal(result.ready, 49); assert.equal(result.failed, 1); assert.equal(result.pending, 0);
  assert.equal(progress.at(-1).files.length, 50);
  assert.deepEqual(result.rows.map(row => row.id), rows.map(row => row.id));
  const reload = await batch.waitForMediaBatch({ prisma, userId: 'u', rows: result.rows,
    enqueue: async () => assert.fail('must not re-transcribe ready or failed files automatically') });
  assert.equal(reload.ready, 49);
});

test('lost queue connection and exhausted wait remain pending, never fictional success', async () => {
  const { rows, prisma } = fixture(2);
  const result = await batch.waitForMediaBatch({ prisma, userId: 'u', rows,
    enqueue: async () => { throw new Error('redis unavailable'); } });
  assert.equal(result.pending, 2); assert.equal(result.ready, 0);
  assert.equal(result.enqueueErrors.size, 2);
  const timed = await batch.waitForMediaBatch({ prisma, userId: 'u', rows,
    enqueue: async () => {}, timeoutMs: 0 });
  assert.equal(timed.pending, 2);
});

test('cancellation stops the wait but does not delete files or cancel persistent transcription', async () => {
  const { rows, prisma } = fixture(2);
  const controller = new AbortController();
  await assert.rejects(batch.waitForMediaBatch({ prisma, userId: 'u', rows,
    signal: controller.signal, enqueue: async () => { controller.abort(); } }), /abort/i);
  assert.equal(rows.length, 2);
});

test('complete TXT keeps tails across 50 long audios, including >120k total characters', () => {
  const { rows } = fixture();
  rows.forEach((row, i) => { row.processingStage = 'ready'; row.extractedText = `INICIO ${i}\n${'evidencia '.repeat(1000)}\nFINAL_UNICO_${i}`; });
  const text = batch.transcriptBundle(rows);
  assert.ok(text.length > 120000);
  for (let i = 0; i < 50; i++) assert.ok(text.includes(`FINAL_UNICO_${i}`));
});

test('analysis reads EVERY character of EVERY audio before synthesizing all 50', async () => {
  const { rows } = fixture();
  rows.forEach((row, i) => { row.processingStage = 'ready'; row.extractedText = `A${i}:${'palabras '.repeat(2500)}FIN${i}`; });
  const observed = new Map();
  let synthesis;
  const result = await batch.analyzeMediaBatch({ rows, goal: 'transcribe y analiza las decisiones',
    complete: async (messages, _signal, final) => {
      const input = JSON.parse(messages[1].content);
      if (final) { synthesis = input; return 'Análisis de todas las decisiones.'; }
      observed.set(input.fileId, (observed.get(input.fileId) || '') + input.transcript);
      return `Hallazgos de ${input.source}, parte ${input.part}.`;
    },
  });
  assert.equal(synthesis.audioSummaries.length, 50);
  assert.equal(result.summaries.length, 50);
  assert.equal(result.failed.length, 0);
  for (const row of rows) assert.equal(observed.get(row.id), row.extractedText);
});

test('analysis failures are attributed per file without losing other transcripts or using another model', async () => {
  const { rows } = fixture(3);
  rows.forEach(row => { row.processingStage = 'ready'; row.extractedText = `contenido ${row.id}`; });
  let summaryInput;
  const result = await batch.analyzeMediaBatch({ rows, goal: 'compara', complete: async (messages, _signal, final) => {
    const input = JSON.parse(messages[1].content);
    if (final) { summaryInput = input; return 'Comparación de los dos disponibles'; }
    if (input.fileId === 'f1') throw new Error('selected provider unavailable');
    return 'evidencia';
  } });
  assert.deepEqual(result.failed.map(row => row.id), ['f1']);
  assert.equal(summaryInput.audioSummaries.length, 2);
  assert.equal(rows[1].extractedText, 'contenido f1');
});

test('transcribe + analyze is not reduced to literal transcription; short speech stays valid', () => {
  assert.equal(batch.wantsMediaAnalysis('transcribir'), false);
  assert.equal(batch.wantsMediaAnalysis('transcribir y analizar los 50 audios'), true);
  assert.equal(batch.wantsMediaAnalysis('haz un resumen'), true);
  assert.equal(batch.usableTranscript({ extractedText: 'Hola', processingStage: 'ready' }), true);
  assert.equal(batch.usableTranscript({ extractedText: 'Media file "a.mp3": transcription unavailable.', processingStage: 'ready' }), false);
});

test('follow-up uses only the newest batch in the owned chat, never global recent uploads', async () => {
  const { rows, prisma } = fixture();
  prisma.chat = { findFirst: async ({ where }) => where.userId === 'u' && where.id === 'chat-u' ? { id: 'chat-u' } : null };
  prisma.message = { findMany: async ({ where }) => {
    assert.equal(where.chatId, 'chat-u');
    assert.equal(where.role, 'USER', 'assistant TXT artifacts must not replace the uploaded audio batch');
    return [{ files: null }, { files: rows.map(row => ({ id: row.id })) }, { files: ['old-unrelated'] }];
  } };
  assert.deepEqual(await batch.resolveChatMediaFileIds(prisma, { userId: 'u', chatId: 'chat-u' }), rows.map(row => row.id));
  assert.deepEqual(await batch.resolveChatMediaFileIds(prisma, { userId: 'u', chatId: 'chat-other' }), []);
  assert.deepEqual(await batch.resolveChatMediaFileIds(prisma, { userId: 'u' }), []);
});

test('explicit retry schedules only the failed audio, then returns all 50 preserved transcripts', async () => {
  const { rows, prisma } = fixture();
  rows.forEach(row => { row.processingStage = 'ready'; row.extractedText = `texto ${row.id}`; });
  rows[49].processingStage = 'failed'; rows[49].extractedText = null;
  const enqueued = [];
  const result = await batch.waitForMediaBatch({ prisma, userId: 'u', rows, retryFailed: true,
    enqueue: async request => { enqueued.push(request); return { queued: true }; },
    wait: async () => { rows[49].processingStage = 'ready'; rows[49].extractedText = 'recuperado'; },
  });
  assert.deepEqual(enqueued, [{ fileId: 'f49', userId: 'u', retry: true }]);
  assert.equal(result.ready, 50); assert.equal(result.failed, 0);
});

test('new programming or general tasks do not inherit the previous audio batch', () => {
  for (const goal of ['analiza el código de mi proyecto', 'explica este algoritmo', 'qué hora es', 'cómo cambio mi contraseña']) {
    assert.equal(batch.shouldResolveMediaBatchFromHistory(goal), false, goal);
  }
  assert.equal(batch.shouldResolveMediaBatchFromHistory('analiza los audios'), true);
  assert.equal(batch.shouldResolveMediaBatchFromHistory('reintenta los audios fallidos'), true);
  assert.equal(batch.shouldResolveMediaBatchFromHistory('transcribir', { plainTranscriptionRequest: true }), true);
});

test('chat transcript is per-file markdown: heading + paragraph, no "=====" rule folded into a list item', () => {
  const rows = [
    { id: 'a', originalName: 'WhatsApp_Ptt 2026.ogg', processingStage: 'ready', extractedText: 'hola buenos días\n1. no es lista\n# no es título' },
    { id: 'b', originalName: 'b.ogg', processingStage: 'failed' },
  ];
  const md = batch.transcriptMarkdown(rows);
  assert.match(md, /^#### 1\. WhatsApp\\_Ptt 2026\.ogg\n\nhola buenos días/);
  assert.match(md, /\n1\\\. no es lista\n\\# no es título/);
  assert.match(md, /#### 2\. b\.ogg\n\n_No se pudo transcribir/);
  assert.doesNotMatch(md, /={10,}/);
  // The downloadable TXT keeps its plain-text layout.
  assert.match(batch.transcriptBundle(rows), /1\. WhatsApp_Ptt 2026\.ogg\n={48}\n/);
});
