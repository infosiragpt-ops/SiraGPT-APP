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

test('literal transcription does not treat negated summaries or analysis as requests', () => {
  for (const goal of [
    'Prueba de aceptación con audio sintético. Transcribe el audio adjunto de forma literal, sin resumen.',
    'Transcribe el audio, no resumas.',
    'Transcribir sin análisis.',
    'Sólo transcribe.',
    'Transcribe sin resumir ni analizar.',
    'Transcribe. No me hagas un resumen ni un análisis.',
  ]) assert.equal(batch.wantsMediaAnalysis(goal), false, goal);
});

test('negated analysis does not suppress a separate positive task', () => {
  for (const goal of [
    'Transcribe y resume.',
    'Transcribe literalmente y después analiza.',
    'Sólo transcribe primero y luego resume los acuerdos.',
    'Transcribe sin resumen, pero analiza las decisiones.',
    'Transcribe sin análisis y después haz un resumen.',
    'No sólo transcribas: analiza el audio.',
  ]) assert.equal(batch.wantsMediaAnalysis(goal), true, goal);
});

// Free variables of the media branch that the runner module provides.
function mediaBranchHelpers(overrides = {}) {
  const handoff = require('../src/services/media-handoff');
  return {
    loadMediaDeliveryService: () => null,
    mediaInlineWaitMs: handoff.mediaInlineWaitMs,
    shouldHandOffMediaWait: handoff.shouldHandOffMediaWait,
    estimateMediaBatchEta: handoff.estimateMediaBatchEta,
    totalProgressDuration: handoff.totalProgressDuration,
    mediaRowsForAnalysis: handoff.mediaRowsForAnalysis,
    describeTranscriptDownloads: handoff.describeTranscriptDownloads,
    process, console, assistantMessageId: null, model: 'deepseek-v4-flash',
    runtimeModelProfile: { runtimeModel: 'deepseek-v4-flash', runtimeProvider: 'DeepSeek' },
    ...overrides,
  };
}

