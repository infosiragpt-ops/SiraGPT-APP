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

test('101 media files produce explicit limit (a batch holds 100); mixed documents retain their own workflow', async () => {
  assert.equal(batch.MAX_MEDIA_FILES, 100);
  const { rows, prisma } = fixture(101);
  await assert.rejects(batch.loadMediaBatch(prisma, { userId: 'u', fileIds: rows.map(row => row.id) }), /100/);
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

test('a resume scoped to some recordings re-queues only those stopped ones', async () => {
  const { rows, prisma } = fixture(3);
  const { CANCELLED_NOTE } = require('../src/services/media-transcription-queue');
  rows.forEach(row => Object.assign(row, { processingStage: 'failed', processingError: CANCELLED_NOTE, extractedText: null }));
  const queued = async (resumeStopped) => {
    const enqueued = [];
    await batch.waitForMediaBatch({ prisma, userId: 'u', rows: rows.map(row => ({ ...row })), resumeStopped,
      enqueue: async ({ fileId, retry }) => { enqueued.push([fileId, retry]); return { queued: false, stage: 'failed' }; },
      wait: async () => {}, timeoutMs: 0 });
    return enqueued;
  };
  assert.deepEqual(await queued([rows[1].id]), [[rows[1].id, true]]);
  assert.deepEqual((await queued(true)).map(([id]) => id), rows.map(row => row.id));
  assert.deepEqual(await queued(false), []);
  assert.deepEqual(await queued([]), [], 'an empty scope resumes nothing');
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

test('the ordinary words of a transcript request never run a paid analysis; a deliverable or a real question does', () => {
  for (const goal of ['transcribe estos 100 videos de la clase de sistemas operativos', 'transcribe todo lo que dicen',
    'transcribe las clases del tema 3', 'transcribe este audio, es para una tarea', 'transcríbeme cómo lo dijo el profesor',
    'transcribe la clase de análisis matemático', 'transcribe la reunión, quién dijo qué', 'transcribe y compártelo',
    // Words of the asks below, without their asking verb.
    'transcribe y dime cuando termines', 'transcribe y dime que lo recibiste', 'transcribe la clase de temas selectos de física',
    'transcribe las preguntas del examen que dicta', 'transcribe el tema 3 y el tema 4', 'transcribe, son preguntas de una entrevista',
    'transcribe las notas de voz', 'transcribe la clase, son mis notas']) {
    assert.equal(batch.wantsMediaAnalysis(goal), false, goal);
  }
  for (const goal of ['transcribe y dame el acta', 'transcribe la reunión y extrae las decisiones', 'transcribe las dos clases y compáralas',
    'transcribe, ¿y de qué habla?', 'transcribe y explícame la parte difícil', 'transcribe y lista los próximos pasos',
    // The topics, study questions and what it says, asked outright.
    'transcribe la clase y dime los temas', 'transcribe y dame los 3 temas principales', 'transcribe y los temas que se tocan',
    'transcribe la clase y hazme 5 preguntas', 'transcríbelo y genérame unas preguntas',
    'transcribe y dime de qué trata', 'transcribe y dime de que habla', 'transcribe y cuéntame qué dijo el profesor',
    // Ending in an accented letter («habló»), study notes, insights, answers to its questions.
    'transcribe la reunión y dime quién habló más', 'transcribe y dime qué pasó', 'transcribe la clase y hazme notas de clase',
    'transcribe la entrevista y dame los insights', 'transcribe el audio y responde las preguntas del profesor']) {
    assert.equal(batch.wantsMediaAnalysis(goal), true, goal);
  }
  // A request about the recording itself keeps the broad reading, accented «qué» included.
  for (const goal of ['¿de qué habla el audio?', 'qué dice el profesor sobre el tema 3', 'analiza este audio']) {
    assert.equal(batch.wantsMediaAnalysis(goal), true, goal);
  }
  assert.equal(batch.wantsMediaAnalysis('lo de sistemas operativos'), false, '«tema» inside «sistemas» is not a cue');
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

// ── contract C7: follow-ups that act («revisa el minuto 12», «¿qué dijo en el minuto 95?») ──

test('follow-up intents: refine a heard-wrong stretch, look up a moment, ignore everything else', () => {
  const intent = goal => batch.detectMediaFollowupIntent(goal);
  assert.deepEqual(intent('revisa el minuto 12, se escuchó mal'), { kind: 'refine', range: { start: 690, end: 810 }, at: 720 });
  assert.deepEqual(intent('vuelve a transcribir de 1:10:00 a 1:15:00'), { kind: 'refine', range: { start: 4200, end: 4500 } });
  assert.deepEqual(intent('del minuto 12 al 15 está mal'), { kind: 'refine', range: { start: 720, end: 900 } });
  assert.deepEqual(intent('revisa la transcripción, se escuchó mal'), { kind: 'refine', range: null, whole: false });
  assert.deepEqual(intent('vuelve a transcribir el audio'), { kind: 'refine', range: null, whole: true });
  assert.deepEqual(intent('¿Qué dijo el profesor en el minuto 95?'), { kind: 'lookup', range: { start: 5640, end: 5940 }, at: 5700 });
  assert.deepEqual(intent('qué dice en el minuto 1:35:00'), { kind: 'lookup', range: { start: 5640, end: 5940 }, at: 5700 });
  assert.deepEqual(intent('¿de qué hablan del minuto 30 al 45?'), { kind: 'lookup', range: { start: 1800, end: 2700 } });
  assert.equal(intent('¿qué pasó a los 30 minutos?').at, 1800);
  for (const goal of ['agenda una reunión de 10:00 a 11:00', 'revisa la reunión de las 10:30', 'corrige los nombres', 'qué hora es',
    'analiza el código', 'resume del minuto 30 al 45', 'transcribe del minuto 30 al 45', '']) {
    assert.equal(intent(goal), null, goal);
  }
  assert.equal(batch.isMediaFollowup('¿qué dijo en el minuto 95?'), true, 'a moment of the recording resolves the chat batch');
  assert.equal(batch.isMediaFollowup('revisa el minuto 12, se escuchó mal'), true);
  assert.equal(batch.isMediaFollowup('analiza el código de mi proyecto'), false);
});

test('a time point is a moment of the recording, never a time of day', () => {
  assert.equal(batch.parseTimePoint('el minuto 95'), 5700);
  assert.equal(batch.parseTimePoint('minuto 95:10'), 5710);
  assert.equal(batch.parseTimePoint('minuto 1,5'), 90);
  assert.equal(batch.parseTimePoint('a los 12 minutos'), 720);
  assert.equal(batch.parseTimePoint('la hora 1:20'), 4800);
  assert.equal(batch.parseTimePoint('1h20'), 4800);
  assert.equal(batch.parseTimePoint('en el 45:10'), 2710);
  assert.equal(batch.parseTimePoint('en 01:02:03'), 3723);
  assert.equal(batch.parseTimePoint('a las 10:30'), null);
  assert.equal(batch.parseTimePoint('la reunión de las 10:30:00'), null);
  assert.equal(batch.parseTimePoint('hola'), null);
});

function refineFakes({ enqueue, createDelivery } = {}) {
  const log = [];
  const delivery = {
    isMediaDeliveryEnabled: () => true,
    createDelivery: createDelivery || (async (record) => { log.push(['delivery', record]); return { id: 'md_r', ...record }; }),
    refineHandOffMessage: ({ fileName, range }) => `Voy a volver a transcribir ${range.start}–${range.end} de «${fileName}».`,
    getMediaDeliveryService: () => ({ store: { claim: async () => ({ token: 't' }), markFailed: async (id) => { log.push(['cancel', id]); return {}; } } }),
  };
  const enqueueRefine = enqueue || (async (payload) => { log.push(['enqueue', payload]); return { queued: true, jobId: 'j' }; });
  const transcriptStore = { loadMediaTranscript: async () => ({ durationSec: 3600, timeOffsetSec: 0 }) };
  return { log, deps: { delivery, enqueueRefine, transcriptStore } };
}

const readyRow = (id, name, extra = {}) => ({ id, originalName: name, processingStage: 'ready', extractedText: 'texto listo', ...extra });

test('requestMediaRefine: delivery first, then the refine job with its id; bounded to the recording', async () => {
  const f = refineFakes();
  const out = await batch.requestMediaRefine({ prisma: {}, userId: 'u', chatId: 'c', taskId: 't', rows: [readyRow('a', 'clase.mp4')],
    goal: 'revisa del minuto 50 al 70', intent: { kind: 'refine', range: { start: 3000, end: 4200 } }, language: 'en', hints: { terms: ['Huamán'] }, deps: f.deps });
  assert.equal(out.ok, true);
  assert.deepEqual(f.log.map(([kind]) => kind), ['delivery', 'enqueue']);
  assert.deepEqual(f.log[0][1].range, { start: 3000, end: 3600 }, 'clamped to the end of the recording');
  assert.equal(f.log[0][1].kind, 'refine');
  assert.deepEqual(f.log[1][1], { fileId: 'a', userId: 'u', range: { start: 3000, end: 3600 }, language: 'en', hints: { terms: ['Huamán'] }, deliveryId: 'md_r' });
  assert.match(out.message, /de «clase\.mp4»/);
  assert.equal(out.deliveryId, 'md_r');
});

test('requestMediaRefine asks instead of guessing, and never leaves a delivery without a job', async () => {
  const two = [readyRow('a', 'Clase de anatomía.mp4'), readyRow('b', 'Reunión directorio.m4a')];
  const ambiguous = await batch.requestMediaRefine({ userId: 'u', chatId: 'c', rows: two, goal: 'revisa el minuto 12, se escuchó mal',
    intent: { kind: 'refine', range: { start: 690, end: 810 } }, deps: refineFakes().deps });
  assert.equal(ambiguous.reason, 'file_ambiguous');
  assert.match(ambiguous.message, /«Clase de anatomía\.mp4», «Reunión directorio\.m4a»/);
  const named = refineFakes();
  const picked = await batch.requestMediaRefine({ userId: 'u', chatId: 'c', rows: two, goal: 'revisa el minuto 12 de la reunión directorio, se escuchó mal',
    intent: { kind: 'refine', range: { start: 690, end: 810 } }, deps: named.deps });
  assert.equal(picked.fileId, 'b');
  const noRange = await batch.requestMediaRefine({ userId: 'u', chatId: 'c', rows: [two[0]], goal: 'se escuchó mal',
    intent: { kind: 'refine', range: null, whole: false }, deps: refineFakes().deps });
  assert.equal(noRange.reason, 'range_required');
  assert.match(noRange.message, /de qué minuto a qué minuto/);
  const longWhole = refineFakes();
  longWhole.deps.transcriptStore = { loadMediaTranscript: async () => ({ durationSec: 5 * 3600 }) };
  const whole = await batch.requestMediaRefine({ userId: 'u', chatId: 'c', rows: [two[0]], goal: 'vuelve a transcribir el audio',
    intent: { kind: 'refine', range: null, whole: true }, deps: longWhole.deps });
  assert.equal(whole.reason, 'range_required', 'a 5-hour recording is never re-done whole by accident');
  const pending = await batch.requestMediaRefine({ userId: 'u', chatId: 'c', rows: [{ id: 'p', processingStage: 'extracting', extractedText: null }],
    intent: { kind: 'refine', range: { start: 0, end: 60 } }, deps: refineFakes().deps });
  assert.equal(pending.handled, false, 'not ready: the turn keeps its normal flow');
  const refused = refineFakes({ enqueue: async () => ({ queued: false, reason: 'not_ready' }) });
  const notQueued = await batch.requestMediaRefine({ userId: 'u', chatId: 'c', rows: [two[0]], goal: 'x',
    intent: { kind: 'refine', range: { start: 0, end: 60 } }, deps: refined(refused) });
  assert.equal(notQueued.ok, false);
  assert.deepEqual(refused.log.map(([kind]) => kind), ['delivery', 'cancel']);
  function refined(f) { return f.deps; }
});

test('the runner re-transcribes a heard-wrong stretch without waiting or re-sending the transcript', async () => {
  const rows = [readyRow('clase', 'clase.mp4')];
  const calls = [];
  const delivery = { isMediaDeliveryEnabled: () => true };
  const result = await runMediaBranch({
    mediaBatchRows: rows, displayGoal: 'revisa el minuto 12, se escuchó mal; el profe se llama Ccori, no Kori', goal: 'x',
    mediaBatch: { ...batch,
      waitForMediaBatch: async () => assert.fail('a refine never waits for the batch'),
      requestMediaRefine: async (args) => { calls.push(args); return { handled: true, ok: true, fileId: 'clase', range: args.intent.range, deliveryId: 'md_9', message: 'Voy a volver a transcribir el tramo.' }; } },
    prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [],
    backfillUserMessageFilesForTranscription: async () => {}, emit() {},
    controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
    saveArtifact: () => assert.fail('no files for a refine request'), artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
    plainTranscriptionRequest: false, openai: {}, task: {}, documentPolicy: {},
    require: (name) => require(name === '../media-transcript-artifacts' ? '../src/services/media-transcript-artifacts' : name),
    ...mediaBranchHelpers({ loadMediaDeliveryService: () => delivery }),
    throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].intent)), { kind: 'refine', range: { start: 690, end: 810 }, at: 720 });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].hints)), { terms: ['Ccori'] });
  assert.equal(calls[0].deps.delivery, delivery);
  assert.equal(result.finalMarkdown, 'Voy a volver a transcribir el tramo.');
  assert.equal(result.stoppedReason, 'media_delivery_handoff', 'no generic «task finished» notification: the refine delivery notifies');
  assert.equal(result.metadata.mediaDeliveryHandoff, 'md_9');
  assert.equal(result.metadata.mediaDelivery, undefined, 'the hand-off never counts as the delivered transcript');
});

test('a refine on one recording of a batch hands off only that recording', async () => {
  // The follow-up carries the whole batch; the refine delivery covers one file.
  // A hand-off listing all three never settles and keeps Stop on for good.
  const rows = [readyRow('v0', 'clase1.mp4'), readyRow('v1', 'clase2.mp4'), readyRow('v2', 'clase3.mp4')];
  const delivery = { isMediaDeliveryEnabled: () => true };
  const run = (refinedReply) => runMediaBranch({
    mediaBatchRows: rows, displayGoal: 'revisa del minuto 12 al 15 de clase3, se escuchó mal', goal: 'x',
    mediaBatch: { ...batch,
      waitForMediaBatch: async () => assert.fail('a refine never waits for the batch'),
      requestMediaRefine: async () => refinedReply },
    prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [],
    backfillUserMessageFilesForTranscription: async () => {}, emit() {},
    controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
    saveArtifact: () => assert.fail('no files for a refine request'), artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
    plainTranscriptionRequest: false, openai: {}, task: {}, documentPolicy: {},
    require: (name) => require(name === '../media-transcript-artifacts' ? '../src/services/media-transcript-artifacts' : name),
    ...mediaBranchHelpers({ loadMediaDeliveryService: () => delivery }),
    throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
  });
  const handed = await run({ handled: true, ok: true, fileId: 'v2', range: { start: 720, end: 900 }, deliveryId: 'md_ref', message: 'Voy a volver a transcribir el tramo.' });
  assert.equal(handed.metadata.mediaDeliveryHandoff, 'md_ref');
  assert.deepEqual([...handed.metadata.transcriptionFileIds], ['v2']);
  // Without a delivery the message is not a hand-off and keeps naming the batch.
  const queued = await run({ handled: true, ok: true, fileId: 'v2', range: { start: 720, end: 900 }, deliveryId: null, message: 'Lo vuelvo a transcribir.' });
  assert.equal(queued.metadata.mediaDeliveryHandoff, undefined);
  assert.deepEqual([...queued.metadata.transcriptionFileIds].sort(), ['v0', 'v1', 'v2']);
});

test('the runner answers «¿qué dijo en el minuto 95?» from that window, without re-sending the transcript files', async () => {
  // «la transcripción» named as what the question reads from is not a request for it.
  for (const displayGoal of ['¿qué dijo el profesor en el minuto 95?', '¿qué dice la transcripción en el minuto 95?',
    'según la transcripción, ¿qué dijo en el minuto 95?']) {
    const rows = [readyRow('clase', 'clase.mp4', { extractedText: 'x'.repeat(50) })];
    const ranges = [];
    const analysed = [];
    const packs = [];
    const result = await runMediaBranch({
      mediaBatchRows: rows, displayGoal, goal: 'x',
      mediaBatch: { ...batch, waitForMediaBatch: async () => ({ rows, total: 1, ready: 1, failed: 0, pending: 0, partial: 0, progress: {} }),
        analyzeMediaBatch: async ({ rows: analysedRows, goal }) => { analysed.push({ analysedRows, goal }); return { text: 'En el minuto 95 explicó la mitocondria.', summaries: [{}], failed: [] }; } },
      prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [],
      backfillUserMessageFilesForTranscription: async () => {}, emit() {},
      controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
      saveArtifact: () => assert.fail('a question about a moment does not re-send the transcript files'),
      artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
      plainTranscriptionRequest: false, openai: { chat: { completions: { create: async () => ({}) } } }, task: {}, documentPolicy: {},
      require: (name) => {
        if (name === '../media-transcript-artifacts') {
          const realArtifacts = require('../src/services/media-transcript-artifacts');
          return { ...realArtifacts, buildMediaTranscriptArtifacts: async (args) => { packs.push(args.output); return realArtifacts.buildMediaTranscriptArtifacts(args); } };
        }
        if (name === '../media-analysis-runtime') return { createMediaAnalysisCompletion: () => ({ complete: async () => 'ok', usage: null }) };
        return require(name);
      },
      ...mediaBranchHelpers({ mediaRowsForAnalysis: (r, transcripts, range) => { ranges.push(range); return r; } }),
      throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
    });
    assert.equal(packs.length, 0, `no transcript pack for a question about a moment: ${displayGoal}`);
    assert.deepEqual(JSON.parse(JSON.stringify(ranges)), [{ start: 5640, end: 5940 }], `the analysis reads the window around minute 95: ${displayGoal}`);
    assert.equal(analysed.length, 1);
    assert.match(result.finalMarkdown, /explicó la mitocondria/);
    assert.equal(result.stoppedReason, 'transcription_finalize');
  }
});

// ── verifier fixes: content questions and deliverables are never a refine ──

test('a question or a deliverable about a stretch is never turned into «transcribe it again»', () => {
  const intent = goal => batch.detectMediaFollowupIntent(goal);
  for (const goal of [
    'Revisa del minuto 30 al 40 y hazme un resumen',
    'Resume este audio, del minuto 1 al 3 casi no se escucha',
    '¿Del minuto 10 al 15 lo que explica el profesor está mal?',
    'En el minuto 20 el ponente dice algo que no tiene sentido, explícame por qué',
    'Revisa el minuto 12 y dime si el profesor tiene razón',
    'Analiza la grabación: del minuto 5 al 10 hay errores en la exposición',
    'corrige la hora 1:20 en el documento',
  ]) {
    assert.notEqual(intent(goal)?.kind, 'refine', goal);
  }
  // Questions about what is said at that moment read its window instead.
  assert.equal(intent('Revisa el minuto 12 y dime si el profesor tiene razón').kind, 'lookup');
  assert.equal(intent('En el minuto 20 el ponente dice algo que no tiene sentido, explícame por qué').kind, 'lookup');
  // What really points at the transcript still re-transcribes.
  assert.equal(intent('la transcripción del minuto 30 está mal').kind, 'refine');
  assert.equal(intent('el texto del minuto 5 tiene errores').kind, 'refine');
  assert.equal(intent('revisa el minuto 12 porque se escuchó mal').kind, 'refine');
  assert.equal(intent('los nombres son Huamán y Quispe, corrígelo en el minuto 30').kind, 'refine');
  // An explicit «vuelve a transcribir» next to another request is kept, flagged.
  assert.deepEqual(intent('vuelve a transcribir del minuto 10 al 15 y dime qué dice'), { kind: 'refine', range: { start: 600, end: 900 }, alsoAsks: true });
});

test('a refine before a link clip\'s start answers with the covered span, never an invalid range', async () => {
  const f = refineFakes();
  f.deps.transcriptStore = { loadMediaTranscript: async () => ({ durationSec: 1800, timeOffsetSec: 3600 }) };
  const before = await batch.requestMediaRefine({ userId: 'u', chatId: 'c', rows: [readyRow('a', 'clip.m4a')], goal: 'revisa el minuto 10, se escuchó mal',
    intent: { kind: 'refine', range: { start: 570, end: 690 }, at: 600 }, deps: f.deps });
  assert.equal(before.reason, 'out_of_range');
  assert.match(before.message, /cubre 01:00:00–01:30:00 de la grabación; el tramo que pides queda fuera/);
  assert.deepEqual(f.log, [], 'nothing queued');
  const overlap = await batch.requestMediaRefine({ userId: 'u', chatId: 'c', rows: [readyRow('a', 'clip.m4a')], goal: 'x',
    intent: { kind: 'refine', range: { start: 3500, end: 3700 } }, deps: f.deps });
  assert.equal(overlap.ok, true);
  assert.deepEqual(overlap.range, { start: 3600, end: 3700 }, 'a stretch that overlaps the clip is clamped to it');
});

test('the runner queues an explicit refine and still answers the rest of the request', async () => {
  const rows = [readyRow('clase', 'clase.mp4', { extractedText: 'x'.repeat(50) })];
  const calls = [];
  const analysed = [];
  const result = await runMediaBranch({
    mediaBatchRows: rows, displayGoal: 'vuelve a transcribir del minuto 10 al 15 y resúmelo', goal: 'x',
    mediaBatch: { ...batch,
      waitForMediaBatch: async () => ({ rows, total: 1, ready: 1, failed: 0, pending: 0, partial: 0, progress: {} }),
      requestMediaRefine: async (args) => { calls.push(args); return { handled: true, ok: true, fileId: 'clase', range: args.intent.range, deliveryId: 'md_7', message: 'Voy a volver a transcribir el tramo 00:10:00–00:15:00.' }; },
      analyzeMediaBatch: async ({ goal }) => { analysed.push(goal); return { text: 'Resumen de la clase.', summaries: [{}], failed: [] }; } },
    prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [],
    backfillUserMessageFilesForTranscription: async () => {}, emit() {},
    controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
    saveArtifact: (artifact) => ({ id: 'a', filename: artifact.filename }), artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
    plainTranscriptionRequest: false, openai: { chat: { completions: { create: async () => ({}) } } }, task: {}, documentPolicy: {},
    require: (name) => {
      if (name === '../media-transcript-artifacts') return require('../src/services/media-transcript-artifacts');
      if (name === '../media-analysis-runtime') return { createMediaAnalysisCompletion: () => ({ complete: async () => 'ok', usage: null }) };
      return require(name);
    },
    ...mediaBranchHelpers(),
    throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
  });
  assert.equal(calls.length, 1, 'the refine is queued');
  assert.equal(analysed.length, 1, 'and the summary still runs');
  assert.match(result.finalMarkdown, /^Voy a volver a transcribir el tramo 00:10:00–00:15:00\./);
  assert.match(result.finalMarkdown, /Resumen de la clase\./);
  assert.notEqual(result.stoppedReason, 'media_delivery_handoff', 'the turn answered: its own notification applies');
});

// ── a moment asked about in a FIRST transcription request ──────────────────

test('«transcribe este audio y dime qué dice en el minuto 30» delivers the whole transcript; the moment only narrows the answer', async () => {
  const { isPlainTranscriptionRequest } = require('../src/services/message-attachments');
  const realArtifacts = require('../src/services/media-transcript-artifacts');
  // Asking for the transcript in other words is still asking for it.
  for (const displayGoal of ['transcribe este audio y dime qué dice en el minuto 30',
    '¿me puedes pasar la transcripción y decirme qué dice en el minuto 30?', 'la transcripción completa y qué dice en el minuto 30, porfa',
    'me haces la transcripción y me dices qué dice en el minuto 30']) {
    const rows = [readyRow('clase', 'clase.mp3', { extractedText: 'x'.repeat(50) })];
    const ranges = [];
    const packs = [];
    const saved = [];
    const result = await runMediaBranch({
      mediaBatchRows: rows, displayGoal, goal: 'x',
      mediaBatch: { ...batch, waitForMediaBatch: async () => ({ rows, total: 1, ready: 1, failed: 0, pending: 0, partial: 0, progress: {} }),
        analyzeMediaBatch: async () => ({ text: 'En el minuto 30 explicó la mitocondria.', summaries: [{}], failed: [] }) },
      prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [],
      backfillUserMessageFilesForTranscription: async () => {}, emit() {},
      controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
      saveArtifact: (artifact) => { saved.push(artifact.filename); return { id: `a${saved.length}`, filename: artifact.filename }; },
      artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
      plainTranscriptionRequest: isPlainTranscriptionRequest(displayGoal), openai: { chat: { completions: { create: async () => ({}) } } }, task: {}, documentPolicy: {},
      require: (name) => {
        if (name === '../media-transcript-artifacts') {
          return { ...realArtifacts, buildMediaTranscriptArtifacts: async (args) => { packs.push(args.output); return realArtifacts.buildMediaTranscriptArtifacts(args); } };
        }
        if (name === '../media-analysis-runtime') return { createMediaAnalysisCompletion: () => ({ complete: async () => 'ok', usage: null }) };
        return require(name);
      },
      ...mediaBranchHelpers({ mediaRowsForAnalysis: (r, transcripts, range) => { ranges.push(range); return r; } }),
      throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(ranges)), [{ start: 1740, end: 2040 }], `the answer reads the window around minute 30: ${displayGoal}`);
    assert.equal(packs.length, 1, `the transcript asked for is still saved: ${displayGoal}`);
    assert.equal(packs[0].range, null, `whole, never cut to the 5-minute window: ${displayGoal}`);
    assert.ok(saved.length >= 1);
    assert.match(result.finalMarkdown, /explicó la mitocondria/);
  }
});

test('a long first request with a moment hands off the WHOLE transcript and passes the moment as the analysis range', async () => {
  for (const displayGoal of ['transcribe la clase en Word y dime qué explicó el profesor en el minuto 40',
    '¿me puedes pasar la transcripción en Word y decirme qué explicó el profesor en el minuto 40?']) {
    const rows = [{ id: 'clase', originalName: 'clase.mp4', processingStage: 'extracting', extractedText: null, size: 4e9 }];
    const created = [];
    const delivery = {
      isMediaDeliveryEnabled: () => true,
      estimateTranscriptionSeconds: ({ durationSec }) => Math.round(durationSec * 0.15),
      createDelivery: async (record) => { created.push(record); return { id: 'md_w', ...record }; },
      handOffMessage: () => 'Te aviso aquí.',
    };
    const result = await runMediaBranch({
      mediaBatchRows: rows, displayGoal, goal: 'x',
      mediaBatch: { ...batch, waitForMediaBatch: async () => ({ rows, total: 1, ready: 0, failed: 0, pending: 1, partial: 0,
        progress: { clase: { durationSeconds: 18000, completed: 1, total: 30 } }, stoppedEarly: true }) },
      prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [],
      backfillUserMessageFilesForTranscription: async () => {}, emit() {},
      controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
      saveArtifact: () => { throw new Error('no artifacts before the transcript exists'); },
      artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
      plainTranscriptionRequest: false, openai: {}, task: {}, documentPolicy: {},
      require: (name) => require(name === '../media-transcript-artifacts' ? '../src/services/media-transcript-artifacts' : name),
      ...mediaBranchHelpers({ loadMediaDeliveryService: () => delivery }),
      throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
    });
    assert.equal(result.stoppedReason, 'media_delivery_handoff');
    assert.equal(created.length, 1);
    assert.equal(created[0].range, null, 'the transcript files are never cut to the moment asked about');
    assert.deepEqual(JSON.parse(JSON.stringify(created[0].output.analysisRange)), { start: 2340, end: 2640 });
    assert.equal(created[0].output.includeTranscript, true, displayGoal);
    assert.equal(created[0].output.documentFormat, 'docx');
  }
});

// ── a moment asked about next to a translation; a refine's language ────────

test('«tradúcela y dime qué dice en el minuto 30» translates the WHOLE recording and answers the moment from its window', async () => {
  const realArtifacts = require('../src/services/media-transcript-artifacts');
  for (const [displayGoal, window, transcriptPack] of [
    ['traduce la clase al inglés y dime qué dice en el minuto 30', { start: 1740, end: 2040 }, false],
    ['transcribe y traduce al inglés, y dime qué explicó en el minuto 40', { start: 2340, end: 2640 }, true]]) {
    const rows = [readyRow('clase', 'clase.mp3', { extractedText: 'x'.repeat(50) })];
    const ranges = [];
    const translated = [];
    const analysed = [];
    const packs = [];
    const result = await runMediaBranch({
      mediaBatchRows: rows, displayGoal, goal: 'x',
      mediaBatch: { ...batch, waitForMediaBatch: async () => ({ rows, total: 1, ready: 1, failed: 0, pending: 0, partial: 0, progress: {} }),
        translateMediaBatch: async ({ rows: translatedRows }) => { translated.push(translatedRows); return { files: [{ name: 'clase.mp3', text: 'Good morning.' }], failed: [] }; },
        analyzeMediaBatch: async ({ goal }) => { analysed.push(goal); return { text: 'En ese momento explicó la mitocondria.', summaries: [{}], failed: [] }; } },
      prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [],
      backfillUserMessageFilesForTranscription: async () => {}, emit() {},
      controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
      saveArtifact: (artifact) => ({ id: 'a', filename: artifact.filename }),
      artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
      plainTranscriptionRequest: false, openai: { chat: { completions: { create: async () => ({}) } } }, task: {}, documentPolicy: {},
      require: (name) => {
        if (name === '../media-transcript-artifacts') {
          return { ...realArtifacts,
            buildMediaTranscriptArtifacts: async (args) => { packs.push(args.output); return realArtifacts.buildMediaTranscriptArtifacts(args); },
            buildTranslationArtifacts: async () => ({ artifacts: [{ filename: 'clase-en.txt', base64: '', mime: 'text/plain' }], notes: [] }) };
        }
        if (name === '../media-analysis-runtime') return { createMediaAnalysisCompletion: () => ({ complete: async () => 'ok', usage: null }) };
        return require(name);
      },
      ...mediaBranchHelpers({ mediaRowsForAnalysis: (r, transcripts, range) => { ranges.push(range); return r; } }),
      throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
    });
    // The translation reads the user's range (none: the whole recording); the answer reads the moment.
    assert.deepEqual(JSON.parse(JSON.stringify(ranges)), [null, window], displayGoal);
    assert.equal(translated.length, 1, displayGoal);
    assert.equal(analysed.length, 1, `the question about the moment is answered: ${displayGoal}`);
    assert.match(result.finalMarkdown, /explicó la mitocondria/, displayGoal);
    assert.match(result.finalMarkdown, /Traducción completa al inglés/, displayGoal);
    assert.equal(packs.length, transcriptPack ? 1 : 0, displayGoal);
    if (transcriptPack) assert.equal(packs[0].range, null, `the transcript asked for stays whole: ${displayGoal}`);
  }
});

test('a translation in the same turn hands the translator the user\'s conditions («deja los nombres propios en español»)', async () => {
  const realArtifacts = require('../src/services/media-transcript-artifacts');
  const rows = [readyRow('clase', 'clase.mp3', { extractedText: 'x'.repeat(50) })];
  const asked = [];
  const result = await runMediaBranch({
    mediaBatchRows: rows, displayGoal: 'traduce la clase al inglés pero deja los nombres propios en español', goal: 'x',
    mediaBatch: { ...batch, waitForMediaBatch: async () => ({ rows, total: 1, ready: 1, failed: 0, pending: 0, partial: 0, progress: {} }),
      translateMediaBatch: async ({ conditions }) => { asked.push(conditions); return { files: [{ name: 'clase.mp3', text: 'Good morning, Juan Pérez.' }], failed: [] }; } },
    prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [],
    backfillUserMessageFilesForTranscription: async () => {}, emit() {},
    controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
    saveArtifact: (artifact) => ({ id: 'a', filename: artifact.filename }),
    artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
    plainTranscriptionRequest: false, openai: { chat: { completions: { create: async () => ({}) } } }, task: {}, documentPolicy: {},
    require: (name) => {
      if (name === '../media-transcript-artifacts') {
        return { ...realArtifacts, buildTranslationArtifacts: async () => ({ artifacts: [{ filename: 'clase-en.txt', base64: '', mime: 'text/plain' }], notes: [] }) };
      }
      if (name === '../media-analysis-runtime') return { createMediaAnalysisCompletion: () => ({ complete: async () => 'ok', usage: null }) };
      return require(name);
    },
    ...mediaBranchHelpers(),
    throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
  });
  assert.equal(asked.length, 1);
  assert.ok(Array.isArray(asked[0]) && asked[0].some(item => /deja los nombres propios en español/.test(item)), JSON.stringify(asked[0]));
  assert.match(result.finalMarkdown, /al inglés/);
});

test('a long «tradúcela y dime qué dice en el minuto 30» hands off a whole translation plus the answer for that moment', async () => {
  const rows = [{ id: 'clase', originalName: 'clase.mp4', processingStage: 'extracting', extractedText: null, size: 4e9 }];
  const created = [];
  const delivery = {
    isMediaDeliveryEnabled: () => true,
    estimateTranscriptionSeconds: ({ durationSec }) => Math.round(durationSec * 0.15),
    createDelivery: async (record) => { created.push(record); return { id: 'md_t', ...record }; },
    handOffMessage: () => 'Te aviso aquí.',
  };
  const result = await runMediaBranch({
    mediaBatchRows: rows, displayGoal: 'traduce la clase al inglés y dime qué dice en el minuto 30', goal: 'x',
    mediaBatch: { ...batch, waitForMediaBatch: async () => ({ rows, total: 1, ready: 0, failed: 0, pending: 1, partial: 0,
      progress: { clase: { durationSeconds: 18000, completed: 1, total: 30 } }, stoppedEarly: true }) },
    prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [],
    backfillUserMessageFilesForTranscription: async () => {}, emit() {},
    controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
    saveArtifact: () => { throw new Error('no artifacts before the transcript exists'); },
    artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
    plainTranscriptionRequest: false, openai: {}, task: {}, documentPolicy: {},
    require: (name) => require(name === '../media-transcript-artifacts' ? '../src/services/media-transcript-artifacts' : name),
    ...mediaBranchHelpers({ loadMediaDeliveryService: () => delivery }),
    throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
  });
  assert.equal(result.stoppedReason, 'media_delivery_handoff');
  assert.equal(created.length, 1);
  assert.equal(created[0].mode, 'translation');
  assert.equal(created[0].range, null, 'the translation covers the whole recording');
  assert.deepEqual(JSON.parse(JSON.stringify(created[0].output.analysisRange)), { start: 1740, end: 2040 });
  assert.equal(created[0].output.alsoAnalysis, true, 'the moment asked about is answered too');
});