function runMediaBranch(context) {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const filename = path.resolve(__dirname, '../src/services/agents/agent-task-runner.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('    if (mediaBatchRows) {');
  const end = source.indexOf('    // ── Image-only analysis turn', start);
  assert.ok(start >= 0 && end > start, 'execute the actual media delivery branch');
  return vm.runInNewContext(`(async () => { ${source.slice(start, end)} })()`, context, { filename });
}

test('a long recording ends the turn with «te aviso aquí» and a durable delivery record instead of waiting for hours', async () => {
  const rows = [{ id: 'clase', originalName: 'clase.mp4', processingStage: 'extracting', extractedText: null, size: 4e9 }];
  const created = [];
  const waits = [];
  const delivery = {
    isMediaDeliveryEnabled: () => true,
    estimateTranscriptionSeconds: ({ durationSec }) => Math.round(durationSec * 0.15),
    createDelivery: async (record) => { created.push(record); return { id: 'md_1', ...record }; },
    handOffMessage: ({ fileNames, durationSec, etaSeconds }) => `Recibí «${fileNames[0]}» (${durationSec} s, ~${etaSeconds} s). Te aviso aquí.`,
  };
  const result = await runMediaBranch({
    mediaBatchRows: rows,
    mediaBatch: { ...batch, waitForMediaBatch: async (options) => {
      waits.push(options);
      const progress = { clase: { stage: 'transcribing', durationSeconds: 18000, completed: 1, total: 30, etaSeconds: null } };
      assert.equal(await options.shouldStop({ pending: 1, elapsedMs: 5000, files: [{ id: 'clase', stage: 'pending', progress: progress.clase }] }), true,
        'a 5 h recording hands off as soon as its size is known');
      return { rows, total: 1, ready: 0, failed: 0, pending: 1, partial: 0, progress, stoppedEarly: true };
    } },
    prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [], displayGoal: 'transcribe este video y hazme un word', goal: 'x',
    backfillUserMessageFilesForTranscription: async () => {}, emit() {},
    controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
    saveArtifact: () => { throw new Error('no artifacts before the transcript exists'); },
    artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
    plainTranscriptionRequest: false, openai: {}, task: {}, documentPolicy: {},
    require: (name) => require(name === '../media-transcript-artifacts' ? '../src/services/media-transcript-artifacts' : name),
    ...mediaBranchHelpers({ loadMediaDeliveryService: () => delivery }),
    throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
  });
  assert.equal(waits.length, 1);
  assert.equal(waits[0].timeoutMs, 240000, 'the inline wait is bounded by TRANSCRIBE_CHAT_INLINE_WAIT_MS');
  assert.equal(result.stoppedReason, 'media_delivery_handoff');
  assert.match(result.finalMarkdown, /Recibí «clase\.mp4» \(18000 s, ~2610 s\)\. Te aviso aquí\./);
  // The hand-off names its delivery under its own key: `mediaDelivery` marks
  // only the message the delivery posts, so the hand-off never counts as it.
  assert.equal(result.metadata.mediaDeliveryHandoff, 'md_1');
  assert.equal(result.metadata.mediaDelivery, undefined);
  assert.equal(created.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(created[0].fileIds)), ['clase']);
  assert.equal(created[0].chatId, 'chat');
  assert.equal(created[0].output.documentFormat, 'docx');
  assert.equal(created[0].output.includeTranscript, true);
  assert.equal(created[0].output.alsoAnalysis, false);
  assert.deepEqual(JSON.parse(JSON.stringify(created[0].model)), { id: 'deepseek-v4-flash', provider: 'DeepSeek' });
});

test('when the delivery cannot be created the turn keeps the previous inline wait', async () => {
  const rows = [{ id: 'clase', originalName: 'clase.mp3', processingStage: 'extracting', extractedText: null }];
  const waits = [];
  const delivery = { isMediaDeliveryEnabled: () => true, createDelivery: async () => null, handOffMessage: () => 'never' };
  const result = await runMediaBranch({
    mediaBatchRows: rows,
    mediaBatch: { ...batch, waitForMediaBatch: async (options) => {
      waits.push(options);
      if (waits.length === 1) return { rows, total: 1, ready: 0, failed: 0, pending: 1, partial: 0, progress: {} };
      const done = [{ ...rows[0], processingStage: 'ready', extractedText: 'Texto completo de la clase de hoy.' }];
      return { rows: done, total: 1, ready: 1, failed: 0, pending: 0, partial: 0, progress: {} };
    } },
    prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [], displayGoal: 'transcribe sin resumen', goal: 'transcribe sin resumen',
    backfillUserMessageFilesForTranscription: async () => {}, emit() {},
    controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
    saveArtifact: (artifact) => ({ id: 'a', filename: artifact.filename }),
    artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
    plainTranscriptionRequest: true, openai: {}, task: {}, documentPolicy: {},
    require: (name) => require(name === '../media-transcript-artifacts' ? '../src/services/media-transcript-artifacts' : name),
    ...mediaBranchHelpers({ loadMediaDeliveryService: () => delivery }),
    throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
  });
  assert.equal(waits.length, 2);
  assert.ok(waits[1].timeoutMs > 11 * 60 * 60_000, 'the rest of the media budget');
  assert.equal(result.stoppedReason, 'transcription_finalize');
  assert.match(result.finalMarkdown, /Texto completo de la clase de hoy/);
});

test('real media delivery returns the exact synthetic transcript without map/reduce for sin resumen', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const { isPlainTranscriptionRequest } = require('../src/services/message-attachments');
  const filename = path.resolve(__dirname, '../src/services/agents/agent-task-runner.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('    if (mediaBatchRows) {');
  const end = source.indexOf('    // ── Image-only analysis turn', start);
  assert.ok(start >= 0 && end > start, 'execute the actual media delivery branch');
  const goal = 'Prueba de aceptación con audio sintético. Transcribe el audio adjunto de forma literal, sin resumen.';
  const transcript = 'Esta es una prueba. La reunión será el martes a las nueve. Revisaremos tres documentos y una hoja de cálculo.';
  const rows = [{ id: 'synthetic', originalName: 'acceptance.wav', processingStage: 'ready', extractedText: transcript }];
  let analysisCalls = 0;
  let savedText;
  const result = await vm.runInNewContext(`(async () => { ${source.slice(start, end)} })()`, {
    mediaBatchRows: rows, mediaBatch: { ...batch, waitForMediaBatch: async () => ({ rows, total: 1, ready: 1, failed: 0, pending: 0 }) },
    prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [], displayGoal: goal, goal,
    backfillUserMessageFilesForTranscription: async () => {}, emit() {},
    controller: new AbortController(), runtimeBudgetMs: 60 * 60_000, startedAt: Date.now(), Buffer,
    saveArtifact: (artifact) => { savedText = Buffer.from(artifact.base64, 'base64').toString('utf8'); return { id: 'txt', filename: artifact.filename }; },
    artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
    plainTranscriptionRequest: isPlainTranscriptionRequest(goal), openai: {}, task: {}, documentPolicy: {},
    require: (name) => (name === '../media-transcript-artifacts' ? require('../src/services/media-transcript-artifacts')
      : { createMediaAnalysisCompletion() { analysisCalls++; throw new Error('literal request must not call the model'); } }),
    ...mediaBranchHelpers(),
    throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
  }, { filename });
  assert.equal(analysisCalls, 0);
  assert.equal(result.stoppedReason, 'transcription_finalize');
  assert.equal(result.steps, 1);
  assert.ok(result.finalMarkdown.includes(transcript));
  assert.ok(savedText.includes(transcript));
  assert.equal(result.metadata.mediaBatch.analyzed, 0);
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

test('a single 10-hour recording: the chat keeps waiting while it advances and shows live %', async () => {
  const { rows, prisma } = fixture(1);
  rows[0].originalName = 'clase-10h.mkv';
  let clock = 0;
  let completed = 0;
  const labels = [];
  const result = await batch.waitForMediaBatch({ prisma, userId: 'u', rows,
    enqueue: async () => ({ queued: true }), now: () => clock,
    timeoutMs: batch.MEDIA_WAIT_MAX_MS, stallMs: 45 * 60_000,
    readProgress: async ({ fileIds, userId }) => {
      assert.deepEqual(fileIds, ['f0']);
      assert.equal(userId, 'u');
      return { f0: { stage: 'transcribing', completed, total: 61, percent: Math.round(2 + (97 * completed) / 61), etaSeconds: (61 - completed) * 60 } };
    },
    onProgress: p => labels.push(batch.describeBatchProgress(p)),
    wait: async () => {
      clock += 60_000; // one minute per poll, one part per minute: ~61 min total
      completed++;
      if (completed === 61) { rows[0].processingStage = 'ready'; rows[0].extractedText = 'Transcripción de diez horas de clase.'; }
    },
  });
  assert.equal(clock, 61 * 60_000, 'waited the whole hour the recording needed');
  assert.equal(result.ready, 1);
  assert.equal(result.pending, 0);
  assert.match(labels[1], /^Transcribiendo «clase-10h\.mkv»: \d+ % \(1\/61 partes\) · quedan ~1 h · 0\/1 transcritos/);
});

test('the wait gives up early when a job makes no progress for the stall window', async () => {
  const { rows, prisma } = fixture(1);
  let clock = 0;
  const result = await batch.waitForMediaBatch({ prisma, userId: 'u', rows,
    enqueue: async () => ({ queued: true }), now: () => clock,
    timeoutMs: batch.MEDIA_WAIT_MAX_MS, stallMs: 45 * 60_000,
    readProgress: async () => ({ f0: { stage: 'transcribing', completed: 3, total: 61, percent: 7 } }),
    wait: async () => { clock += 5 * 60_000; },
  });
  assert.equal(result.pending, 1);
  assert.ok(clock >= 45 * 60_000 && clock < 60 * 60_000, `stopped after the stall window, not the 12 h ceiling (${clock})`);
});

test('batch progress labels', () => {
  assert.equal(batch.formatRemaining(30), 'menos de 2 min');
  assert.equal(batch.formatRemaining(25 * 60), '25 min');
  assert.equal(batch.formatRemaining(150 * 60), '2 h 30 min');
  assert.match(batch.describeBatchProgress({ ready: 0, total: 1, pending: 1, failed: 0,
    files: [{ name: 'a.ogg', stage: 'pending', progress: { stage: 'preparing' } }] }), /^Preparando el audio de «a\.ogg»…/);
  assert.equal(batch.describeBatchProgress({ ready: 2, total: 3, pending: 1, failed: 0, files: [] }), '2/3 transcritos · 1 pendientes · 0 con incidencias');
});

test('a 5-hour transcript is analysed in bounded parallel chunks, in order, cut at paragraph breaks', async () => {
  const paragraphs = Array.from({ length: 300 }, (_, i) => `[${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00] ${'palabra '.repeat(110)}`);
  const text = `${paragraphs.join('\n')}\n`;
  const row = { id: 'clase', originalName: 'clase.mp4', processingStage: 'ready', extractedText: text };
  const chunks = batch.splitTranscript(text);
  assert.equal(chunks.join(''), text, 'chunks concatenate back to the exact text');
  assert.ok(chunks.slice(0, -1).every(chunk => chunk.endsWith('\n')), 'no paragraph is split');
  let active = 0; let peak = 0; const seenParts = [];
  let systemPrompt = '';
  const result = await batch.analyzeMediaBatch({ rows: [row], goal: 'hazme el acta con capítulos', parallel: 3,
    complete: async (messages, _signal, final) => {
      if (final) { systemPrompt = messages[0].content; return 'Acta.'; }
      const input = JSON.parse(messages[1].content);
      if (input.part) seenParts.push(input.part);
      active += 1; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return `nota ${input.part ?? 'r'}`;
    } });
  assert.equal(result.summaries.length, 1);
  assert.equal(peak, 3, 'three chunks at a time');
  assert.deepEqual(seenParts.slice(0, chunks.length), chunks.map((_, i) => i + 1), 'chunks are requested in order');
  assert.match(systemPrompt, /capítulos/);
  assert.match(systemPrompt, /\[hh:mm:ss\]/);
});

test('minutes, chapters, key points and study notes count as analysis requests', () => {
  for (const goal of ['hazme el acta de la reunión', 'dame la minuta', 'divídelo en capítulos', 'puntos clave de la clase',
    'saca las ideas principales', 'hazme apuntes', 'arma un cuestionario', 'índice con tiempos']) {
    assert.equal(batch.wantsMediaAnalysis(goal), true, goal);
  }
  assert.equal(batch.wantsMediaAnalysis('transcribe el audio'), false);
  assert.equal(batch.analysisParallel({ MEDIA_ANALYSIS_PARALLEL: '9' }), 6);
  assert.equal(batch.analysisParallel({}), 3);
});

test('a follow-up finds a recording delivered from a link (no user attachment), owner-checked', async () => {
  const { rows, prisma } = fixture(1);
  prisma.chat = { findFirst: async ({ where }) => (where.userId === 'u' && where.id === 'chat-u' ? { id: 'chat-u' } : null) };
  prisma.message = {
    findMany: async () => [{ files: null }],
    findFirst: async ({ where }) => {
      assert.equal(where.role, 'ASSISTANT');
      assert.deepEqual(where.metadata, { path: ['servedBy'], equals: 'media_batch' });
      return { metadata: { transcriptionFileIds: [rows[0].id] } };
    },
  };
  assert.deepEqual(await batch.resolveChatMediaFileIds(prisma, { userId: 'u', chatId: 'chat-u' }), [rows[0].id]);
  // Another user's file id in the metadata never resolves.
  prisma.message.findFirst = async () => ({ metadata: { transcriptionFileIds: ['foreign'] } });
  assert.deepEqual(await batch.resolveChatMediaFileIds(prisma, { userId: 'u', chatId: 'chat-u' }), []);
  // No delivered media: nothing.
  prisma.message.findFirst = async () => null;
  assert.deepEqual(await batch.resolveChatMediaFileIds(prisma, { userId: 'u', chatId: 'chat-u' }), []);
});

test('«tradúcelo al inglés» after a transcription translates the full text instead of summarising it', async () => {
  const transcript = 'Hola a todos. Hoy vemos la mitocondria y cómo produce energía para la célula.';
  const rows = [{ id: 'clase', originalName: 'clase.mp4', processingStage: 'ready', extractedText: transcript }];
  const saved = [];
  const calls = [];
  const result = await runMediaBranch({
    mediaBatchRows: rows, mediaBatch: { ...batch, waitForMediaBatch: async () => ({ rows, total: 1, ready: 1, failed: 0, pending: 0, partial: 0, progress: {} }) },
    prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [], displayGoal: 'tradúcelo al inglés', goal: 'tradúcelo al inglés',
    backfillUserMessageFilesForTranscription: async () => {}, emit() {},
    controller: new AbortController(), runtimeBudgetMs: 60 * 60_000, startedAt: Date.now(), Buffer,
    saveArtifact: (artifact) => { saved.push(artifact.filename); return { id: `a${saved.length}`, filename: artifact.filename }; },
    artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
    plainTranscriptionRequest: false, openai: {}, task: {}, documentPolicy: {},
    require: (name) => (name === '../media-transcript-artifacts' ? require('../src/services/media-transcript-artifacts')
      : { createMediaAnalysisCompletion: () => ({ usage: null, complete: async (messages, _signal, final) => {
        calls.push({ system: messages[0].content, final: Boolean(final) });
        return 'Hello everyone. Today we look at the mitochondria and how it makes energy for the cell.';
      } }) }),
    ...mediaBranchHelpers(),
    throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
  });
  assert.equal(calls.length, 1, 'one chunk, no summary pass');
  assert.match(calls[0].system, /Traduce al inglés TODO el fragmento/);
  assert.deepEqual(saved, ['clase (traducción al inglés).txt'], 'only the translation is delivered, not the transcript files again');
  assert.match(result.finalMarkdown, /Traducción completa al inglés/);
  assert.match(result.finalMarkdown, /Hello everyone/);
  assert.equal(result.metadata.mediaBatch.translated, 1);
  assert.equal(result.metadata.mediaBatch.translationLanguage, 'en');
  assert.equal(result.stoppedReason, 'transcription_finalize');
  // Only the translation is attached: no sentence may say the transcript is.
  assert.doesNotMatch(result.finalMarkdown, /La transcripción completa está en los adjuntos|La descarga adjunta conserva/);
});

// ── review fixes: hand-off key, translation intents, budgets, follow-ups ──

function mediaRuntime(complete) {
  return (name) => (name === '../media-transcript-artifacts' ? require('../src/services/media-transcript-artifacts')
    : { createMediaAnalysisCompletion: () => ({ usage: null, complete }) });
}

async function handOffTurn({ goal, delivery, rows = [{ id: 'clase', originalName: 'clase.mp3', processingStage: 'extracting', extractedText: null, size: 4e9 }],
  plainTranscriptionRequest = false, finish = async (value) => value }) {
  return runMediaBranch({
    mediaBatchRows: rows,
    mediaBatch: { ...batch, waitForMediaBatch: async () => ({ rows, total: rows.length, ready: 0, failed: 0, pending: rows.length, partial: 0, progress: {}, stoppedEarly: true }) },
    prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [], displayGoal: goal, goal,
    backfillUserMessageFilesForTranscription: async () => {}, emit() {},
    controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
    saveArtifact: () => { throw new Error('no artifacts before the transcript exists'); },
    artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
    plainTranscriptionRequest, openai: {}, task: {}, documentPolicy: {},
    require: mediaRuntime(async () => { throw new Error('no model call before the transcript exists'); }),
    ...mediaBranchHelpers({ loadMediaDeliveryService: () => delivery }),
    throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: finish,
  });
}

function whereMatches(row, where = {}) {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return cond.every(item => whereMatches(row, item));
    if (key === 'OR') return cond.some(item => whereMatches(row, item));
    if (key === 'metadata' && cond && Array.isArray(cond.path)) return cond.path.reduce((value, part) => value?.[part], row.metadata) === cond.equals;
    return row[key] === cond;
  });
}

test('the hand-off message never counts as the delivered transcript: the delivery still posts it', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createMediaDeliveryStore } = require('../src/services/media-delivery-store');
  const mediaDelivery = require('../src/services/media-delivery');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-handoff-'));
  const messages = [];
  const posted = [];
  const service = mediaDelivery.createMediaDeliveryService({
    env: { SIRAGPT_MEDIA_DELIVERY: '1' }, logger: { info() {}, warn() {} },
    store: createMediaDeliveryStore({ root }),
    prisma: { message: { findFirst: async ({ where }) => messages.find(row => whereMatches(row, where)) || null } },
    loadFiles: async () => [{ id: 'clase', userId: 'owner', originalName: 'clase.mp3', mimeType: 'audio/mpeg', processingStage: 'ready', extractedText: 'Hola a todos.' }],
    loadTranscript: async () => null,
    buildArtifacts: async () => [{ filename: 'clase.txt', base64: 'eA==', mime: 'text/plain' }],
    saveArtifact: ({ filename, mime }) => ({ id: 'a1', filename, mime, format: 'txt' }),
    persistArtifact: async () => {},
    postMessage: async ({ chatId, content, metadata }) => {
      posted.push(content);
      messages.push({ id: 'delivered', chatId, role: 'ASSISTANT', deletedAt: null, metadata });
      return { messageId: 'delivered', chatId };
    },
    ensureChat: async ({ chatId }) => ({ chatId, created: false }),
    notify: async () => {},
  });
  const adapter = { isMediaDeliveryEnabled: () => true, createDelivery: record => service.createDelivery(record),
    handOffMessage: mediaDelivery.handOffMessage, estimateTranscriptionSeconds: mediaDelivery.estimateTranscriptionSeconds };
  const handOff = await handOffTurn({ goal: 'transcribe sin resumen', plainTranscriptionRequest: true, delivery: adapter,
    // persistAssistantMessage writes the hand-off into the same chat.
    finish: async (value) => { messages.push({ id: 'handoff', chatId: 'chat', role: 'ASSISTANT', deletedAt: null, metadata: value.metadata }); return value; } });
  assert.equal(handOff.stoppedReason, 'media_delivery_handoff');
  const id = handOff.metadata.mediaDeliveryHandoff;
  assert.ok(id);
  const outcome = await service.deliverOne(id);
  assert.equal(outcome.status, 'delivered');
  assert.equal(posted.length, 1, 'the transcript is posted even though the hand-off names the same delivery');
  assert.match(posted[0], /Hola a todos/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a translation hand-off records whether the transcript files and the summary were also asked for', async () => {
  const created = [];
  const delivery = {
    isMediaDeliveryEnabled: () => true,
    createDelivery: async (record) => { created.push(record); return { id: `md_${created.length}`, ...record }; },
    handOffMessage: () => 'Te aviso aquí.',
  };
  await handOffTurn({ goal: 'transcribe este audio, resúmelo y tradúcelo al inglés', delivery });
  await handOffTurn({ goal: 'tradúcelo al inglés', delivery });
  assert.equal(created[0].mode, 'translation');
  assert.equal(created[0].output.includeTranscript, true, '«transcribe … y tradúcelo» keeps the transcript files');
  assert.equal(created[0].output.alsoAnalysis, true, '«resúmelo y tradúcelo» keeps the summary');
  assert.equal(created[1].mode, 'translation');
  assert.equal(created[1].output.includeTranscript, false);
  assert.equal(created[1].output.alsoAnalysis, false);
});

test('ordinary words of a translation request never add a paid analysis of the recording', async () => {
  const created = [];
  const delivery = {
    isMediaDeliveryEnabled: () => true,
    createDelivery: async (record) => { created.push(record); return { id: `md_${created.length}`, ...record }; },
    handOffMessage: () => 'Te aviso aquí.',
  };
  const plain = [
    'tradúcelo al inglés para que lo entienda mi jefe',
    'traduce todo lo que dice al inglés',
    'tradúcelo al inglés tal como está',
    'tradúcelo al inglés, es para una tarea',
    'Hola, ¿cómo estás? Tradúcelo al inglés porfa',
    '¿Me lo traduces al inglés, que lo necesito para mi jefe?',
    'tradúcelo al inglés completo, no lo resumas',
    'traduce al inglés la clase de análisis matemático',
  ];
  for (const goal of plain) await handOffTurn({ goal, delivery });
  for (const [index, goal] of plain.entries()) {
    assert.equal(created[index].mode, 'translation', goal);
    assert.equal(created[index].output.alsoAnalysis, false, goal);
  }
  for (const goal of ['resúmelo y tradúcelo al inglés', 'tradúcelo al inglés y saca las ideas principales',
    'Tradúcelo al inglés. ¿De qué habla?', 'Translate it into English. What are the main topics?']) {
    await handOffTurn({ goal, delivery });
    assert.equal(created.at(-1).output.alsoAnalysis, true, goal);
  }
});

test('an inline translation runs no analysis unless one was asked for', async () => {
  const transcript = '[00:00:00] Hola a todos. Hoy vemos la mitocondria y cómo produce energía para la célula.';
  const run = async (goal) => {
    const rows = [{ id: 'clase', originalName: 'clase.mp4', processingStage: 'ready', extractedText: transcript }];
    const steps = [];
    const prompts = [];
    await runMediaBranch({
      mediaBatchRows: rows, mediaBatch: { ...batch, waitForMediaBatch: async () => ({ rows, total: 1, ready: 1, failed: 0, pending: 0, partial: 0, progress: {} }) },
      prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [], displayGoal: goal, goal,
      backfillUserMessageFilesForTranscription: async () => {}, emit: (event) => { if (event.type === 'step_start') steps.push(event.id); },
      controller: new AbortController(), runtimeBudgetMs: 60 * 60_000, startedAt: Date.now(), Buffer,
      saveArtifact: (artifact) => ({ id: artifact.filename, filename: artifact.filename }),
      artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
      plainTranscriptionRequest: false, openai: {}, task: {}, documentPolicy: {},
      require: mediaRuntime(async (messages) => {
        prompts.push(messages[0].content);
        return /^Traduce al/.test(messages[0].content) ? '[00:00:00] Hello everyone. Today we look at the mitochondria and how it makes energy for the cell.' : 'Resumen';
      }),
      ...mediaBranchHelpers(),
      throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
    });
    return { steps, analysisCalls: prompts.filter(prompt => !/^Traduce al/.test(prompt)).length };
  };
  const plain = await run('tradúcelo al inglés para que lo entienda mi jefe');
  assert.ok(plain.steps.includes('media_translation'), plain.steps.join(', '));
  assert.ok(!plain.steps.includes('media_analysis'), plain.steps.join(', '));
  assert.equal(plain.analysisCalls, 0);
  const summary = await run('resúmelo y tradúcelo al inglés');
  assert.ok(summary.steps.includes('media_analysis'), summary.steps.join(', '));
  assert.ok(summary.analysisCalls > 0);
});

test('next to a translation only an explicit deliverable or a real question asks for an analysis', () => {
  for (const goal of [
    'tradúcelo al inglés para que lo entienda mi jefe',
    'traduce todo lo que dice al inglés',
    'tradúcelo al inglés tal como está',
    'tradúcelo al inglés, es para una tarea',
    '¿Qué tal? tradúcelo al inglés',
    '¿Me das la traducción al inglés?',
    'tradúcelo al inglés completo, no lo resumas',
    "Translate it to English, don't summarize it",
    'traduce al inglés la clase de análisis matemático',
    'traduce el capítulo 3 del audiolibro al inglés',
  ]) assert.equal(batch.wantsSummaryWithTranslation(goal), false, goal);
  for (const goal of [
    'resúmelo y tradúcelo al inglés',
    'tradúcelo al inglés y hazme el acta',
    'tradúcelo al inglés y saca las ideas principales',
    'tradúcelo al inglés, ¿y quién toma la decisión final?',
    'Tradúcelo al inglés. ¿De qué habla?',
    'Translate into English and give me the key points',
    'además de la traducción al inglés, dame el acta',
  ]) assert.equal(batch.wantsSummaryWithTranslation(goal), true, goal);
  // The shared negation strip also reads «no lo resumas».
  assert.equal(batch.wantsMediaAnalysis('Transcribe el audio, no lo resumas.'), false);
});

test('a failed translation still attaches the transcript files the message points to', async () => {
  const transcript = 'Hola a todos. Hoy vemos la mitocondria y cómo produce energía para la célula.';
  const rows = [{ id: 'clase', originalName: 'clase.mp4', processingStage: 'ready', extractedText: transcript }];
  const saved = [];
  const result = await runMediaBranch({
    mediaBatchRows: rows, mediaBatch: { ...batch, waitForMediaBatch: async () => ({ rows, total: 1, ready: 1, failed: 0, pending: 0, partial: 0, progress: {} }) },
    prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [], displayGoal: 'tradúcelo al inglés', goal: 'tradúcelo al inglés',
    backfillUserMessageFilesForTranscription: async () => {}, emit() {},
    controller: new AbortController(), runtimeBudgetMs: 60 * 60_000, startedAt: Date.now(), Buffer,
    saveArtifact: (artifact) => { saved.push(artifact.filename); return { id: `a${saved.length}`, filename: artifact.filename }; },
    artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
    plainTranscriptionRequest: false, openai: {}, task: {}, documentPolicy: {},
    require: mediaRuntime(async () => { throw new Error('provider down'); }),
    ...mediaBranchHelpers(),
    throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
  });
  assert.ok(saved.length >= 1, 'the transcript pack is attached');
  assert.ok(saved.every(name => !/traducci/.test(name)), saved.join(', '));
  assert.match(result.finalMarkdown, /La transcripción completa está en los adjuntos/);
  assert.match(result.finalMarkdown, /No se pudo traducir: clase\.mp4/);
  assert.doesNotMatch(result.finalMarkdown, /La descarga adjunta conserva/);
  assert.match(result.finalMarkdown, /mitocondria/);
});

test('translation requests need a translation verb (or an asked-for translation), never a negation or a noun subject', () => {
  for (const goal of [
    'transcribe el audio en español sin traducir',
    'Transcribe la grabación de mi curso de traducción en español',
    'Resume la clase de traducción al inglés',
    '¿Qué dijo el traductor en la reunión en inglés?',
    'no lo traduzcas, solo transcríbelo en inglés',
    'no quiero que lo traduzcas al inglés',
    "don't translate it, just transcribe the english audio",
    'el debate sobre la traducción al inglés',
    'Resume la charla acerca de la traducción al portugués',
    'Transcribe the lecture on English translation theory',
  ]) assert.equal(batch.detectTranslationTarget(goal), null, goal);
  const cases = [
    ['tradúcelo al inglés', 'en'],
    ['traduce del inglés al español', 'es'],
    ['traduce la clase que está en alemán al inglés', 'en'],
    ['quiero la transcripción traducida al francés', 'fr'],
    ['transcríbelo con traducción al inglés', 'en'],
    ['dame la traducción al portugués', 'pt'],
    ['transcribe it and give me an English translation', 'en'],
    ['sin resumir, tradúcelo al inglés', 'en'],
    ['transcribe del minuto 1.5 al 10 y tradúcelo al inglés', 'en'],
    // Any phrasing that asks for «la traducción al <idioma>» counts.
    ['¿Me das la traducción al inglés?', 'en'],
    ['Quisiera la traducción al inglés', 'en'],
    ['¿Puedes hacer la traducción al inglés?', 'en'],
    ['Envíame la traducción al inglés', 'en'],
    ['Ahora la traducción al inglés', 'en'],
    ['y ahora su traducción al portugués', 'pt'],
    ['translation to English please', 'en'],
    ['English translation please', 'en'],
    ['además de la traducción al inglés, dame el acta', 'en'],
  ];
  for (const [goal, code] of cases) assert.equal(batch.detectTranslationTarget(goal)?.code, code, goal);
});

test('translations ask for the large output budget; a part cut by it is translated again in halves', async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `[00:${String(i).padStart(2, '0')}:00] Frase ${i} ${'palabra '.repeat(40)}`.trim());
  const text = lines.join('\n');
  const finals = [];
  const result = await batch.translateMediaBatch({ rows: [{ id: 'a', originalName: 'a.mp4', processingStage: 'ready', extractedText: text }],
    target: { code: 'en', name: 'inglés' }, parallel: 1,
    complete: async (messages, _signal, final) => {
      finals.push(final);
      const { transcript } = JSON.parse(messages[1].content);
      // A reply budget of 3000 characters: anything longer comes back cut.
      return transcript.length > 3000 ? transcript.slice(0, 3000) : transcript;
    } });
  assert.ok(finals.length > batch.splitTranscript(text, batch.TRANSLATION_CHUNK_CHARS).length, 'cut parts were split again');
  assert.ok(finals.every(final => final === true), 'every translation call asks for the large budget');
  assert.equal(result.failed.length, 0);
  for (const line of lines) assert.ok(result.files[0].text.includes(line), `missing: ${line.slice(0, 20)}`);
});