test('«traduce al inglés lo que dice en el minuto 30» translates exactly that moment, with no analysis', async () => {
  const realArtifacts = require('../src/services/media-transcript-artifacts');
  const inline = async (displayGoal) => {
    const rows = [readyRow('clase', 'clase.mp3', { extractedText: 'x'.repeat(50) })];
    const ranges = [];
    const analysed = [];
    const result = await runMediaBranch({
      mediaBatchRows: rows, displayGoal, goal: 'x',
      mediaBatch: { ...batch, waitForMediaBatch: async () => ({ rows, total: 1, ready: 1, failed: 0, pending: 0, partial: 0, progress: {} }),
        translateMediaBatch: async () => ({ files: [{ name: 'clase.mp3', text: '[00:30:00] Good morning, class.' }], failed: [] }),
        analyzeMediaBatch: async ({ goal }) => { analysed.push(goal); return { text: 'En ese momento explicó la mitocondria.', summaries: [{}], failed: [] }; } },
      prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [],
      backfillUserMessageFilesForTranscription: async () => {}, emit() {},
      controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
      saveArtifact: (artifact) => ({ id: 'a', filename: artifact.filename }),
      artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
      plainTranscriptionRequest: false, openai: { chat: { completions: { create: async () => ({}) } } }, task: {}, documentPolicy: {},
      require: (name) => {
        if (name === '../media-transcript-artifacts') {
          return { ...realArtifacts, buildTranslationArtifacts: async () => ({ artifacts: [{ filename: 'clase-en.txt', base64: '', mime: 'text/plain' }], notes: [] }) };
        }
        if (name === '../media-analysis-runtime') return { createMediaAnalysisCompletion: () => ({ complete: async () => 'ok', usage: null }) };
        return require(name);
      },
      ...mediaBranchHelpers({ mediaRowsForAnalysis: (r, transcripts, range) => { ranges.push(range); return r; } }),
      throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
    });
    return { result, ranges: JSON.parse(JSON.stringify(ranges)), analysed };
  };
  const handOff = async (displayGoal) => {
    const rows = [{ id: 'clase', originalName: 'clase.mp4', processingStage: 'extracting', extractedText: null, size: 4e9 }];
    const created = [];
    const delivery = {
      isMediaDeliveryEnabled: () => true,
      estimateTranscriptionSeconds: ({ durationSec }) => Math.round(durationSec * 0.15),
      createDelivery: async (record) => { created.push(record); return { id: 'md_m', ...record }; },
      handOffMessage: () => 'Te aviso aquí.',
    };
    const result = await runMediaBranch({
      mediaBatchRows: rows, displayGoal, goal: 'x',
      mediaBatch: { ...batch, waitForMediaBatch: async () => ({ rows, total: 1, ready: 0, failed: 0, pending: 1, partial: 0,
        progress: { clase: { durationSeconds: 18000, completed: 1, total: 30 } }, stoppedEarly: true }) },
      prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [],
      backfillUserMessageFilesForTranscription: async () => {}, emit() {},
      controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
      saveArtifact: () => { throw new Error('no artifacts before the transcript exists'); },
      artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
      plainTranscriptionRequest: false, openai: {}, task: {}, documentPolicy: {},
      require: (name) => require(name === '../media-transcript-artifacts' ? '../src/services/media-transcript-artifacts' : name),
      ...mediaBranchHelpers({ loadMediaDeliveryService: () => delivery }),
      throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
    });
    assert.equal(result.stoppedReason, 'media_delivery_handoff', displayGoal);
    return JSON.parse(JSON.stringify(created[0]));
  };
  for (const [displayGoal, window] of [['traduce al inglés lo que dice en el minuto 30', { start: 1740, end: 2040 }],
    ['¿me traduces al inglés qué dice en el minuto 12?', { start: 660, end: 960 }],
    ['traduce lo que dijo en el minuto 30 al portugués', { start: 1740, end: 2040 }]]) {
    assert.equal(batch.translatesTheMoment(displayGoal), true, displayGoal);
    const { result, ranges, analysed } = await inline(displayGoal);
    // Only the moment is translated (never a whole 5-hour lecture), and the
    // chat shows the translated passage, not a Spanish analysis.
    assert.deepEqual(ranges, [window], displayGoal);
    assert.equal(analysed.length, 0, displayGoal);
    assert.match(result.finalMarkdown, /Good morning, class\./, displayGoal);
    assert.match(result.finalMarkdown, /Traducción al (?:inglés|portugués) del tramo que pediste \(sin resumir\)/, displayGoal);
    assert.doesNotMatch(result.finalMarkdown, /Traducción completa/, displayGoal);
  }
  // A long recording hands off the translation of that moment only: the
  // moment is the translation's window, never the transcript's range.
  const moment = await handOff('traduce al inglés lo que dice en el minuto 30');
  assert.equal(moment.mode, 'translation');
  assert.equal(moment.range, null);
  assert.deepEqual(moment.output.translationRange, { start: 1740, end: 2040 });
  assert.equal(moment.output.alsoAnalysis, false);
  // A comma before the moment alone keeps it the object.
  assert.equal(batch.translatesTheMoment('traduce al inglés lo que dice, en el minuto 30'), true);
  // «tradúcela y dime…» and «traduce la clase… y dime…» still translate the recording.
  for (const goal of ['tradúcela al inglés y dime qué dice en el minuto 30', 'traduce la clase al inglés y dime qué dice en el minuto 30',
    'transcribe y traduce al inglés, y dime qué explicó en el minuto 40', 'tradúcelo que lo necesito para mañana y dime qué dice en el minuto 30']) {
    assert.equal(batch.translatesTheMoment(goal), false, goal);
  }
  // A whole speech to translate, and a moment asked about in its own clause:
  // the translation covers the whole recording and the moment is answered
  // from its window — never only those 5 minutes translated, unanswered.
  for (const [displayGoal, window] of [['traduce al inglés todo lo que dicen en la clase y dime qué pasa en el minuto 30', { start: 1740, end: 2040 }],
    ['traduce al inglés lo que dice el profesor; también dime qué dijo en el minuto 30', { start: 1740, end: 2040 }],
    ['tradúceme al inglés lo que dicen y luego dime qué pasa en el minuto 12', { start: 660, end: 960 }],
    // a new request after a comma, or an opening «¿», is its own clause too
    ['traduce al inglés lo que dice el profesor, dime qué pasa en el minuto 30', { start: 1740, end: 2040 }],
    ['traduce al inglés lo que dice toda la clase, quiero saber qué pasó en el minuto 30', { start: 1740, end: 2040 }],
    ['traduce al inglés lo que dice el profesor, ¿qué pasa en el minuto 30?', { start: 1740, end: 2040 }],
    ['traduce al inglés lo que dicen, explícame el minuto 30', { start: 1740, end: 2040 }],
    ['traduce lo que dice todo el audio al inglés, dime qué dice en el minuto 30', { start: 1740, end: 2040 }]]) {
    assert.equal(batch.translatesTheMoment(displayGoal), false, displayGoal);
    const { result, ranges, analysed } = await inline(displayGoal);
    assert.deepEqual(ranges, [null, window], displayGoal);
    assert.equal(analysed.length, 1, displayGoal);
    assert.match(result.finalMarkdown, /Traducción completa al inglés \(sin resumir\)/, displayGoal);
    const record = await handOff(displayGoal);
    assert.equal(record.mode, 'translation', displayGoal);
    assert.equal(record.range, null, displayGoal);
    assert.equal(record.output.alsoAnalysis, true, displayGoal);
    assert.deepEqual(record.output.analysisRange, window, displayGoal);
  }
});

test('a refine\'s language stays with the refine: never the batch jobs, the delivery or a later «reintenta»', async () => {
  // «vuelve a transcribir del minuto 10 al 15, está en inglés, y resúmelo»
  // while another recording of the batch is still queued.
  const rows = [readyRow('clase', 'clase.mp4', { extractedText: 'x'.repeat(50) }),
    { id: 'otra', originalName: 'otra.mp4', processingStage: 'extracting', extractedText: null, size: 4e9 }];
  const refines = [];
  const waits = [];
  const created = [];
  const delivery = {
    isMediaDeliveryEnabled: () => true,
    estimateTranscriptionSeconds: ({ durationSec }) => Math.round(durationSec * 0.15),
    createDelivery: async (record) => { created.push(record); return { id: 'md_r', ...record }; },
    handOffMessage: () => 'Te aviso aquí.',
  };
  const context = (displayGoal, mediaBatch) => ({
    mediaBatchRows: rows, displayGoal, goal: 'x', mediaBatch,
    prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [],
    backfillUserMessageFilesForTranscription: async () => {}, emit() {},
    controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
    saveArtifact: (artifact) => ({ id: 'a', filename: artifact.filename }), artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
    plainTranscriptionRequest: false, openai: {}, task: {}, documentPolicy: {},
    require: (name) => require(name === '../media-transcript-artifacts' ? '../src/services/media-transcript-artifacts' : name),
    ...mediaBranchHelpers({ loadMediaDeliveryService: () => delivery }),
    throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
  });
  const refineGoal = 'vuelve a transcribir del minuto 10 al 15, está en inglés, y resúmelo';
  const result = await runMediaBranch(context(refineGoal, { ...batch,
    requestMediaRefine: async (args) => { refines.push(args); return { handled: true, ok: true, fileId: 'clase', range: args.intent.range, deliveryId: 'md_7', message: 'Voy a volver a transcribir el tramo 00:10:00–00:15:00.' }; },
    waitForMediaBatch: async (options) => { waits.push(options); return { rows, total: 2, ready: 1, failed: 0, pending: 1, partial: 0,
      progress: { otra: { durationSeconds: 18000, completed: 1, total: 30 } }, stoppedEarly: true }; } }));
  assert.equal(refines[0].language, 'en', 'the refine job carries the language of its window');
  assert.equal(waits[0].language, null, 'the other recordings\' jobs never get it');
  assert.equal(created[0].language, null, 'nor the delivery, which stores it for every file');
  assert.match(result.finalMarkdown, /^Voy a volver a transcribir/);
  // The next turn is a bare «reintenta»: the refine turn is among the turns
  // sent since the recordings arrived, and its language stays out.
  const since = new Date(Date.now() - 60_000);
  const retryRows = rows.map(row => ({ ...row, createdAt: since }));
  const retryWaits = [];
  await runMediaBranch({ ...context('reintenta', { ...batch,
    loadRecentUserTurns: async () => ['reintenta', refineGoal],
    waitForMediaBatch: async (options) => { retryWaits.push(options); return { rows: retryRows, total: 2, ready: 2, failed: 0, pending: 0, partial: 0, progress: {} }; } }),
  mediaBatchRows: retryRows });
  assert.equal(retryWaits[0].retryFailed, true);
  assert.equal(retryWaits[0].language, null, 'a bare «reintenta» never forces the refine\'s language on the whole recording');
});

test('loadMixedAttachmentBatch partitions mixed audio/video + image/document turns while keeping pure batches separate', async () => {
  const mixedRows = [
    { id: 'vid1', userId: 'u', originalName: 'WhatsApp Video.mp4', mimeType: 'video/mp4', deletedAt: null, processingStage: 'uploaded', extractedText: null },
    { id: 'img1', userId: 'u', originalName: 'pizarra.png', mimeType: 'image/png', deletedAt: null, processingStage: 'ready', extractedText: 'Fórmula de costos' },
    { id: 'doc1', userId: 'u', originalName: 'acta.pdf', mimeType: 'application/pdf', deletedAt: null, processingStage: 'ready', extractedText: 'Acuerdo 1: presupuesto aprobado.' },
  ];
  const prisma = {
    file: {
      findMany: async ({ where }) => mixedRows.filter(
        row => row.userId === where.userId && row.deletedAt === null && where.id.in.includes(row.id)
      ),
    },
  };
  assert.equal(await batch.loadMediaBatch(prisma, { userId: 'u', fileIds: ['vid1', 'img1'] }), null, 'loadMediaBatch still returns null on mixed files');
  const partitioned = await batch.loadMixedAttachmentBatch(prisma, { userId: 'u', fileIds: ['vid1', 'img1', 'doc1'] });
  assert.ok(partitioned);
  assert.deepEqual(partitioned.mediaRows.map(r => r.id), ['vid1']);
  assert.deepEqual(partitioned.companionRows.map(r => r.id), ['img1', 'doc1']);
  assert.equal(await batch.loadMixedAttachmentBatch(prisma, { userId: 'u', fileIds: ['vid1'] }), null, 'pure media is not a mixed batch');
  assert.equal(await batch.loadMixedAttachmentBatch(prisma, { userId: 'u', fileIds: ['img1', 'doc1'] }), null, 'pure non-media is not a mixed batch');
});

test('mixed audio + image and audio + document with «trnadscririrbi» transcribes the audio, includes the companion attachment and analyzes the user request across all files', async () => {
  const { isPlainTranscriptionRequest } = require('../src/services/message-attachments');
  const realArtifacts = require('../src/services/media-transcript-artifacts');
  for (const [displayGoal, companion] of [
    ['trnadscririrbi', { id: 'img1', name: 'captura.png', kind: 'image', mimeType: 'image/png', text: 'Tabla en pizarra: Meta Q4 = 120 unidades.' }],
    ['transcribir porfavor', { id: 'doc1', name: 'informe.pdf', kind: 'document', mimeType: 'application/pdf', text: 'Informe técnico: el lote inicial consta de 120 unidades.' }],
  ]) {
    assert.equal(isPlainTranscriptionRequest(displayGoal), true, `recognizes transcription intent for: ${displayGoal}`);
    const rows = [readyRow('aud1', 'nota-voz.mp4', { extractedText: '[00:00:05] Confirmamos que la meta del cuarto trimestre es de 120 unidades.' })];
    const backfilled = [];
    const synthesisInputs = [];
    const result = await runMediaBranch({
      mediaBatchRows: rows,
      displayGoal,
      goal: displayGoal,
      mediaBatch: {
        ...batch,
        waitForMediaBatch: async () => ({ rows, total: 1, ready: 1, failed: 0, pending: 0, partial: 0, progress: {} }),
      },
      prisma: {},
      user: { id: 'owner' },
      taskId: 'task-mixed',
      chatId: 'chat-mixed',
      fileMetadata: [],
      backfillUserMessageFilesForTranscription: async (_prisma, args) => { backfilled.push(args.fileIds); },
      emit() {},
      controller: new AbortController(),
      runtimeBudgetMs: 60 * 60_000,
      startedAt: Date.now(),
      Buffer,
      saveArtifact: (artifact) => ({ id: 'txt1', filename: artifact.filename }),
      artifacts: [],
      persistence: { persistGeneratedArtifact: async () => {} },
      plainTranscriptionRequest: isPlainTranscriptionRequest(displayGoal),
      openai: { chat: { completions: { create: async () => ({}) } } },
      task: { companionAttachments: [companion] },
      documentPolicy: {},
      require: (name) => {
        if (name === '../media-transcript-artifacts') return realArtifacts;
        if (name === '../media-analysis-runtime') {
          return {
            createMediaAnalysisCompletion: () => ({
              usage: null,
              complete: async (messages, _signal, isFinal) => {
                const payload = JSON.parse(messages[1].content);
                if (isFinal) {
                  synthesisInputs.push(payload);
                  return `Tanto el audio («nota-voz.mp4») como el adjunto («${companion.name}») coinciden en la meta de 120 unidades.`;
                }
                return `Meta mencionada en audio: 120 unidades [00:00:05].`;
              },
            }),
          };
        }
        return require(name);
      },
      ...mediaBranchHelpers(),
      throwIfAborted: (signal) => signal.throwIfAborted(),
      finishDeterministicTask: async (value) => value,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(backfilled[0])), ['aud1', companion.id], 'both audio and companion attachment stay on the user turn');
    assert.equal(synthesisInputs.length, 1, 'runs combined analysis across audio and companion attachment');
    assert.equal(synthesisInputs[0].companionAttachments.length, 1);
    assert.equal(synthesisInputs[0].companionAttachments[0].name, companion.name);
    assert.match(result.finalMarkdown, /Confirmamos que la meta del cuarto trimestre es de 120 unidades/, 'includes audio transcript');
    assert.match(result.finalMarkdown, /120 unidades/, 'includes companion content and combined analysis');
    assert.match(result.finalMarkdown, /Análisis de la solicitud/, 'includes request analysis section');
    assert.deepEqual(JSON.parse(JSON.stringify(result.metadata.companionFileIds)), [companion.id]);
    assert.equal(result.stoppedReason, 'transcription_finalize');
  }
});

// ── a follow-up while the transcription runs in the background ─────────────

function pendingDeliveryFake({ outcome = 'amended', changes = ['translation'], onAmend = () => {}, onCancelJobs = () => {} } = {}) {
  const real = require('../src/services/media-delivery');
  const calls = { amends: [], created: 0, cancelJobs: [] };
  return {
    calls,
    delivery: {
      isMediaDeliveryEnabled: () => true,
      estimateTranscriptionSeconds: () => 60,
      findOpenDelivery: async ({ fileIds }) => ({ id: 'md_open', fileIds, status: 'pending', kind: 'transcript' }),
      amendDelivery: async (id, { amendment }) => {
        calls.amends.push({ id, amendment });
        onAmend(amendment);
        return { outcome, changes, record: { fileIds: ['clase'], output: { translationTarget: amendment.translationTarget, documentFormat: amendment.documentFormat } } };
      },
      amendedMessage: (args) => real.amendedMessage(args),
      stillRunningMessage: (args) => real.stillRunningMessage(args),
      createDelivery: async () => { calls.created += 1; return { id: 'md_second' }; },
      handOffMessage: () => 'Te aviso aquí.',
      cancelUnneededMediaJobs: async (args) => { calls.cancelJobs.push(args); onCancelJobs(args); return { stopped: 1 }; },
    },
  };
}

function followupContext({ goal, delivery, waitForMediaBatch, task = {}, plain = false }) {
  const rows = [{ id: 'clase', originalName: 'clase.mp4', processingStage: 'extracting', extractedText: null, size: 4e9 }];
  return {
    mediaBatchRows: rows,
    mediaBatch: { ...batch, waitForMediaBatch },
    prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [], displayGoal: goal, goal,
    backfillUserMessageFilesForTranscription: async () => {}, emit() {},
    controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
    saveArtifact: () => { throw new Error('no artifacts'); },
    artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
    plainTranscriptionRequest: plain, openai: {}, task, documentPolicy: {},
    require: (name) => require(name === '../media-transcript-artifacts' ? '../src/services/media-transcript-artifacts' : name),
    ...mediaBranchHelpers({ loadMediaDeliveryService: () => delivery }),
    throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
  };
}

test('«y tradúcelo al inglés» while it still transcribes joins the pending delivery at once (no wait, no second delivery)', async () => {
  const { delivery, calls } = pendingDeliveryFake();
  const result = await runMediaBranch(followupContext({ goal: 'y tradúcelo al inglés', delivery,
    waitForMediaBatch: async () => { throw new Error('no inline wait for a follow-up'); } }));
  assert.equal(result.stoppedReason, 'media_delivery_amended');
  assert.equal(result.metadata.mediaDeliveryAmended, 'md_open');
  assert.equal(result.metadata.mediaDeliveryHandoff, undefined, 'the first turn keeps the only live status');
  assert.equal(calls.created, 0);
  assert.equal(calls.amends.length, 1);
  assert.equal(calls.amends[0].amendment.translationTarget, 'en');
  assert.equal(calls.amends[0].amendment.wantsAnalysis, false, 'a translation alone is not a summary');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.amends[0].amendment.model)), { id: 'deepseek-v4-flash', provider: 'DeepSeek' });
  assert.match(result.finalMarkdown, /^Anotado: cuando termine la transcripción te la entrego traducida al inglés\./);
});

test('«en Word» adds the document without an analysis; an instruction the rules do not name becomes the analysis', async () => {
  const word = pendingDeliveryFake({ changes: ['document'] });
  await runMediaBranch(followupContext({ goal: 'ponlo en word', delivery: word.delivery, waitForMediaBatch: async () => { throw new Error('no wait'); } }));
  assert.equal(word.calls.amends[0].amendment.documentFormat, 'docx');
  assert.equal(word.calls.amends[0].amendment.wantsAnalysis, false);

  const vague = pendingDeliveryFake({ outcome: 'unchanged', changes: [] });
  await runMediaBranch(followupContext({ goal: 'enfócate solo en lo que dice el profesor', delivery: vague.delivery,
    waitForMediaBatch: async () => { throw new Error('no wait'); } }));
  assert.equal(vague.calls.amends.length, 2, 'retried as an analysis instruction');
  assert.equal(vague.calls.amends[1].amendment.wantsAnalysis, true);
  assert.equal(vague.calls.amends[1].amendment.goal, '', 'the goal is appended once');

  const thanks = pendingDeliveryFake({ outcome: 'unchanged', changes: [] });
  const result = await runMediaBranch(followupContext({ goal: 'gracias', delivery: thanks.delivery, waitForMediaBatch: async () => { throw new Error('no wait'); } }));
  assert.equal(thanks.calls.amends.length, 1, 'a courtesy is no instruction');
  assert.match(result.finalMarkdown, /^Ya estoy transcribiendo «clase\.mp4»/);
});

test('«Detener» during the inline wait stops the recordings\' jobs too', async () => {
  const { delivery, calls } = pendingDeliveryFake();
  delivery.findOpenDelivery = async () => null;
  const task = { cancelClaimed: true };
  await assert.rejects(runMediaBranch(followupContext({ goal: 'transcribe este video', delivery, task, plain: true,
    waitForMediaBatch: async () => { const err = new Error('aborted'); err.name = 'AbortError'; throw err; } })), /aborted/);
  assert.equal(calls.cancelJobs.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.cancelJobs[0].fileIds)), ['clase']);
  // A deploy or the runtime cap (no user cancel) never stops them.
  const other = pendingDeliveryFake();
  other.delivery.findOpenDelivery = async () => null;
  await assert.rejects(runMediaBranch(followupContext({ goal: 'transcribe este video', delivery: other.delivery, task: {}, plain: true,
    waitForMediaBatch: async () => { throw new Error('shutdown'); } })), /shutdown/);
  assert.equal(other.calls.cancelJobs.length, 0);
});

test('a follow-up with a window reads it alone; the transcript files stay whole unless that part of the transcript is asked for', async () => {
  const sent = async (goal) => {
    const fake = pendingDeliveryFake({ outcome: 'unchanged', changes: [] });
    await runMediaBranch(followupContext({ goal, delivery: fake.delivery, waitForMediaBatch: async () => { throw new Error('no wait'); } }));
    assert.equal(fake.calls.amends.length, 1, `${goal}: a recognised follow-up is never retried as a catch-all analysis`);
    return JSON.parse(JSON.stringify(fake.calls.amends[0].amendment));
  };
  const question = await sent('¿qué dice del minuto 10 al 20?');
  assert.equal(question.range, null, 'a question never cuts the transcript files');
  assert.deepEqual(question.analysisRange, { start: 600, end: 1200 });
  assert.equal(question.wantsAnalysis, true);
  const summary = await sent('y resume del minuto 10 al 20');
  assert.equal(summary.range, null);
  assert.deepEqual(summary.analysisRange, { start: 600, end: 1200 });
  for (const goal of ['solo del minuto 10 al 20', 'del minuto 10 al 20']) {
    const cut = await sent(goal);
    assert.deepEqual(cut.range, { start: 600, end: 1200 }, `${goal}: that part of the transcript`);
    assert.equal(cut.analysisRange, null);
  }
  const moment = await sent('traduce al inglés lo que dice en el minuto 30');
  assert.equal(moment.range, null);
  assert.deepEqual(moment.translationRange, { start: 1740, end: 2040 });
  assert.equal(moment.wantsAnalysis, false, 'a translation of the moment adds no summary');
  const window = await sent('traduce al inglés del minuto 10 al 20');
  assert.equal(window.range, null);
  assert.deepEqual(window.translationRange, { start: 600, end: 1200 });
});

test('«no lo analices», «no lo quiero en Word» and «sin subtítulos» take things back, never add them', async () => {
  const sent = async (goal) => {
    const fake = pendingDeliveryFake({ outcome: 'unchanged', changes: [] });
    await runMediaBranch(followupContext({ goal, delivery: fake.delivery, waitForMediaBatch: async () => { throw new Error('no wait'); } }));
    assert.equal(fake.calls.amends.length, 1, goal);
    return JSON.parse(JSON.stringify(fake.calls.amends[0].amendment));
  };
  for (const goal of ['no lo analices', 'no la analices', 'no analices nada']) {
    const out = await sent(goal);
    assert.equal(out.removeAnalysis, true, goal);
    assert.equal(out.wantsAnalysis, false, goal);
  }
  const word = await sent('no lo quiero en Word');
  assert.equal(word.documentFormat, null);
  assert.deepEqual(word.removeDocument, ['docx']);
  const subs = await sent('sin subtítulos');
  assert.equal(subs.wantsSubtitles, false);
  assert.equal(subs.removeSubtitles, true);
  assert.equal(batch.wantsMediaAnalysis('transcribe la clase y no la analices'), false);
});

// ── fourth round: refusals, windows and the analysis default ─────────────

const { isPlainTranscriptionRequest: plainRequest } = require('../src/services/message-attachments');
const artifacts = require('../src/services/media-transcript-artifacts');

function capturingDelivery() {
  const created = [];
  return { created, adapter: { isMediaDeliveryEnabled: () => true, estimateTranscriptionSeconds: () => 600,
    createDelivery: async (record) => { created.push(record); return { id: `md_${created.length}`, ...record }; },
    handOffMessage: () => 'Te aviso aquí.' } };
}

async function firstRequest(goal) {
  const { created, adapter } = capturingDelivery();
  await handOffTurn({ goal, plainTranscriptionRequest: plainRequest(goal), delivery: adapter });
  assert.equal(created.length, 1, goal);
  return JSON.parse(JSON.stringify(created[0]));
}

async function followUp(goal, fake = pendingDeliveryFake({ outcome: 'unchanged', changes: [] })) {
  await runMediaBranch(followupContext({ goal, delivery: fake.delivery, waitForMediaBatch: async () => { throw new Error('no wait'); } }));
  return { amends: fake.calls.amends.map(call => JSON.parse(JSON.stringify(call.amendment))) };
}

test('the usual refusals of a format turn it down, never ask for it; the same format asked elsewhere wins', () => {
  const out = goal => {
    const value = artifacts.resolveTranscriptOutput(goal);
    return { doc: value.documentFormat, subs: value.wantsSubtitles, declinedDocuments: value.declinedDocuments || [], declinedSubtitles: value.declinedSubtitles === true };
  };
  assert.deepEqual(out('transcribe esto, no quiero subtítulos'), { doc: null, subs: false, declinedDocuments: [], declinedSubtitles: true });
  assert.deepEqual(out('dame la transcripción, no quiero el Word'), { doc: null, subs: false, declinedDocuments: ['docx'], declinedSubtitles: false });
  assert.deepEqual(out('dame la transcripción sin Word ni PDF'), { doc: null, subs: false, declinedDocuments: ['docx', 'pdf'], declinedSubtitles: false });
  assert.deepEqual(out('transcribe y quita los subtítulos').subs, false);
  assert.deepEqual(out('transcribe, nada de PDF').doc, null);
  assert.deepEqual(out('transcribir sin pasarlo a word').declinedDocuments, ['docx']);
  assert.equal(out('no Word please').doc, null);
  // Asked for after all, or elsewhere in the message.
  assert.equal(out('tengo estos 30 videos sin subtítulos, transcríbelos y dame el SRT de cada uno').subs, true);
  assert.equal(out('quiero el Word, sin Word no puedo editarlo').doc, 'docx');
  assert.equal(out('no lo quiero en Word sino en PDF').doc, 'pdf');
  assert.equal(out('Word no, PDF sí').doc, 'pdf');
  assert.equal(out('no, mejor en Word').doc, 'docx');
  assert.equal(out('¿por qué no lo pones en Word?').doc, 'docx');
  assert.equal(out('porque no lo quiero en Word').doc, null);
  assert.equal(out('en Word, sin subtítulos').doc, 'docx');
});

test('a format turned down stops the automatic Word and subtitles of a long recording or a video', async () => {
  const row = { id: 'clase', originalName: 'clase.mp4', mimeType: 'video/mp4', extractedText: '[00:00] Hola.' };
  const transcripts = new Map([['clase', { segments: [{ start: 0, end: 4, text: 'Hola.' }], durationSec: 3600, language: 'es' }]]);
  const build = output => artifacts.buildMediaTranscriptArtifacts({ rows: [row], transcripts, output, userId: 'u1',
    createDocument: async (_u, name) => { const file = require('node:path').join(require('node:os').tmpdir(), name); require('node:fs').writeFileSync(file, 'docx'); return { filePath: file }; } })
    .then(built => built.artifacts.map(item => item.format).sort());
  assert.deepEqual(await build({}), ['docx', 'srt', 'txt', 'vtt'], 'a 1-hour video gets Word and subtitles automatically');
  assert.deepEqual(await build(artifacts.resolveTranscriptOutput('transcribe este video sin subtítulos, solo el texto')), ['docx', 'txt']);
  assert.deepEqual(await build(artifacts.resolveTranscriptOutput('transcribe esta clase sin Word, solo el TXT')), ['srt', 'txt', 'vtt']);
  // A follow-up stored on the delivery does the same.
  const { mergeDeliveryAmendment, normalizeNewRecord } = require('../src/services/media-delivery-store');
  const record = normalizeNewRecord({ userId: 'u1', chatId: 'c', fileIds: ['clase'], fileNames: ['clase.mp4'], goal: 'transcribe', mode: 'transcript', formats: ['txt'] }, Date.now());
  const word = mergeDeliveryAmendment(record, { goal: 'no lo quiero en Word', removeDocument: ['docx'] });
  assert.deepEqual(word.changes, ['no_auto_document']);
  assert.deepEqual(word.record.output.declinedDocuments, ['docx']);
  assert.match(require('../src/services/media-delivery').amendedMessage(word), /sin Word/);
  const subs = mergeDeliveryAmendment(word.record, { goal: 'sin subtítulos', removeSubtitles: true });
  assert.deepEqual(subs.changes, ['no_subtitles']);
  assert.equal(subs.record.output.declinedSubtitles, true);
  assert.deepEqual(await build(subs.record.output), ['txt']);
  // Asked for again, it comes back.
  const back = mergeDeliveryAmendment(subs.record, { goal: 'en Word y con subtítulos', documentFormat: 'docx', wantsSubtitles: true });
  assert.equal(back.record.output.declinedDocuments, undefined);
  assert.equal(back.record.output.declinedSubtitles, undefined);
});

test('a first request that only names or turns down a format runs no paid analysis', async () => {
  for (const goal of ['transcribe estos 100 audios, no los quiero en PDF', 'transcribe todo pero no en Word', 'transcribe la clase, no necesito PDF',
    'transcribe estos audios en Word', 'pasa estos audios a texto', 'pásalos a Word']) {
    const record = await firstRequest(goal);
    assert.notEqual(record.mode, 'analysis', goal);
  }
  const subs = await firstRequest('transcribe este video, no quiero subtítulos');
  assert.deepEqual(subs.formats, ['txt']);
  assert.equal(subs.output.declinedSubtitles, true);
  assert.equal((await firstRequest('transcribe este audio y resúmelo')).mode, 'analysis', 'an explicit summary still runs');
});

test('a refusal of the summary never starts one, and a description of the class is no request', async () => {
  for (const goal of ['transcríbelos, no quiero que los resumas', 'transcribe, no hace falta resumir', 'transcribe, nada de resúmenes',
    'transcribe la clase, no es necesario un resumen', 'transcribe sin necesidad de resumen', 'transcribe, no hace falta analizar nada',
    'transcribe estas 20 clases, son temas clave para el examen final', 'transcribe la entrevista donde el ministro responde las preguntas de los periodistas',
    'transcribe la clase donde el profesor menciona los temas del examen', 'transcribe los audios son mis notas de clase de anatomia',
    'transcribe la reunión del equipo de Consumer Insights', 'transcribe el video, el profe genera preguntas al final para repasar',
    'transcribe la clase, el profesor resume los temas al final', 'transcribe la clase donde el profesor explica la fotosíntesis']) {
    assert.equal(batch.wantsMediaAnalysis(goal), false, goal);
  }
  for (const goal of ['transcribe y resúmelo', 'transcribe y no olvides resumirlo', 'transcribe sin resumen, pero analiza las decisiones',
    'transcribe la reunión con los acuerdos', 'transcribe y hazme 5 preguntas', 'transcribe y quiero que lo resumas', 'transcribe y dime de qué trata']) {
    assert.equal(batch.wantsMediaAnalysis(goal), true, goal);
  }
  const { amends } = await followUp('transcríbelo, no quiero que lo resumas');
  assert.equal(amends[0].removeAnalysis, true);
  assert.equal(amends[0].wantsAnalysis, false);
});

test('a condition on the translation keeps it; only a take-back removes it', async () => {
  for (const goal of ['no traduzcas los nombres propios', 'no lo traduzcas literal, que suene natural', 'no traduzcas las siglas', 'sin traducir las citas en latín']) {
    assert.equal(batch.negatesTranslation(goal), false, goal);
    const { amends } = await followUp(goal);
    assert.equal(amends[0].removeTranslation, false, goal);
  }
  for (const goal of ['ya no la traduzcas', 'no hace falta traducirlo', 'no quiero que lo traduzcas al inglés', 'sin traducción']) {
    assert.equal(batch.negatesTranslation(goal), true, goal);
  }
});

test('follow-up windows: open ones run to the end, a summary with a moment reads it, questions read without cutting the files', async () => {
  const one = async goal => (await followUp(goal)).amends[0];
  const fromNinety = await one('resume desde el minuto 90');
  assert.deepEqual(fromNinety.analysisRange, { start: 5400, end: 7 * 24 * 3600 });
  assert.equal(fromNinety.range, null);
  const translated = await one('traduce al inglés a partir del minuto 100');
  assert.deepEqual(translated.translationRange, { start: 6000, end: 7 * 24 * 3600 });
  const momentAndSummary = await one('traduce al inglés lo que dice en el minuto 30 y resúmelo');
  assert.ok(momentAndSummary.translationRange && momentAndSummary.analysisRange, 'both read the moment');
  assert.deepEqual(momentAndSummary.analysisRange, momentAndSummary.translationRange);
  for (const goal of ['resume la transcripción del minuto 10 al 20', '¿qué dice la transcripción del minuto 10 al 20?', 'qué dice del minuto 10 al 20', 'dime qué dice del minuto 10 al 20']) {
    const amendment = await one(goal);
    assert.equal(amendment.range, null, `${goal}: the transcript files stay whole`);
    assert.deepEqual(amendment.analysisRange, { start: 600, end: 1200 }, goal);
    assert.equal(amendment.wantsAnalysis, true, goal);
  }
  for (const goal of ['solo del minuto 10 al 20', 'transcribe del minuto 10 al 20']) {
    assert.deepEqual((await one(goal)).range, { start: 600, end: 1200 }, goal);
  }
  // The catch-all for words no rule reads keeps an earlier question's window.
  const fake = pendingDeliveryFake({ outcome: 'unchanged', changes: [] });
  await followUp('explícamelo mejor', fake);
  const catchAll = fake.calls.amends.map(call => call.amendment).find(amendment => amendment.wantsAnalysis === true);
  assert.equal(catchAll.keepWindow, true);
  const { mergeDeliveryAmendment, normalizeNewRecord } = require('../src/services/media-delivery-store');
  const record = normalizeNewRecord({ userId: 'u1', chatId: 'c', fileIds: ['clase'], fileNames: ['clase.mp4'], goal: 'transcribe', mode: 'analysis',
    formats: ['txt'], output: { analysisRange: { start: 1740, end: 2040 } } }, Date.now());
  assert.deepEqual(mergeDeliveryAmendment(record, { goal: '', wantsAnalysis: true, keepWindow: true }).record.output.analysisRange, { start: 1740, end: 2040 });
  assert.equal(mergeDeliveryAmendment(record, { goal: '¿y quién es el profesor?', wantsAnalysis: true }).record.output.analysisRange, undefined);
});

test('a whole translation after a moment translates it all, and says so', () => {
  const { mergeDeliveryAmendment, normalizeNewRecord } = require('../src/services/media-delivery-store');
  const record = normalizeNewRecord({ userId: 'u1', chatId: 'c', fileIds: ['clase'], fileNames: ['clase.mp4'], goal: 'transcribe', mode: 'translation',
    formats: ['txt'], output: { translationTarget: 'en', translationRange: { start: 1740, end: 2040 } } }, Date.now());
  const whole = mergeDeliveryAmendment(record, { goal: 'tradúcela completa al inglés', translationTarget: 'en', translationWhole: true });
  assert.ok(whole.changes.includes('translation_whole'));
  assert.equal(whole.record.output.translationRange, undefined);
  assert.match(require('../src/services/media-delivery').amendedMessage(whole), /la traducción, completa/);
});