test('a translation that cannot fit the budget fails its file instead of delivering a shortened text', async () => {
  const text = Array.from({ length: 30 }, (_, i) => `[00:${String(i).padStart(2, '0')}:00] Frase ${i} ${'palabra '.repeat(40)}`).join('\n');
  const result = await batch.translateMediaBatch({ rows: [{ id: 'a', originalName: 'a.mp4', processingStage: 'ready', extractedText: text }],
    target: { code: 'en', name: 'inglés' }, parallel: 2,
    complete: async () => '[00:00:00] Only the beginning.' });
  assert.equal(result.files.length, 0);
  assert.deepEqual(result.failed, [{ id: 'a', name: 'a.mp4' }]);
});

test('CJK targets use smaller parts and are not judged by length', async () => {
  const text = Array.from({ length: 30 }, (_, i) => `[00:${String(i).padStart(2, '0')}:00] Frase ${i} ${'palabra '.repeat(40)}`).join('\n');
  let calls = 0;
  const result = await batch.translateMediaBatch({ rows: [{ id: 'a', originalName: 'a.mp4', processingStage: 'ready', extractedText: text }],
    target: { code: 'ja', name: 'japonés' }, parallel: 1,
    complete: async (messages) => {
      calls++;
      return JSON.parse(messages[1].content).transcript.replace(/[a-z]+/gi, '語').replace(/(語 )+/g, '語');
    } });
  assert.equal(calls, batch.splitTranscript(text, batch.TRANSLATION_CHUNK_CHARS_DENSE).length);
  assert.ok(batch.TRANSLATION_CHUNK_CHARS_DENSE < batch.TRANSLATION_CHUNK_CHARS);
  assert.equal(result.failed.length, 0);
});