test('translation windows add up and never shrink: a moment inside is already there, one outside joins it', () => {
  const { mergeDeliveryAmendment, normalizeNewRecord } = require('../src/services/media-delivery-store');
  const { amendedMessage } = require('../src/services/media-delivery');
  const base = extra => normalizeNewRecord({ userId: 'u1', chatId: 'c', fileIds: ['clase'], fileNames: ['clase.mp4'], goal: 'transcribe',
    mode: 'translation', formats: ['txt'], ...extra }, Date.now());
  const moment = (start, end) => ({ goal: 'traduce al inglés lo que dice en ese minuto', translationTarget: 'en', translationRange: { start, end } });
  // The first hour translated (the transcript's range): minute 90 is added
  // as a window of its own, never the span of both.
  const hour = base({ range: { start: 0, end: 3600 }, output: { translationTarget: 'en' } });
  const late = mergeDeliveryAmendment(hour, moment(5340, 5640));
  assert.deepEqual(late.record.output.translationRanges, [{ start: 0, end: 3600 }, { start: 5340, end: 5640 }]);
  assert.equal(late.record.output.translationRange, undefined);
  assert.deepEqual(late.changes, ['translation_range_added']);
  assert.match(amendedMessage(late), /traducida al inglés \(la traducción incluye también ese momento\)/);
  // Minute 30 is inside that hour: nothing changes, and it never says «completa».
  const inside = mergeDeliveryAmendment(hour, moment(1740, 2040));
  assert.equal(inside.record.output.translationRange, undefined);
  assert.deepEqual(inside.changes, ['translation_moment_included']);
  assert.match(amendedMessage(inside), /ya incluye ese momento/);
  assert.doesNotMatch(amendedMessage(inside), /completa/);
  // Two moments: both windows, never only the latest (and never what lies between).
  const first = base({ output: { translationTarget: 'en', translationRange: { start: 1740, end: 2040 } } });
  assert.deepEqual(mergeDeliveryAmendment(first, moment(2940, 3240)).record.output.translationRanges,
    [{ start: 1740, end: 2040 }, { start: 2940, end: 3240 }]);
  // Moments that touch are one window.
  assert.deepEqual(mergeDeliveryAmendment(first, moment(2040, 2340)).record.output.translationRange, { start: 1740, end: 2340 });
  // A moment inside a translated hour keeps the hour.
  const hourWindow = base({ output: { translationTarget: 'en', translationRange: { start: 0, end: 3600 } } });
  assert.deepEqual(mergeDeliveryAmendment(hourWindow, moment(1740, 2040)).record.output.translationRange, { start: 0, end: 3600 });
  // «desde el minuto 30»: an earlier moment joins the open range, which stays open.
  const open = base({ range: { start: 1800, end: null }, output: { translationTarget: 'en' } });
  assert.deepEqual(mergeDeliveryAmendment(open, moment(540, 840)).record.output.translationRanges,
    [{ start: 540, end: 840 }, { start: 1800, end: null }]);
  // Naming the language again keeps the moment, and says how to get it all.
  const kept = mergeDeliveryAmendment(first, { goal: 'tradúcelo al inglés en Word', translationTarget: 'en', documentFormat: 'docx' });
  assert.deepEqual(kept.record.output.translationRange, { start: 1740, end: 2040 });
  assert.ok(kept.changes.includes('translation_range_kept'));
  assert.match(amendedMessage(kept), /tradúcela completa/);
});

test('a translation follow-up reads its moment; only an explicit «completa» translates it all', async () => {
  const amendmentFor = async (goal) => {
    const { delivery, calls } = pendingDeliveryFake({ outcome: 'unchanged', changes: [] });
    await runMediaBranch(followupContext({ goal, delivery, waitForMediaBatch: async () => { throw new Error('no wait'); } }));
    assert.equal(calls.amends.length, 1, goal);
    return JSON.parse(JSON.stringify(calls.amends[0].amendment));
  };
  for (const goal of ['traduce también al inglés lo que dice en el minuto 50', 'traduce al inglés también lo que dice en el minuto 50',
    'y traduce al inglés lo del minuto 50', 'traduce además al inglés lo que dice en el minuto 50']) {
    const amendment = await amendmentFor(goal);
    assert.deepEqual(amendment.translationRange, { start: 2940, end: 3240 }, goal);
    assert.equal(amendment.translationWhole, false, goal);
    assert.equal(amendment.wantsAnalysis, false, `${goal}: no summary nobody asked for`);
  }
  for (const goal of ['tradúcelo al inglés en Word', 'tradúcelo al inglés, todo bien', 'tradúcelo al inglés pero no traduzcas los nombres propios',
    'y tradúcelo al inglés']) {
    assert.equal((await amendmentFor(goal)).translationWhole, false, goal);
  }
  for (const goal of ['tradúcela completa al inglés', 'tradúcelo todo al inglés', 'traduce toda la clase al inglés',
    'quiero la traducción completa al inglés', 'translate the whole recording into English']) {
    assert.equal((await amendmentFor(goal)).translationWhole, true, goal);
  }
});

test('a statement of two languages joins a pending delivery as a fact, never the catch-all analysis', async () => {
  for (const goal of ['el audio está en inglés y español', 'habla en español y quechua', 'los audios están en español y en inglés',
    'está en inglés e italiano']) {
    const { delivery, calls } = pendingDeliveryFake({ outcome: 'unchanged', changes: [] });
    await runMediaBranch(followupContext({ goal, delivery, waitForMediaBatch: async () => { throw new Error('no wait'); } }));
    assert.ok(calls.amends.length > 0, goal);
    assert.ok(calls.amends.every(call => call.amendment.wantsAnalysis !== true), `${goal}: no summary nobody asked for`);
  }
  const mb = require('../src/services/media-batch');
  assert.equal(mb.statesRecordingLanguages('el profesor habla de Alemania y Francia'), false);
  assert.equal(mb.statesRecordingLanguages('está en inglés'), false, 'one language is a hint, read elsewhere');
});

test('a take-back of a pending translation removes it; a condition keeps it, for the translator, never an analysis', async () => {
  const amendOf = async (goal) => {
    const { delivery, calls } = pendingDeliveryFake({ outcome: 'unchanged', changes: [] });
    await runMediaBranch(followupContext({ goal, delivery, waitForMediaBatch: async () => { throw new Error('no wait'); } }));
    return calls.amends.map(call => JSON.parse(JSON.stringify(call.amendment)));
  };
  for (const goal of ['no traduzcas los audios', 'mejor no traduzcas las grabaciones', 'no la traduzcas por ahora', 'no lo traduzcas porfa',
    'no lo traduzcas de momento', 'sin traducción por ahora', 'no traduzcas las clases', 'no traduzcas los videos todavía']) {
    const amends = await amendOf(goal);
    assert.equal(amends[0].removeTranslation, true, goal);
    assert.ok(amends.every(amendment => amendment.wantsAnalysis !== true), `${goal}: no paid analysis`);
  }
  for (const goal of ['no traduzcas los nombres propios', 'no traduzcas las siglas', 'sin traducir las citas en latín',
    'deja las siglas sin traducir', 'no traduzcas lo que ya está en inglés']) {
    const amends = await amendOf(goal);
    assert.ok(amends.every(amendment => amendment.removeTranslation === false), `${goal}: the translation stays`);
    assert.ok(amends.every(amendment => amendment.wantsAnalysis !== true), `${goal}: no paid analysis`);
  }
  const mb = require('../src/services/media-batch');
  assert.deepEqual(mb.translationConditions('transcribe y tradúcelo al inglés, pero no traduzcas los nombres propios\n\ndeja las siglas sin traducir'),
    ['pero no traduzcas los nombres propios', 'deja las siglas sin traducir']);
  assert.deepEqual(mb.translationConditions('tradúcelo al inglés'), []);
  assert.deepEqual(mb.translationConditions('no la traduzcas'), [], 'a take-back is no condition');
  // The translator gets them as the user's instructions.
  const prompts = [];
  await mb.translateMediaBatch({ rows: [{ id: 'a', originalName: 'a.mp4', processingStage: 'ready', extractedText: '[00:00:00] Hola, soy Juan Pérez de la ONU.' }],
    target: { code: 'en', name: 'inglés' }, conditions: ['no traduzcas los nombres propios'],
    complete: async (messages) => { prompts.push(messages[0].content); return '[00:00:00] Hi, I am Juan Pérez from the ONU.'; } });
  assert.match(prompts[0], /Indicaciones del usuario sobre la traducción, respétalas: «no traduzcas los nombres propios»/);
});

test('after a Stop with nothing else transcribed, a summary or a question resumes the recording; the report calls it stopped', async () => {
  const { CANCELLED_NOTE } = require('../src/services/media-transcription-queue');
  const stopped = (id, name) => ({ ...readyRow(id, name), processingStage: 'failed', extractedText: null, processingError: CANCELLED_NOTE });
  const run = async (rows, displayGoal) => {
    const waits = [];
    const result = await runMediaBranch({
      mediaBatchRows: rows, displayGoal, goal: 'x',
      mediaBatch: { ...batch, waitForMediaBatch: async (args) => { waits.push(args); return { rows, total: rows.length, ready: rows.filter(row => row.processingStage === 'ready').length,
        failed: rows.filter(row => row.processingStage === 'failed').length, pending: 0, partial: 0 }; } },
      prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [],
      backfillUserMessageFilesForTranscription: async () => {}, emit() {},
      controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
      saveArtifact: (artifact) => ({ ...artifact, id: 'art' }), artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
      plainTranscriptionRequest: false, openai: {}, task: {}, documentPolicy: {},
      require: (name) => require(name === '../media-transcript-artifacts' ? '../src/services/media-transcript-artifacts' : name),
      ...mediaBranchHelpers({ loadMediaDeliveryService: () => null }),
      throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
    }).catch(error => ({ error }));
    return { resume: JSON.parse(JSON.stringify(waits[0]?.resumeStopped ?? null)), result };
  };
  const one = [stopped('v1', 'clase.mp4')];
  for (const goal of ['resúmela', 'hazme un resumen de la clase', 'tradúcela al inglés', '¿de qué trata la clase?']) {
    assert.equal((await run(one, goal)).resume, true, goal);
  }
  assert.equal((await run(one, 'no la retomes, solo dime qué alcanzaste')).resume, false);
  // With another one ready, only a stopped one it names resumes.
  const mixed = [readyRow('v0', 'Clase 1.mp4'), stopped('v2', 'Clase 2.mp4')];
  assert.equal((await run(mixed, '¿de qué trata?')).resume, false);
  assert.deepEqual((await run(mixed, 'resume la clase 2')).resume, ['v2']);
  // A recording still stopped is reported as stopped, never as a failure.
  const { result } = await run(mixed, '¿de qué trata?');
  const text = String(result?.finalMarkdown || '');
  assert.match(text, /Una grabación sigue detenida: escribe «retómala» para seguir donde quedó\./);
  assert.doesNotMatch(text, /no se pudo transcribir/);
});

test('a document switched to another format replaces it; turned down later, neither comes back', async () => {
  const { mergeDeliveryAmendment, normalizeNewRecord } = require('../src/services/media-delivery-store');
  const delivery = require('../src/services/media-delivery');
  const word = normalizeNewRecord({ userId: 'u1', chatId: 'c', fileIds: ['clase'], fileNames: ['clase.mp4'], goal: 'transcribe en Word',
    mode: 'transcript', formats: ['txt', 'docx'], output: { documentFormat: 'docx' } }, Date.now());
  const pdf = mergeDeliveryAmendment(word, { goal: 'mejor en PDF', documentFormat: 'pdf' });
  assert.deepEqual(pdf.record.formats, ['txt', 'pdf']);
  const none = mergeDeliveryAmendment(pdf.record, { goal: 'sin Word ni PDF', removeDocument: ['docx', 'pdf'] });
  assert.deepEqual(none.record.formats, ['txt']);
  // «Word no, PDF sí»: one swap, said as one.
  const swap = mergeDeliveryAmendment(word, { goal: 'Word no, PDF sí', removeDocument: ['docx'], documentFormat: 'pdf' });
  assert.deepEqual(swap.record.formats, ['txt', 'pdf']);
  assert.match(delivery.amendedMessage(swap), /en PDF en lugar de Word/);
  assert.doesNotMatch(delivery.amendedMessage(swap), /sin el documento/);
  // «Word y PDF», then «sin el PDF»: the record keeps only the Word. And the
  // Word an older switch left in `formats` goes when it is turned down.
  const both = normalizeNewRecord({ userId: 'u1', chatId: 'c', fileIds: ['clase'], fileNames: ['clase.mp4'], goal: 'transcribe en Word y PDF',
    mode: 'transcript', formats: ['txt', 'docx', 'pdf'], output: { documentFormat: 'docx', alsoPdf: true } }, Date.now());
  assert.deepEqual(mergeDeliveryAmendment(both, { goal: 'sin el PDF', removeDocument: ['pdf'] }).record.formats, ['txt', 'docx']);
  const older = normalizeNewRecord({ userId: 'u1', chatId: 'c', fileIds: ['clase'], fileNames: ['clase.mp4'], goal: 'transcribe en PDF',
    mode: 'transcript', formats: ['txt', 'docx', 'pdf'], output: { documentFormat: 'pdf' } }, Date.now());
  const noWord = mergeDeliveryAmendment(older, { goal: 'sin Word', removeDocument: ['docx'] });
  assert.deepEqual(noWord.record.formats, ['txt', 'pdf']);
  assert.equal(noWord.record.output.documentFormat, 'pdf');
  // A record from before the fix (Word left in its formats): the Word turned
  // down is never built, and the PDF that replaced it is not «missing Word».
  const pack = require('../src/services/media-transcript-artifacts');
  const original = pack.buildMediaTranscriptArtifacts;
  const asked = [];
  pack.buildMediaTranscriptArtifacts = async ({ output }) => { asked.push(output); return { artifacts: [] }; };
  try {
    await delivery.professionalBuildArtifacts({ rows: [], transcripts: {}, delivery: { formats: ['txt', 'docx'], output: { declinedDocuments: ['docx', 'pdf'] } } });
  } finally {
    pack.buildMediaTranscriptArtifacts = original;
  }
  assert.equal(asked[0].documentFormat, null, 'no Word nobody wants');
  const row = { id: 'clase', originalName: 'clase.mp4', processingStage: 'ready', extractedText: 'Hola a todos.', deliveryState: 'ready' };
  const message = delivery.deliveryMessage({ delivery: { fileIds: ['clase'], fileNames: ['clase.mp4'], formats: ['txt', 'docx', 'pdf'],
    output: { documentFormat: 'pdf' } }, rows: [row], artifacts: [{ filename: 'clase.txt', format: 'txt' }, { filename: 'clase.pdf', format: 'pdf' }] });
  assert.doesNotMatch(message, /No pude generar/);
});

test('a moment of a recording already translated whole keeps the whole translation', () => {
  const { mergeDeliveryAmendment, normalizeNewRecord } = require('../src/services/media-delivery-store');
  const record = normalizeNewRecord({ userId: 'u1', chatId: 'c', fileIds: ['clase'], fileNames: ['clase.mp4'], goal: 'transcribe y tradúcelo al inglés',
    mode: 'translation', formats: ['txt'], output: { translationTarget: 'en' } }, Date.now());
  const moment = mergeDeliveryAmendment(record, { goal: 'traduce al inglés lo que dice en el minuto 30', translationTarget: 'en',
    translationRange: { start: 1740, end: 2040 } });
  assert.equal(moment.record.output.translationRange, undefined, 'never narrowed to five minutes');
  assert.deepEqual(moment.changes, ['translation_moment_covered']);
  assert.match(require('../src/services/media-delivery').amendedMessage(moment), /traducida al inglés, completa \(incluye ese momento\)/);
  // Another language is a second translation of that moment: the whole
  // English one stays.
  const other = mergeDeliveryAmendment(record, { goal: 'traduce al francés lo del minuto 30', translationTarget: 'fr', translationRange: { start: 1740, end: 2040 } });
  assert.equal(other.record.output.translationTarget, 'en');
  assert.equal(other.record.output.translationRange, undefined);
  assert.deepEqual(other.record.output.extraTranslations, [{ target: 'fr', ranges: [{ start: 1740, end: 2040 }] }]);
  assert.deepEqual(other.changes, ['translation_added']);
});

test('an option the delivery already has next to a question still asks for the analysis', async () => {
  for (const goal of ['en Word y dime de qué trata la clase', 'en word y hazme 5 preguntas', 'en Word, y dime los temas de la clase',
    'no lo traduzcas, solo dime qué dice el profesor', 'transcribe los audios y dime los temas', 'del minuto 10 al 20 y hazme 5 preguntas',
    'está en inglés, hazme 5 preguntas']) {
    const { delivery, calls } = pendingDeliveryFake({ outcome: 'unchanged', changes: [] });
    await runMediaBranch(followupContext({ goal, delivery, plain: /^transcribe/.test(goal), waitForMediaBatch: async () => { throw new Error('no wait'); } }));
    assert.equal(calls.amends[0].amendment.wantsAnalysis, true, goal);
  }
  // The option alone stays an option. TXT is always delivered: «ponlo en txt» is already so.
  for (const goal of ['en Word', 'en Word, gracias', 'no lo traduzcas', 'sin subtítulos', 'ponlo en txt', 'dámelo en txt',
    'lo quiero en txt', 'está en inglés']) {
    const { delivery, calls } = pendingDeliveryFake({ outcome: 'unchanged', changes: [] });
    await runMediaBranch(followupContext({ goal, delivery, waitForMediaBatch: async () => { throw new Error('no wait'); } }));
    assert.ok(calls.amends.every(call => call.amendment.wantsAnalysis !== true), goal);
  }
});

test('after a Stop, a summary or a question about the ready recordings never restarts the stopped ones', async () => {
  const stopped = (id) => ({ ...readyRow(id, `${id}.mp4`), processingStage: 'failed', extractedText: null,
    processingError: require('../src/services/media-transcription-queue').CANCELLED_NOTE });
  const rows = [readyRow('v0', 'clase1.mp4'), stopped('v1'), stopped('v2')];
  const run = async (displayGoal) => {
    const waits = [];
    await runMediaBranch({
      mediaBatchRows: rows, displayGoal, goal: 'x',
      mediaBatch: { ...batch, waitForMediaBatch: async (args) => { waits.push(args); return { rows, ready: 1, failed: 2, pending: 0, partial: 0 }; } },
      prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [],
      backfillUserMessageFilesForTranscription: async () => {}, emit() {},
      controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
      saveArtifact: (artifact) => ({ ...artifact, id: 'art' }), artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
      plainTranscriptionRequest: false, openai: {}, task: {}, documentPolicy: {},
      require: (name) => require(name === '../media-transcript-artifacts' ? '../src/services/media-transcript-artifacts' : name),
      ...mediaBranchHelpers({ loadMediaDeliveryService: () => null }),
      throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
    }).catch(() => null);
    return waits.map(args => Boolean(args.resumeStopped));
  };
  for (const goal of ['resume las clases que ya están transcritas', '¿qué dijo el profesor en el minuto 10?', 'en Word',
    'resume la transcripción de la clase 1', '¿qué dice la transcripción en el minuto 10?', 'tradúceme la transcripción de la clase 1',
    'pásalo a Word']) {
    const waits = await run(goal);
    assert.ok(waits.length > 0, goal);
    assert.ok(waits.every(resume => resume === false), goal);
  }
  for (const goal of ['transcribe las clases', 'dame la transcripción', 'retómala', 'reintenta']) {
    const waits = await run(goal);
    assert.ok(waits.length > 0 && waits.every(resume => resume === true), goal);
  }
});

test('after a Stop, a request resumes only the recording it names, and none for the finished ones', async () => {
  const stopped = (id, name) => ({ ...readyRow(id, name), processingStage: 'failed', extractedText: null,
    processingError: require('../src/services/media-transcription-queue').CANCELLED_NOTE });
  const rows = [readyRow('v0', 'Clase 1.mp4'), stopped('v1', 'Clase 2.mp4'), stopped('v2', 'Clase 20.mp4'), stopped('v3', 'tutoria3.mp4')];
  const run = async (displayGoal) => {
    const waits = [];
    await runMediaBranch({
      mediaBatchRows: rows, displayGoal, goal: 'x',
      mediaBatch: { ...batch, waitForMediaBatch: async (args) => { waits.push(args); return { rows, ready: 1, failed: 3, pending: 0, partial: 0 }; } },
      prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [],
      backfillUserMessageFilesForTranscription: async () => {}, emit() {},
      controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
      saveArtifact: (artifact) => ({ ...artifact, id: 'art' }), artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
      plainTranscriptionRequest: false, openai: {}, task: {}, documentPolicy: {},
      require: (name) => require(name === '../media-transcript-artifacts' ? '../src/services/media-transcript-artifacts' : name),
      ...mediaBranchHelpers({ loadMediaDeliveryService: () => null }),
      throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
    }).catch(() => null);
    assert.ok(waits.length > 0, displayGoal);
    return JSON.parse(JSON.stringify(waits[0].resumeStopped));
  };
  assert.deepEqual(await run('transcribe la clase 2'), ['v1']);
  assert.deepEqual(await run('quiero la transcripción de la clase 20'), ['v2'], 'never «Clase 2» too');
  assert.deepEqual(await run('pásame la transcripción de la tutoría 3 en Word'), ['v3'], '«tutoria3» answers to «tutoría 3»');
  assert.deepEqual(await run('transcribe la clase 1'), ['v0'], 'the one it names is ready: nothing else restarts');
  assert.equal(await run('transcribe las clases'), true, 'no single one named: every stopped one');
  assert.equal(await run('ya, listo: transcribe las clases'), true, 'a filler «ya» is no limit');
  for (const goal of ['pásame la transcripción de las que ya están transcritas', 'dame la transcripción de las que ya están listas',
    'quiero la transcripción de los que ya tienen transcripción', 'transcripción de las que sí se transcribieron, en Word']) {
    assert.equal(await run(goal), false, goal);
  }
  assert.equal(await run('retómalas; de las que ya están listas dame la transcripción'), true, 'an explicit «retómalas» resumes');
  assert.equal(require('../src/services/media-batch').limitsToFinished('pasa a PDF las que ya están transcritas'), true);
  const mb = require('../src/services/media-batch');
  const named = mb.pickRowByName([{ id: 'a', originalName: 'Clase 2.mp4' }, { id: 'b', originalName: 'Clase 20.mp4' }], 'revisa el minuto 12 de la clase 20');
  assert.equal(named?.id, 'b', 'a refine of «la clase 20» is not ambiguous either');
});

// ── the eighth review: which stopped recordings a message resumes ──────────

function resumeHarness(rowsSpec) {
  const { CANCELLED_NOTE } = require('../src/services/media-transcription-queue');
  const make = () => rowsSpec.map(([id, name, state]) => ({ ...readyRow(id, name),
    ...(state === 'stopped' ? { processingStage: 'failed', extractedText: null, processingError: CANCELLED_NOTE } : {}),
    ...(state === 'failed' ? { processingStage: 'failed', extractedText: null, processingError: 'No se detectó voz en este archivo.' } : {}),
    ...(state === 'pending' ? { processingStage: 'extracting', extractedText: null } : {}) }));
  return async (displayGoal, { delivery = null } = {}) => {
    const rows = make();
    const requeued = [];
    const amends = [];
    const result = await runMediaBranch({
      mediaBatchRows: rows, displayGoal, goal: 'x',
      mediaBatch: { ...batch, waitForMediaBatch: (args) => batch.waitForMediaBatch({ ...args, timeoutMs: 0, readProgress: null, wait: async () => {},
        // Only a retry re-runs a recording; a pending one is only ensured in the queue.
        enqueue: async ({ fileId, retry }) => { if (retry) requeued.push(fileId); return { queued: true }; } }) },
      prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [],
      backfillUserMessageFilesForTranscription: async () => {}, emit() {},
      controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
      saveArtifact: (artifact) => ({ ...artifact, id: 'art' }), artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
      plainTranscriptionRequest: false, openai: {}, task: {}, documentPolicy: {},
      require: (name) => require(name === '../media-transcript-artifacts' ? '../src/services/media-transcript-artifacts' : name),
      ...mediaBranchHelpers({ loadMediaDeliveryService: () => delivery }),
      throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
    }).catch(error => ({ error }));
    if (delivery?.__amends) amends.push(...delivery.__amends);
    return { requeued: [...new Set(requeued)], result, amends };
  };
}

test('after a Stop, a message resumes the recordings it names, all but the ones it leaves out, or none', async () => {
  const run = resumeHarness([['v1', 'Clase 1.mp4', 'ready'], ['v2', 'Clase 2.mp4', 'stopped'], ['v3', 'Clase 3.mp4', 'stopped'],
    ['v4', 'Clase 4.mp4', 'stopped'], ['v5', 'Clase 5.mp4', 'failed']]);
  const cases = [
    ['transcribe todas menos la clase 4', ['v2', 'v3']],
    ['retómalas, menos la clase 4', ['v2', 'v3']],
    ['transcribe todas, la clase 4 no', ['v2', 'v3']],
    ['retoma la transcripción sin la clase 4', ['v2', 'v3']],
    ['transcribe la clase 2 y la 3', ['v2', 'v3']],
    ['quiero la transcripción de la clase 2 y de la 3', ['v2', 'v3']],
    ['transcribe la clase 2 y la clase 3', ['v2', 'v3']],
    ['transcribe solo la clase 2, no transcribas las demás', ['v2']],
    ['transcribe la clase 2, no sigas con las demás', ['v2']],
    ['retoma la transcripción, la clase 2 quedó sin transcribir', ['v2']],
    ['dame la transcripción de las que están listas', []],
    ['dame la transcripción de las que ya terminaron', []],
    ['dame la transcripción parcial', []],
    ['dame la transcripción de lo que llevas', []],
    ['dame la transcripción de las que ya están listas y retoma las demás', ['v2', 'v3', 'v4']],
    // «reintenta los audios fallidos» retries what failed, never what was stopped.
    ['reintenta los audios fallidos', ['v5']],
    ['no la retomes, solo dime qué alcanzaste', []],
  ];
  for (const [goal, expected] of cases) {
    const { requeued } = await run(goal);
    assert.deepEqual(requeued.sort(), expected, goal);
  }
});

test('after a Stop, a name inside a longer one never resumes the wrong recording', async () => {
  const pairs = [
    [[['a', 'Clase 2.mp4', 'stopped'], ['b', 'Clase 2B.mp4', 'stopped'], ['c', 'Clase 3.mp4', 'stopped']], 'transcribe la clase 2B', ['b']],
    [[['a', 'Clase 2.mp4', 'stopped'], ['b', 'Clase 2B.mp4', 'stopped'], ['c', 'Clase 3.mp4', 'stopped']], 'transcribe la clase 2', ['a']],
    [[['a', 'Reunión.m4a', 'stopped'], ['b', 'Reunión 2.m4a', 'stopped']], 'transcribe la reunión 2', ['b']],
    [[['a', 'Reunión.m4a', 'stopped'], ['b', 'Reunión 2.m4a', 'stopped']], 'transcribe Reunión 2.m4a', ['b']],
    [[['a', 'Clase.mp4', 'stopped'], ['b', 'Clase 2.mp4', 'ready']], 'transcribe la clase 2', []],
    [[['a', 'Clase de Física.mp4', 'stopped'], ['b', 'Clase de Física (2).mp4', 'stopped']], 'transcribe la clase de física 2', ['b']],
    [[['a', 'Clase 2.mp4', 'stopped'], ['b', 'Clase 2 - ejercicios.mp4', 'stopped']], 'transcribe los ejercicios de la clase 2', ['b']],
  ];
  for (const [spec, goal, expected] of pairs) {
    const { requeued } = await resumeHarness(spec)(goal);
    assert.deepEqual(requeued.sort(), expected, `${goal} over ${spec.map(([, name]) => name).join(', ')}`);
  }
  // Refine by name and the transcript tools find the longer name too.
  const rows = [{ id: 'a', originalName: 'Reunión.m4a' }, { id: 'b', originalName: 'Reunión 2.m4a' }];
  assert.equal(batch.pickRowByName(rows, 'revisa del minuto 12 al 15 de la reunión 2, se escuchó mal')?.id, 'b');
  assert.equal(batch.pickRowByName(rows, 'Reunión 2.m4a, del minuto 12 al 15')?.id, 'b');
  assert.equal(batch.pickRowByName(rows, 'la reunión')?.id, 'a');
});

test('a turn that leaves the recordings stopped completes, and is never reported as a failed task', async () => {
  const { result } = await resumeHarness([['v1', 'clase.mp4', 'stopped']])('no la retomes, solo dime qué alcanzaste');
  assert.notEqual(result.stoppedReason, 'media_batch_failed');
  assert.equal(result.metadata?.mediaBatch?.stopped, 1);
  assert.match(String(result.finalMarkdown), /Una grabación sigue detenida/);
});

test('with a delivery open, asking for another stopped recording resumes it; «retómalas» never buys a summary', async () => {
  const run = resumeHarness([['v1', 'Clase 1.mp4', 'ready'], ['v2', 'Clase 2.mp4', 'pending'], ['v3', 'Clase 3.mp4', 'stopped'], ['v4', 'Clase 4.mp4', 'stopped']]);
  for (const [goal, expected] of [['transcribe también la clase 3', ['v3']], ['retómalas', ['v3', 'v4']]]) {
    const { delivery, calls } = pendingDeliveryFake({ outcome: 'unchanged', changes: [] });
    const { requeued, result } = await run(goal, { delivery });
    assert.deepEqual(requeued.sort(), expected, goal);
    assert.ok(calls.amends.every(call => call.amendment.wantsAnalysis !== true), `${goal}: no paid summary`);
    assert.match(String(result.finalMarkdown), /^Retomo la transcripción de /, goal);
    assert.doesNotMatch(String(result.finalMarkdown), /Ya estoy transcribiendo/, goal);
  }
});

test('a hand-off after resuming some recordings says which ones stay stopped', async () => {
  const { CANCELLED_NOTE } = require('../src/services/media-transcription-queue');
  const rows = [readyRow('v1', 'Clase 1.mp4'),
    ...['v2', 'v3', 'v4'].map((id, i) => ({ ...readyRow(id, `Clase ${i + 2}.mp4`), processingStage: 'failed', extractedText: null, processingError: CANCELLED_NOTE }))];
  const adapter = { isMediaDeliveryEnabled: () => true, createDelivery: async () => ({ id: 'md_resume' }),
    handOffMessage: () => 'Te aviso aquí cuando terminen.', estimateTranscriptionSeconds: () => 900 };
  const result = await runMediaBranch({
    mediaBatchRows: rows, displayGoal: 'transcribe la clase 2', goal: 'x',
    mediaBatch: { ...batch, waitForMediaBatch: async (args) => {
      const out = await batch.waitForMediaBatch({ ...args, timeoutMs: 0, readProgress: null, wait: async () => {},
        enqueue: async ({ fileId }) => { const row = rows.find(item => item.id === fileId); Object.assign(row, { processingStage: 'uploaded', processingError: null }); return { queued: true }; } });
      return { ...out, stoppedEarly: true };
    } },
    prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [],
    backfillUserMessageFilesForTranscription: async () => {}, emit() {},
    controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
    saveArtifact: (artifact) => ({ ...artifact, id: 'art' }), artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
    plainTranscriptionRequest: true, openai: {}, task: {}, documentPolicy: {},
    require: (name) => require(name === '../media-transcript-artifacts' ? '../src/services/media-transcript-artifacts' : name),
    ...mediaBranchHelpers({ loadMediaDeliveryService: () => adapter }),
    throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
  });
  assert.equal(result.stoppedReason, 'media_delivery_handoff');
  assert.match(result.finalMarkdown, /2 grabaciones siguen detenidas \(«Clase 3\.mp4», «Clase 4\.mp4»\): escribe «retómalas» si las quieres\./);
});

test('«retómala» after a Stop resumes the transcript, never a paid analysis of every recording', () => {
  const mb = require('../src/services/media-batch');
  for (const goal of ['retómala', 'Sí, retómala, por favor', 'reanúdala', 'continúala', '¿puedes retomarla?', 'retoma la transcripción',
    'reanuda la transcripción', 'sigue transcribiendo las clases', 'retoma los audios', 'ok, reanuda las grabaciones',
    'continúa con los audios', 'quiero que sigas con la transcripción']) {
    assert.equal(mb.isTranscriptGoal(goal), true, goal);
    assert.equal(mb.wantsMediaAnalysis(goal), false, goal);
  }
  for (const goal of ['continúa', 'sigue', 'resúmelo', 'retoma el tema de ayer', 'siguiente pregunta', 'continúa con la explicación']) {
    assert.equal(mb.isTranscriptGoal(goal), false, goal);
  }
});

test('an extracted recording is named after what the user uploaded in the hand-off, the record and the delivery', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createMediaDeliveryStore } = require('../src/services/media-delivery-store');
  const mediaDelivery = require('../src/services/media-delivery');
  const rows = [{ id: 'clase', originalName: 'Clase 3.audio.ogg', processingStage: 'extracting', extractedText: null, size: 4e9 }];
  const prisma = { documentAnalysis: { findMany: async () => [{ fileId: 'clase',
    metadata: { clientExtracted: { tier: 'opus', sourceName: 'Clase 3.mp4', sourceSize: 900_000_000, sourceType: 'video/mp4' } } }] } };
  const created = [];
  const handOffs = [];
  const labels = [];
  const adapter = { isMediaDeliveryEnabled: () => true,
    createDelivery: async (record) => { created.push(record); return { id: 'md_names' }; },
    handOffMessage: (args) => { handOffs.push(args); return 'Te aviso aquí.'; },
    estimateTranscriptionSeconds: () => 900 };
  await runMediaBranch({
    mediaBatchRows: rows,
    mediaBatch: { ...batch, waitForMediaBatch: async () => ({ rows, total: 1, ready: 0, failed: 0, pending: 1, partial: 0, progress: {}, stoppedEarly: true }) },
    prisma, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [], displayGoal: 'transcribe', goal: 'transcribe',
    backfillUserMessageFilesForTranscription: async () => {}, emit: (event) => { if (event?.label) labels.push(event.label); },
    controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
    saveArtifact: () => { throw new Error('no artifacts before the transcript exists'); },
    artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
    plainTranscriptionRequest: true, openai: {}, task: {}, documentPolicy: {},
    require: mediaRuntime(async () => { throw new Error('no model call before the transcript exists'); }),
    ...mediaBranchHelpers({ loadMediaDeliveryService: () => adapter }),
    throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
  });
  assert.deepEqual([...created[0].fileNames], ['Clase 3.mp4'], 'the Stop line names it too');
  assert.deepEqual([...handOffs[0].fileNames], ['Clase 3.mp4']);
  assert.ok(labels.some(label => label === 'Transcribiendo «Clase 3.mp4»'), labels.join(' | '));

  // The delivery: its message, its notification and a re-created chat's title.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-names-'));
  const posted = [];
  const notified = [];
  const titles = [];
  const service = mediaDelivery.createMediaDeliveryService({
    env: { SIRAGPT_MEDIA_DELIVERY: '1' }, logger: { info() {}, warn() {} }, store: createMediaDeliveryStore({ root }),
    prisma: { message: { findFirst: async () => null } },
    loadFiles: async () => [{ id: 'clase', userId: 'owner', originalName: 'Clase 3.audio.ogg', mimeType: 'audio/ogg', processingStage: 'ready', extractedText: 'Hola a todos.' }],
    loadTranscript: async () => ({ sourceName: 'Clase 3.mp4' }),
    buildArtifacts: async () => [{ filename: 'Clase 3 (transcripción).txt', base64: 'eA==', mime: 'text/plain' }],
    saveArtifact: ({ filename, mime }) => ({ id: 'a1', filename, mime, format: 'txt' }),
    persistArtifact: async () => {},
    postMessage: async ({ chatId, content }) => { posted.push(content); return { messageId: 'm1', chatId }; },
    ensureChat: async ({ chatId, title }) => { titles.push(title); return { chatId: 'chat2', created: true }; },
    notify: async (payload) => { notified.push(payload); },
  });
  const record = await service.createDelivery({ userId: 'owner', chatId: 'gone', taskId: null, fileIds: ['clase'], fileNames: ['Clase 3.audio.ogg'],
    goal: 'transcribe', mode: 'transcript', formats: ['txt'] });
  assert.equal((await service.deliverOne(record.id)).status, 'delivered');
  assert.match(posted[0], /Clase 3\.mp4/);
  assert.doesNotMatch(posted[0], /\.audio\.ogg/);
  assert.equal(titles[0], 'Transcripción: Clase 3.mp4');
  assert.doesNotMatch(JSON.stringify(notified), /\.audio\.ogg/);
  fs.rmSync(root, { recursive: true, force: true });
});