test('one failed part stops its file: no new paid calls, in-flight ones aborted, nothing runs after the result', async () => {
  const text = Array.from({ length: 10 }, (_, i) => `[00:${String(i).padStart(2, '0')}:00] ${'x'.repeat(900)}`).join('\n');
  const parts = batch.splitTranscript(text, batch.TRANSLATION_CHUNK_CHARS);
  let calls = 0;
  let aborted = 0;
  const complete = async (messages, signal) => {
    calls++;
    const { part, transcript } = JSON.parse(messages[1].content);
    if (part === 2) throw new Error('provider down');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 30);
      signal?.addEventListener('abort', () => { clearTimeout(timer); aborted++; reject(signal.reason); }, { once: true });
    });
    return transcript;
  };
  const rows = [{ id: 'a', originalName: 'a.mp4', processingStage: 'ready', extractedText: text.repeat(4) }];
  const result = await batch.translateMediaBatch({ rows, target: { code: 'en', name: 'inglés' }, parallel: 3, complete });
  assert.ok(parts.length >= 1);
  assert.deepEqual(result.failed, [{ id: 'a', name: 'a.mp4' }]);
  assert.equal(calls, 3, 'only the three parts already started');
  assert.equal(aborted, 2, 'the two siblings in flight were cancelled');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(calls, 3, 'no zombie call after the file failed');
});