test('first requests keep the analysis they ask for; a format alone or ordinary words never start one', () => {
  const mb = require('../src/services/media-batch');
  for (const goal of ['transcríbelo y resúmemelo', 'transcribe la clase y me la resumes', 'transcribe el audio y luego me lo resumes por favor',
    'transcribe la clase y dime cuáles son los temas', 'transcribe la clase y menciona los acuerdos', 'transcribe la clase y compárala con la anterior',
    'transcribe la clase y dime qué decisiones se tomaron']) {
    assert.equal(mb.wantsMediaAnalysis(goal), true, goal);
  }
  assert.equal(mb.wantsSummaryWithTranslation('tradúcelo al inglés y resúmemelo'), true);
  // More than the transcript in a format: a report or «lo más importante».
  for (const goal of ['convierte este audio en un documento con los puntos más importantes', 'pasa la reunión a un informe en Word',
    'pásalo a Word con lo más importante']) {
    assert.equal(mb.isTranscriptGoal(goal), false, goal);
  }
  for (const goal of ['pásalo a Word', 'ponlo en PDF', 'dámelo en Word', 'lo quiero en Word', 'pasa estos audios a texto']) {
    assert.equal(mb.isTranscriptGoal(goal), true, goal);
  }
  for (const goal of ['lo quiero en Word, que es más fácil de editar', 'en Word porque lo tengo que editar', 'pásalo a PDF para que lo pueda imprimir',
    'ponlo en word que lo necesito para mañana', 'en Word, de acuerdo', 'no lo traduzcas, que lo quiero en español', 'es para mi tarea']) {
    assert.equal(mb.asksForDeliverable(goal), false, goal);
  }
  for (const goal of ['en Word y dime de qué trata la clase', 'no lo traduzcas, solo dime qué dice el profesor', 'hazme 5 preguntas', 'resúmelo']) {
    assert.equal(mb.asksForDeliverable(goal), true, goal);
  }
  for (const goal of ['no la traduzcas porfa', 'mejor no la traduzcas por ahora', 'no lo traduzcas aún', 'ya no la traduzcas pls', 'no lo traduzcas entonces']) {
    assert.equal(mb.negatesTranslation(goal), true, goal);
  }
  assert.equal(mb.negatesTranslation('no traduzcas los nombres propios'), false, 'a condition keeps the translation');
  assert.equal(mb.refusesTranslationWord('no traduzcas los nombres propios'), true);
});

test('follow-ups: ordinary words next to an option, take-backs, conditions, moments and windows', async () => {
  const amendOf = async (goal, outcome = 'unchanged') => {
    const { delivery, calls } = pendingDeliveryFake({ outcome, changes: [] });
    await runMediaBranch(followupContext({ goal, delivery, plain: /^(?:transcribe|dame la transcripci)/.test(goal),
      waitForMediaBatch: async () => { throw new Error('no wait'); } }));
    return calls.amends.map(call => JSON.parse(JSON.stringify(call.amendment)));
  };
  for (const goal of ['lo quiero en Word, que es más fácil de editar', 'en Word porque lo tengo que editar', 'pásalo a PDF para que lo pueda imprimir',
    'en Word, de acuerdo', 'no la traduzcas porfa', 'mejor no la traduzcas por ahora', 'no lo traduzcas aún', 'no traduzcas los nombres propios',
    'no traduzcas las siglas', 'quiero que lo pongas en Word', 'en word para que lo pueda editar', 'en Word porque lo voy a imprimir',
    'en Word, es para una tarea', 'no lo conviertas a Word, que no tengo Office', 'ponlo en Word como te dije']) {
    const amends = await amendOf(goal);
    assert.ok(amends.every(amendment => amendment.wantsAnalysis !== true), `${goal}: no paid analysis`);
  }
  assert.equal((await amendOf('no la traduzcas porfa'))[0].removeTranslation, true);
  assert.equal((await amendOf('no traduzcas los nombres propios'))[0].removeTranslation, false, 'a condition keeps the translation');
  // A moment the catch-all reads, not the window of an earlier question.
  const moment = (await amendOf('¿y en el minuto 45?')).find(amendment => amendment.wantsAnalysis === true);
  assert.deepEqual(moment.analysisRange, { start: 2640, end: 2940 });
  assert.equal(moment.keepWindow, undefined);
  const plain = (await amendOf('explícamelo mejor')).find(amendment => amendment.wantsAnalysis === true);
  assert.equal(plain.keepWindow, true);
  // Windows.
  const translated = (await amendOf('traduce al inglés lo que dice del minuto 10 al 20', 'amended'))[0];
  assert.equal(translated.wantsAnalysis, false, 'the translation of a stretch adds no summary');
  assert.deepEqual(translated.translationRange, { start: 600, end: 1200 });
  const stretch = (await amendOf('transcribe lo que dice el profesor del minuto 10 al 20', 'amended'))[0];
  assert.deepEqual(stretch.range, { start: 600, end: 1200 }, 'the transcript of that stretch');
  assert.equal(stretch.wantsAnalysis, false);
  for (const goal of ['transcribe del minuto 10 al 20 y dime de qué trata', 'dame la transcripción del minuto 10 al 20 y resúmela']) {
    const amendment = (await amendOf(goal, 'amended'))[0];
    assert.deepEqual(amendment.range, { start: 600, end: 1200 }, `${goal}: cut`);
    assert.equal(amendment.wantsAnalysis, true, `${goal}: and analysed`);
  }
});

test('loadMediaBatch and waitForMediaBatch preserve browser-extracted sourceName across polls (never «.audio.ogg»)', async () => {
  let polls = 0;
  const prisma = {
    file: {
      findMany: async () => {
        polls += 1;
        return [{
          id: 'ext1',
          userId: 'u1',
          originalName: 'Clase_Magistral.audio.ogg',
          filename: 'ext1.ogg',
          mimeType: 'audio/ogg',
          processingStage: polls >= 2 ? 'ready' : 'extracting',
          extractedText: polls >= 2 ? '[00:00] Bienvenidos a la clase magistral.' : null,
          deletedAt: null,
        }];
      },
    },
    documentAnalysis: {
      findMany: async () => [{
        fileId: 'ext1',
        userId: 'u1',
        metadata: { clientExtracted: { tier: 'opus', sourceName: 'Clase_Magistral.mp4', sourceSize: 250_000_000, sourceType: 'video/mp4' } },
      }],
    },
  };
  const loaded = await batch.loadMediaBatch(prisma, { userId: 'u1', fileIds: ['ext1'] });
  assert.equal(loaded[0].originalName, 'Clase_Magistral.mp4');
  assert.equal(loaded[0].sourceMedia, 'video');
  const labels = [];
  const waited = await batch.waitForMediaBatch({
    prisma,
    userId: 'u1',
    rows: loaded,
    enqueue: async () => ({ id: 'ext1', queued: true, stage: 'extracting' }),
    readProgress: async () => ({ ext1: { stage: 'transcribe', percent: 50, completed: 1, total: 2 } }),
    onProgress: (p) => labels.push(batch.describeBatchProgress(p)),
    wait: async () => {},
  });
  assert.ok(labels.some((l) => l.includes('Clase_Magistral.mp4') && !l.includes('.audio.ogg')));
  assert.equal(waited.rows[0].originalName, 'Clase_Magistral.mp4');
});

// ── eighth review: translation follow-ups ────────────────────────────────────

// A pending delivery that amends like the real store (mergeDeliveryAmendment)
// and answers with the real copy.
function storeBackedDelivery(initial) {
  const store = require('../src/services/media-delivery-store');
  const real = require('../src/services/media-delivery');
  const state = { record: store.normalizeNewRecord({ userId: 'owner', chatId: 'chat', fileIds: ['clase'], fileNames: ['clase.mp4'],
    formats: ['txt'], ...initial }, Date.now()), amends: [] };
  state.record.id = 'md_open';
  return {
    state,
    delivery: {
      isMediaDeliveryEnabled: () => true,
      estimateTranscriptionSeconds: () => 60,
      findOpenDelivery: async () => state.record,
      amendDelivery: async (id, { amendment }) => {
        state.amends.push(JSON.parse(JSON.stringify(amendment)));
        const { record, changes } = store.mergeDeliveryAmendment(state.record, amendment);
        if (!changes.length) return { outcome: 'unchanged', changes: [], record: state.record };
        state.record = { ...record, id: 'md_open', amendments: [...(state.record.amendments || []), { at: 'now', changes }] };
        return { outcome: 'amended', changes, record: state.record };
      },
      amendedMessage: (args) => real.amendedMessage(args),
      stillRunningMessage: (args) => real.stillRunningMessage(args),
      createDelivery: async () => { throw new Error('no second delivery'); },
      handOffMessage: () => 'Te aviso aquí.',
      cancelUnneededMediaJobs: async () => ({ stopped: 0 }),
    },
  };
}

async function followUpOn(initial, goal) {
  const pending = storeBackedDelivery(initial);
  const result = await runMediaBranch(followupContext({ goal, delivery: pending.delivery,
    waitForMediaBatch: async () => { throw new Error('no wait'); } }));
  return { result, record: pending.state.record, amends: pending.state.amends };
}

const ENGLISH_MOMENT = { mode: 'translation', goal: 'transcribe y traduce al inglés lo que dice en el minuto 30',
  output: { translationTarget: 'en', translationRange: { start: 1740, end: 2040 }, includeTranscript: true } };

// ── ninth review: a switch with a stretch, one language taken back, an added language «completa» ──

const ENGLISH_WHOLE = { mode: 'translation', goal: 'transcribe este video y tradúcelo al inglés', output: { translationTarget: 'en', includeTranscript: true } };

test('a switch that names a stretch replaces the language, never adds one: the English nobody wants is not billed', async () => {
  for (const goal of ['no la traduzcas al inglés sino al francés, del minuto 10 al 20', 'mejor tradúcela al francés, solo del minuto 10 al 20',
    'en vez de inglés, tradúcela al francés del minuto 10 al 20', 'no la traduzcas al inglés, mejor al francés del minuto 10 al 20']) {
    const { result, record, amends } = await followUpOn(ENGLISH_WHOLE, goal);
    assert.equal(amends[0].translationSwitch, true, goal);
    assert.equal(record.output.translationTarget, 'fr', goal);
    assert.equal(record.output.extraTranslations, undefined, `${goal}: no second language`);
    assert.deepEqual(record.output.translationRange, { start: 600, end: 1200 }, goal);
    assert.match(result.finalMarkdown, /traducida al francés \(la traducción, solo del tramo que indicaste\)/, goal);
    assert.doesNotMatch(result.finalMarkdown, /además de la traducción al inglés/, goal);
  }
  // «traduce también al francés lo del minuto 30» still adds it.
  const added = await followUpOn(ENGLISH_WHOLE, 'traduce también al francés lo del minuto 30');
  assert.equal(added.record.output.translationTarget, 'en');
  assert.equal(added.record.output.extraTranslations[0].target, 'fr');
});

test('«ya no la traduzcas al francés» takes back only the French: the English translation stays', async () => {
  const { record: both } = await followUpOn(ENGLISH_WHOLE, 'traduce también al francés');
  assert.equal(both.output.extraTranslations[0].target, 'fr');
  for (const goal of ['ya no la traduzcas al francés', 'ya no hace falta traducirla al francés', 'sin la traducción al francés']) {
    const { result, record, amends } = await followUpOn(both, goal);
    assert.equal(amends[0].removeTranslationTarget, 'fr', goal);
    assert.equal(record.mode, 'translation', goal);
    assert.equal(record.output.translationTarget, 'en', goal);
    assert.equal(record.output.extraTranslations, undefined, goal);
    assert.match(result.finalMarkdown, /sin la traducción al francés \(sigue la traducción al inglés\)/, goal);
  }
  // Taking back the first language keeps the added one, with its own windows.
  const { record: moment } = await followUpOn(ENGLISH_WHOLE, 'traduce también al francés lo del minuto 30');
  const noEnglish = await followUpOn(moment, 'ya no la traduzcas al inglés');
  assert.equal(noEnglish.record.mode, 'translation');
  assert.equal(noEnglish.record.output.translationTarget, 'fr');
  assert.deepEqual(noEnglish.record.output.translationRange, { start: 1740, end: 2040 });
  assert.equal(noEnglish.record.output.extraTranslations, undefined);
  // A language that is not pending changes nothing; «ya no la traduzcas» takes them all back.
  assert.equal((await followUpOn(ENGLISH_WHOLE, 'no la traduzcas al alemán')).record.output.translationTarget, 'en');
  const none = await followUpOn(both, 'ya no la traduzcas');
  assert.equal(none.record.mode, 'transcript');
  assert.equal(none.record.output.extraTranslations, undefined);
});

test('a language added next to a moment: «completa» is the whole recording, without it the same moment, as the reply says', async () => {
  const whole = await followUpOn(ENGLISH_MOMENT, 'tradúcela también al francés completa');
  assert.deepEqual(whole.record.output.extraTranslations, [{ target: 'fr', ranges: [] }]);
  assert.doesNotMatch(whole.result.finalMarkdown, /solo del tramo/);
  const same = await followUpOn(ENGLISH_MOMENT, 'traduce también al francés');
  assert.deepEqual(same.record.output.extraTranslations, [{ target: 'fr', ranges: [{ start: 1740, end: 2040 }] }]);
  assert.match(same.result.finalMarkdown, /también traducida al francés \(solo del tramo que indicaste\)/);
});

test('the translator gets up to five of the user\'s conditions, as many as are read', async () => {
  const batch = require('../src/services/media-batch');
  const systems = [];
  await batch.translateMediaBatch({ rows: [{ id: 'a', originalName: 'a.mp4', processingStage: 'ready', extractedText: '[00:00:00] Hola.' }],
    target: { code: 'en', name: 'inglés' }, conditions: ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis'],
    complete: async (messages) => { systems.push(String(messages[0].content || '')); return 'Hello.'; } });
  assert.match(systems[0], /«cinco»/);
  assert.doesNotMatch(systems[0], /«seis»/);
});

test('«tradúcela completa», as the reply says, translates the whole recording: no language needed, no summary', async () => {
  for (const goal of ['tradúcela completa', 'tradúcelo todo', 'tradúcela toda', 'tradúcelo completo', 'traduce toda la clase',
    'quiero la traducción completa']) {
    const { result, record, amends } = await followUpOn(ENGLISH_MOMENT, goal);
    assert.equal(amends.length, 1, `${goal}: never the catch-all analysis`);
    assert.equal(amends[0].translationTarget, 'en', `${goal}: the pending language`);
    assert.equal(amends[0].translationWhole, true, goal);
    assert.equal(amends[0].wantsAnalysis, false, goal);
    assert.equal(record.output.translationRange, undefined, `${goal}: the whole recording`);
    assert.equal(record.mode, 'translation');
    assert.equal(record.output.alsoAnalysis, false, `${goal}: no summary nobody asked for`);
    assert.match(result.finalMarkdown, /traducida al inglés \(la traducción, completa\)/, goal);
  }
});

test('a first request\'s moment is the translation\'s window: «tradúcela completa al inglés» then translates it all', async () => {
  const handedOff = await firstRequest('traduce al inglés lo que dice en el minuto 30');
  assert.equal(handedOff.range, null, 'the transcript is never cut to the moment');
  assert.deepEqual(handedOff.output.translationRange, { start: 1740, end: 2040 });
  const { result, record } = await followUpOn(handedOff, 'tradúcela completa al inglés');
  assert.equal(record.output.translationRange, undefined);
  assert.equal(record.range, null);
  assert.match(result.finalMarkdown, /traducida al inglés \(la traducción, completa\)/);
  // A record handed off before this change kept the moment as its range.
  const legacy = await followUpOn({ mode: 'translation', goal: 'traduce al inglés lo que dice en el minuto 30', range: { start: 1740, end: 2040 },
    output: { translationTarget: 'en', analysisRange: { start: 1740, end: 2040 } } }, 'tradúcela completa al inglés');
  assert.equal(legacy.record.range, null);
  assert.equal(legacy.record.output.translationRange, undefined);
  assert.match(legacy.result.finalMarkdown, /\(la traducción, completa\)/);
});

test('«lo del minuto N» alone is no question: «transcribe lo del minuto 30» and «solo lo del minuto 10 al 20» buy no analysis', async () => {
  const transcript = await firstRequest('transcribe lo del minuto 30');
  assert.equal(transcript.mode, 'transcript');
  for (const goal of ['solo lo del minuto 10 al 20', 'quiero solo lo del minuto 10 al 20']) {
    const { amends } = await followUp(goal);
    assert.deepEqual(amends[0].range, { start: 600, end: 1200 }, `${goal}: the transcript of that stretch`);
    assert.equal(amends[0].wantsAnalysis, false, goal);
  }
  for (const goal of ['transcribe lo del minuto 30', 'solo lo del minuto 10 al 20', 'dame lo del minuto 10 al 20 en Word', 'pásame lo del minuto 30 en Word', 'corrige lo del minuto 5']) {
    assert.equal(batch.detectMediaFollowupIntent(goal), null, goal);
  }
  // What is said there is what to translate.
  assert.equal(batch.detectMediaFollowupIntent('traduce al inglés lo del minuto 50')?.kind, 'lookup');
});

test('a take-back with the usual fillers drops the translation and is never sent to the translator', async () => {
  const pending = { mode: 'translation', goal: 'transcribe y tradúcelo al inglés', output: { translationTarget: 'en', includeTranscript: true } };
  for (const goal of ['no la traduzcas porfavor', 'no la traduzcas por fa', 'no la traduzcas porfis', 'no la traduzcas plz',
    'no lo traduzcas para nada', 'no la traduzcas en absoluto', 'no la traduzcas a ningún idioma']) {
    const { result, record, amends } = await followUpOn(pending, goal);
    assert.equal(amends[0].removeTranslation, true, goal);
    assert.equal(record.mode, 'transcript', goal);
    assert.match(result.finalMarkdown, /sin la traducción/, goal);
    assert.deepEqual(batch.translationConditions(record.goal), [], `${goal}: no instruction for a translation that no longer runs`);
  }
  // A part or a manner keeps the translation, as a condition.
  for (const goal of ['no traduzcas los nombres propios', 'no lo traduzcas literal', 'no traduzcas el saludo inicial', 'deja las siglas sin traducir']) {
    assert.equal(batch.negatesTranslation(goal), false, goal);
    assert.deepEqual(batch.translationConditions(goal), [goal], goal);
  }
});

test('how to translate reaches the translator, said either way; the latest about a part wins; never a summary', async () => {
  const pending = { mode: 'translation', goal: 'transcribe y tradúcelo al inglés', output: { translationTarget: 'en', includeTranscript: true } };
  const literal = await followUpOn(pending, 'tradúcelo literal');
  assert.equal(literal.amends.length, 1, 'never the catch-all analysis');
  assert.equal(literal.amends[0].wantsAnalysis, false);
  assert.equal(literal.record.mode, 'translation');
  assert.equal(literal.record.output.alsoAnalysis, false);
  assert.match(literal.result.finalMarkdown, /con tus indicaciones para la traducción/);
  assert.deepEqual(batch.translationConditions(literal.record.goal), ['tradúcelo literal']);
  assert.deepEqual(batch.translationConditions('transcribe y tradúcelo al español, pero deja las siglas en inglés'), ['pero deja las siglas en inglés']);
  assert.deepEqual(batch.translationConditions('tradúcelo al inglés, mantén los términos técnicos en español'), ['mantén los términos técnicos en español']);
  // «incluidos los nombres» undoes the earlier «no traduzcas los nombres propios».
  const names = { ...pending, goal: 'transcribe y tradúcelo al inglés, pero no traduzcas los nombres propios' };
  const all = await followUpOn(names, 'tradúcelo todo, incluidos los nombres');
  assert.equal(all.amends.length, 1);
  assert.deepEqual(batch.translationConditions(all.record.goal), ['incluidos los nombres']);
  // «déjalo en Word» is a format, never a condition.
  assert.deepEqual(batch.translationConditions('tradúcelo al inglés y déjalo en Word'), []);
});

test('a moment in another language is a second translation; a new language for a moment says it keeps the moment', async () => {
  const whole = { mode: 'translation', goal: 'transcribe y tradúcelo al inglés', output: { translationTarget: 'en', includeTranscript: true } };
  for (const goal of ['traduce también al francés lo que dice en el minuto 30', 'traduce al francés lo del minuto 30']) {
    const { result, record } = await followUpOn(whole, goal);
    assert.equal(record.output.translationTarget, 'en', `${goal}: the English one stays`);
    assert.equal(record.output.translationRange, undefined, `${goal}: and stays whole`);
    assert.deepEqual(record.output.extraTranslations, [{ target: 'fr', ranges: [{ start: 1740, end: 2040 }] }], goal);
    assert.match(result.finalMarkdown, /también traducida al francés \(solo del tramo que indicaste\), además de la traducción al inglés/, goal);
  }
  const { result, record } = await followUpOn(ENGLISH_MOMENT, 'y tradúcelo al francés');
  assert.equal(record.output.translationTarget, 'fr');
  assert.deepEqual(record.output.translationRange, { start: 1740, end: 2040 });
  assert.match(result.finalMarkdown, /traducida al francés \(la traducción, solo del tramo que indicaste; si la quieres completa, dime «tradúcela completa»\)/);
});

test('«no lo traduzcas al inglés sino al francés» switches the language; a take-back says so; no language asks for it', async () => {
  const pending = { mode: 'translation', goal: 'transcribe y tradúcelo al inglés', output: { translationTarget: 'en', includeTranscript: true } };
  for (const goal of ['no lo traduzcas al inglés sino al francés', 'no la traduzcas al inglés, mejor al francés']) {
    const { result, record, amends } = await followUpOn(pending, goal);
    assert.equal(amends[0].translationTarget, 'fr', goal);
    assert.equal(amends[0].removeTranslation, false, goal);
    assert.equal(record.mode, 'translation', goal);
    assert.equal(record.output.translationTarget, 'fr', goal);
    assert.match(result.finalMarkdown, /traducida al francés/, goal);
    assert.deepEqual(batch.translationConditions(record.goal), [], `${goal}: the language is no instruction`);
  }
  const back = await followUpOn(pending, 'ya no la traduzcas');
  assert.match(back.result.finalMarkdown, /^Anotado: cuando termine la transcripción te la entrego sin la traducción\./);
  // «tradúcela» with nothing that says the language: asked, never a paid analysis.
  const transcriptOnly = storeBackedDelivery({ mode: 'transcript', goal: 'transcribe esta clase' });
  const asked = await runMediaBranch(followupContext({ goal: 'tradúcela', delivery: transcriptOnly.delivery,
    waitForMediaBatch: async () => { throw new Error('no wait'); } }));
  assert.equal(transcriptOnly.state.amends.length, 0);
  assert.match(asked.finalMarkdown, /^¿A qué idioma la traduzco\?/);
  assert.equal(asked.metadata.mediaDeliveryAmended, 'md_open');
});

test('only a request to translate counts: a question, the user\'s own plan and «… y también en Word» are read as they are', async () => {
  const asked = await followUpOn(ENGLISH_MOMENT, '¿la traducción estará completa?');
  assert.deepEqual(asked.record.output.translationRange, { start: 1740, end: 2040 }, 'a question never buys the whole translation');
  assert.doesNotMatch(asked.result.finalMarkdown, /\(la traducción, completa\)/);
  const transcriptOnly = { mode: 'transcript', goal: 'transcribe esta clase' };
  const own = await followUpOn(transcriptOnly, 'transcríbelo, la traduzco yo');
  assert.doesNotMatch(own.result.finalMarkdown, /A qué idioma/, 'the user translates it themselves');
  const whole = { mode: 'translation', goal: 'transcribe y tradúcelo al inglés', output: { translationTarget: 'en', includeTranscript: true } };
  const word = await followUpOn(whole, 'tradúcelo al francés, y también en Word');
  assert.equal(word.record.output.translationTarget, 'fr', '«también» is about the Word: the language switches');
  assert.equal(word.record.output.extraTranslations, undefined);
  assert.equal(word.record.output.documentFormat, 'docx');
});

// ── eighth review: document formats in follow-ups ───────────────────────────

const WORD_PENDING = { mode: 'document', goal: 'transcribe esta clase en Word', formats: ['txt', 'docx'], output: { documentFormat: 'docx' } };
const AUTO_WORD_PENDING = { mode: 'transcript', goal: 'transcribe esta clase', formats: ['txt'] };

test('«en PDF en lugar de Word» and its kin swap the Word for a PDF, and the reply says so', async () => {
  for (const goal of ['mejor en PDF en lugar de Word', 'en PDF en vez de Word', 'pásalo a PDF en vez de Word', 'mejor en PDF que en Word', 'pasa el Word a PDF']) {
    for (const initial of [WORD_PENDING, AUTO_WORD_PENDING]) {
      const { result, record } = await followUpOn(initial, goal);
      assert.equal(record.output.documentFormat, 'pdf', `${goal} (${initial.mode})`);
      assert.ok(record.formats.includes('pdf') && !record.formats.includes('docx'), `${goal} (${initial.mode}): ${record.formats}`);
      assert.deepEqual(record.output.declinedDocuments, ['docx'], `${goal} (${initial.mode}): no automatic Word either`);
      assert.match(result.finalMarkdown, /en PDF/, goal);
      assert.doesNotMatch(result.finalMarkdown, /en Word\b(?! )|Ya estoy transcribiendo/, `${goal} (${initial.mode}): ${result.finalMarkdown}`);
    }
    const { result } = await followUpOn(WORD_PENDING, goal);
    assert.match(result.finalMarkdown, /en PDF en lugar de Word/, goal);
  }
  // A plain «en PDF» after «en Word» says it replaces the Word too.
  assert.match((await followUpOn(WORD_PENDING, 'mejor en PDF')).result.finalMarkdown, /en PDF en lugar de Word/);
});

test('«también en PDF» keeps the Word and adds the PDF; the two documents can be taken back one at a time', async () => {
  for (const goal of ['también en PDF', 'y pásamelo también en PDF porfa', 'mándamelo en PDF también']) {
    const { result, record } = await followUpOn(WORD_PENDING, goal);
    assert.equal(record.output.documentFormat, 'docx', goal);
    assert.equal(record.output.alsoPdf, true, goal);
    assert.ok(record.formats.includes('docx') && record.formats.includes('pdf'), `${goal}: ${record.formats}`);
    assert.match(result.finalMarkdown, /en Word y en PDF/, goal);
  }
  const both = { mode: 'document', goal: 'transcribe esta clase en Word y PDF', formats: ['txt', 'docx', 'pdf'], output: { documentFormat: 'docx', alsoPdf: true } };
  const noPdf = await followUpOn(both, 'sin el PDF');
  assert.equal(noPdf.record.output.alsoPdf, undefined);
  assert.equal(noPdf.record.output.documentFormat, 'docx');
  assert.match(noPdf.result.finalMarkdown, /sin el PDF/);
  const noWord = await followUpOn(both, 'sin Word');
  assert.equal(noWord.record.output.documentFormat, 'pdf');
  assert.equal(noWord.record.output.alsoPdf, undefined);
  assert.match(noWord.result.finalMarkdown, /en PDF en lugar de Word/);
  const onlyWord = await followUpOn(both, 'solo en Word');
  assert.equal(onlyWord.record.output.alsoPdf, undefined);
  assert.ok(!onlyWord.record.formats.includes('pdf'));
  // «en Word y también subtítulos» adds subtitles, never a PDF.
  const subs = await followUpOn(WORD_PENDING, 'en Word y también subtítulos');
  assert.equal(subs.record.output.alsoPdf, undefined);
});

// ── ninth review: conversions, a refusal after the format, «también …» with a verb ──

const PDF_PENDING_DOC = { mode: 'document', goal: 'transcribe esta clase en PDF', formats: ['txt', 'pdf'], output: { documentFormat: 'pdf' } };

test('«pásalo de Word a PDF» and «cambia el PDF por un documento Word» convert: one document, never both', async () => {
  for (const [initial, goal, format, other] of [[WORD_PENDING, 'mejor pásalo de Word a PDF', 'pdf', 'Word'], [WORD_PENDING, 'conviértelo de Word a PDF', 'pdf', 'Word'],
    [PDF_PENDING_DOC, 'pásalo de PDF a Word', 'docx', 'PDF'], [PDF_PENDING_DOC, 'cámbialo de PDF a Word', 'docx', 'PDF'],
    [PDF_PENDING_DOC, 'cambia el PDF por un documento Word', 'docx', 'PDF']]) {
    const { result, record } = await followUpOn(initial, goal);
    assert.equal(record.output.documentFormat, format, goal);
    assert.equal(record.output.alsoPdf, undefined, `${goal}: one document`);
    assert.deepEqual(record.formats.filter(f => f === 'docx' || f === 'pdf'), [format], `${goal}: ${record.formats}`);
    assert.match(result.finalMarkdown, new RegExp(`en ${format === 'pdf' ? 'PDF' : 'Word'} en lugar de ${other}`), `${goal}: ${result.finalMarkdown}`);
  }
});

test('a refusal after the format («el Word sí, el PDF no», «… que el PDF no me sirve», «solo en Word, el PDF no lo necesito») keeps one document', async () => {
  for (const goal of ['el Word sí, el PDF no', 'en Word, que el PDF no me sirve', 'mejor en Word, el PDF no lo necesito']) {
    const { result, record } = await followUpOn(PDF_PENDING_DOC, goal);
    assert.equal(record.output.documentFormat, 'docx', goal);
    assert.equal(record.output.alsoPdf, undefined, goal);
    assert.ok(!record.formats.includes('pdf'), `${goal}: ${record.formats}`);
    assert.match(result.finalMarkdown, /en Word en lugar de PDF/, `${goal}: ${result.finalMarkdown}`);
  }
  const both = { mode: 'document', goal: 'transcribe esta clase en Word y PDF', formats: ['txt', 'docx', 'pdf'], output: { documentFormat: 'docx', alsoPdf: true } };
  const onlyWord = await followUpOn(both, 'solo en Word, el PDF no lo necesito');
  assert.equal(onlyWord.record.output.documentFormat, 'docx');
  assert.equal(onlyWord.record.output.alsoPdf, undefined);
  assert.ok(!onlyWord.record.formats.includes('pdf'));
  assert.match(onlyWord.result.finalMarkdown, /sin el PDF/);
  // «el PDF no se ve bien» refuses nothing.
  assert.deepEqual(artifacts.negatedTranscriptFormats('el PDF no se ve bien').documents, []);
});

test('«también lo quiero en PDF» and «el PDF también lo quiero» add the PDF next to the Word', async () => {
  for (const goal of ['también lo quiero en PDF', 'y también lo necesito en PDF', 'también me lo pasas en PDF', 'el PDF también lo quiero']) {
    const { result, record } = await followUpOn(WORD_PENDING, goal);
    assert.equal(record.output.documentFormat, 'docx', goal);
    assert.equal(record.output.alsoPdf, true, goal);
    assert.match(result.finalMarkdown, /en Word y en PDF/, `${goal}: ${result.finalMarkdown}`);
  }
});

test('«también en PDF» with no document chosen keeps the automatic Word of a long recording and adds the PDF', async () => {
  const { record } = await followUpOn(AUTO_WORD_PENDING, 'también en PDF');
  assert.equal(record.output.documentFormat, null);
  assert.equal(record.output.alsoPdf, true);
  const delivery = require('../src/services/media-delivery');
  const pack = require('../src/services/media-transcript-artifacts');
  const original = pack.buildMediaTranscriptArtifacts;
  const asked = [];
  pack.buildMediaTranscriptArtifacts = async ({ output }) => { asked.push(output); return { artifacts: [] }; };
  try {
    await delivery.professionalBuildArtifacts({ rows: [], transcripts: {}, delivery: record });
  } finally {
    pack.buildMediaTranscriptArtifacts = original;
  }
  assert.equal(asked[0].documentFormat, null, 'the automatic Word rule stays');
  assert.equal(asked[0].alsoPdf, true);
});

test('a refusal that says «documento» turns the document down, never asks for a Word', async () => {
  const PDF_PENDING = { mode: 'document', goal: 'transcribe esta clase en PDF', formats: ['txt', 'pdf'], output: { documentFormat: 'pdf' } };
  for (const goal of ['ya no lo quiero en documento', 'transcríbelo sin documento, solo el txt']) {
    for (const initial of [AUTO_WORD_PENDING, PDF_PENDING, WORD_PENDING]) {
      const { result, record } = await followUpOn(initial, goal);
      assert.ok(!record.output.documentFormat, `${goal} (${initial.goal}): ${record.output.documentFormat}`);
      assert.deepEqual(record.output.declinedDocuments, ['docx', 'pdf'], `${goal} (${initial.goal})`);
      assert.ok(!record.formats.includes('docx') && !record.formats.includes('pdf'), `${goal}: ${record.formats}`);
      assert.doesNotMatch(result.finalMarkdown, /en Word|en PDF/, `${goal} (${initial.goal}): ${result.finalMarkdown}`);
    }
  }
  const out = artifacts.resolveTranscriptOutput('no quiero el documento de Word, mejor PDF');
  assert.equal(out.documentFormat, 'pdf');
  assert.deepEqual(out.declinedDocuments, ['docx']);
});

test('asking for the transcript again releases what a Stop could not stop yet; a summary releases nothing', async () => {
  for (const [goal, expected] of [['transcribe la clase', [['clase']]], ['y tradúcelo al inglés', []]]) {
    const released = [];
    const { delivery } = pendingDeliveryFake();
    delivery.releasePendingStops = async (args) => { released.push(args.fileIds); return 1; };
    await runMediaBranch(followupContext({ goal, delivery, plain: /^transcribe/.test(goal), waitForMediaBatch: async () => { throw new Error('no wait'); } }));
    assert.deepEqual(JSON.parse(JSON.stringify(released)), expected, goal);
  }
});

// ── eighth review: the composer's reach after a Stop ─────────────────────────

test('a reply that asks for «retómala» names the stopped recordings for the composer', async () => {
  const { CANCELLED_NOTE } = require('../src/services/media-transcription-queue');
  const stopped = (id, name) => ({ id, originalName: name, processingStage: 'failed', extractedText: null, processingError: CANCELLED_NOTE });
  // An answer about the finished one.
  const rows = [readyRow('v0', 'Clase 1.mp4'), stopped('v2', 'Clase 2.mp4')];
  const answer = await runMediaBranch({ mediaBatchRows: rows, displayGoal: '¿de qué trata la clase 1?', goal: '¿de qué trata la clase 1?',
    mediaBatch: { ...batch, waitForMediaBatch: async () => ({ rows, total: 2, ready: 1, failed: 1, pending: 0, partial: 0 }) },
    prisma: {}, user: { id: 'owner' }, taskId: 'task', chatId: 'chat', fileMetadata: [], backfillUserMessageFilesForTranscription: async () => {}, emit() {},
    controller: new AbortController(), runtimeBudgetMs: 13 * 60 * 60_000, startedAt: Date.now(), Buffer,
    saveArtifact: (artifact) => ({ ...artifact, id: 'art' }), artifacts: [], persistence: { persistGeneratedArtifact: async () => {} },
    plainTranscriptionRequest: false, openai: {}, task: {}, documentPolicy: {},
    require: mediaRuntime(async () => 'La clase trata de la fotosíntesis.'),
    ...mediaBranchHelpers(), throwIfAborted: (signal) => signal.throwIfAborted(), finishDeterministicTask: async (value) => value,
  });
  assert.match(answer.finalMarkdown, /escribe «retómala»/);
  assert.deepEqual(JSON.parse(JSON.stringify(answer.metadata.stoppedFileIds)), ['v2']);
  // A hand-off that leaves one stopped.
  const pendingRows = [{ id: 'p1', originalName: 'Clase 3.mp4', processingStage: 'extracting', extractedText: null, size: 4e9 }, stopped('v2', 'Clase 2.mp4')];
  const { adapter } = capturingDelivery();
  const handOff = await handOffTurn({ goal: 'transcribe la clase 3', delivery: adapter, rows: pendingRows, plainTranscriptionRequest: true });
  assert.match(handOff.finalMarkdown, /escribe «retómala»/);
  assert.deepEqual(JSON.parse(JSON.stringify(handOff.metadata.stoppedFileIds)), ['v2']);
});

test('a question dictated without «?» next to a language is answered, never taken as the fact alone', async () => {
  for (const goal of ['qué dice el profesor cuando habla en inglés y en español', 'qué dice el profesor cuando habla en inglés',
    'qué explica el profe cuando habla en quechua y español']) {
    const { amends } = await followUp(goal);
    assert.ok(amends.some(amendment => amendment.wantsAnalysis === true), goal);
  }
  // A conjunction is no question.
  assert.equal(batch.asksForDeliverable('cuando habla en inglés, transcríbelo literal'), false);
  assert.equal(batch.asksForDeliverable('como dice el profesor, transcríbelo literal'), false);
});