test('analysis stops claiming parts after one fails, too', async () => {
  const text = Array.from({ length: 12 }, (_, i) => `[0${i}:00:00] ${'y'.repeat(17000)}`).join('\n');
  let calls = 0;
  const result = await batch.analyzeMediaBatch({ rows: [{ id: 'a', originalName: 'a.mp4', processingStage: 'ready', extractedText: text }],
    goal: 'resume', parallel: 2,
    complete: async (messages, _signal, final) => {
      if (final) return 'Resumen.';
      calls++;
      const { part } = JSON.parse(messages[1].content);
      if (part === 1) throw new Error('provider down');
      await new Promise(resolve => setTimeout(resolve, 10));
      return 'nota';
    } });
  assert.deepEqual(result.failed, [{ id: 'a', name: 'a.mp4' }]);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.ok(calls <= 2, `stopped after the failure (${calls} calls)`);
});

test('a follow-up picks the newest recording: a link delivery newer than an earlier attachment wins', async () => {
  const { rows, prisma } = fixture(2);
  rows.push({ id: 'shot', userId: 'u', originalName: 'captura.png', mimeType: 'image/png', deletedAt: null, processingStage: 'ready', extractedText: null });
  const at = minute => new Date(Date.UTC(2026, 9, 10, 10, minute));
  prisma.chat = { findFirst: async ({ where }) => (where.userId === 'u' && where.id === 'chat-u' ? { id: 'chat-u' } : null) };
  let userMessages = [];
  prisma.message = {
    findMany: async ({ select }) => { assert.equal(select.timestamp, true); return userMessages; },
    findFirst: async ({ select }) => { assert.equal(select.timestamp, true); return { metadata: { transcriptionFileIds: ['f1'] }, timestamp: at(5) }; },
  };
  const resolve = () => batch.resolveChatMediaFileIds(prisma, { userId: 'u', chatId: 'chat-u' });
  userMessages = [{ files: null, timestamp: at(6) }, { files: [{ id: 'shot' }], timestamp: at(0) }];
  assert.deepEqual(await resolve(), ['f1'], 'an older screenshot does not hide the delivered recording');
  userMessages = [{ files: null, timestamp: at(6) }, { files: [{ id: 'f0' }], timestamp: at(0) }];
  assert.deepEqual(await resolve(), ['f1'], 'an older audio does not win over the newer link recording');
  userMessages = [{ files: [{ id: 'f0' }], timestamp: at(9) }];
  assert.deepEqual(await resolve(), ['f0'], 'an audio attached after the delivery wins');
  userMessages = [{ files: [{ id: 'shot' }], timestamp: at(9) }];
  assert.deepEqual(await resolve(), [], 'a newer document still stops the lookup');
});
