'use strict';

// Rolling context compaction — the thread's memory when the context window
// runs out. Pure planning + summarisation + persistence contract, all offline.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const compactor = require('../src/services/conversation-compactor');
const contextWindow = require('../src/services/context-window');

const MINUTE = 60 * 1000;

function makeRows(pairs, { chars = 400, startAt = Date.UTC(2026, 8, 1, 10, 0, 0), files = null } = {}) {
  const rows = [];
  for (let i = 0; i < pairs; i += 1) {
    rows.push({
      id: `u${i}`,
      role: 'USER',
      content: `Pregunta ${i + 1}: ${'x'.repeat(chars)}`,
      files: files && files(i, 'USER'),
      timestamp: new Date(startAt + i * 2 * MINUTE),
    });
    rows.push({
      id: `a${i}`,
      role: 'ASSISTANT',
      content: `Respuesta ${i + 1}: ${'y'.repeat(chars)}`,
      files: null,
      timestamp: new Date(startAt + (i * 2 + 1) * MINUTE),
    });
  }
  return rows;
}

function fakePrisma(seed = {}) {
  const chat = { id: 'chat1', contextSummary: null, contextSummaryUntil: null, contextSummaryMeta: null, ...seed };
  const calls = [];
  let messages = [];
  return {
    state: chat,
    calls,
    setMessages(rows) { messages = rows; },
    chat: {
      async findUnique({ where, select }) {
        calls.push(['chat.findUnique', where, select]);
        if (where.id !== chat.id) return null;
        return { contextSummary: chat.contextSummary, contextSummaryUntil: chat.contextSummaryUntil, contextSummaryMeta: chat.contextSummaryMeta };
      },
      async update({ where, data }) {
        calls.push(['chat.update', where, data]);
        Object.assign(chat, data);
        return chat;
      },
    },
    message: {
      async findMany({ where }) {
        calls.push(['message.findMany', where]);
        const until = where.timestamp && where.timestamp.gt;
        return messages.filter((m) => !m.deletedAt && (!until || m.timestamp > until));
      },
    },
  };
}

describe('planCompaction — when to fold the older turns', () => {
  test('a short thread on a large model fits and is left alone', () => {
    const plan = compactor.planCompaction({ model: 'muse-spark-1.2', rows: makeRows(6), systemTokens: 8000, promptTokens: 200 });
    assert.equal(plan.shouldCompact, false);
    assert.equal(plan.preemptive, false);
    assert.equal(plan.reason, 'fits');
    assert.equal(plan.rowsToKeep.length, 12);
  });

  test('overflow on a small-context model folds the head and keeps a user-aligned tail', () => {
    const rows = makeRows(30, { chars: 1600 });
    for (const row of rows) if (row.role === 'USER') row.content = 'Conserva el formato.';
    const plan = compactor.planCompaction({ model: 'sira-mini', rows, systemTokens: 1500, promptTokens: 100, reservedCompletionTokens: 1024 });
    assert.equal(contextWindow.getContextLimit('sira-mini'), 8192);
    assert.equal(plan.shouldCompact, true);
    assert.equal(plan.reason, 'context-overflow');
    assert.ok(plan.rowsToCompact.length >= 4);
    assert.equal(plan.rowsToKeep[0].role, 'USER', 'the verbatim tail starts at a user turn (never splits a pair)');
    assert.equal(plan.rowsToCompact.length + plan.rowsToKeep.length, rows.length);
    // The kept tail itself must fit the trigger budget.
    const tailTokens = compactor.estimateRowsTokens(plan.rowsToKeep);
    assert.ok(tailTokens + 1500 + 100 + 1024 <= plan.triggerBudget, `tail ${tailTokens} must fit ${plan.triggerBudget}`);
  });

  test('planning terminates when a kept user turn has several assistant rows', () => {
    // Isolate the synchronous planner so a regression fails with a bounded
    // timeout instead of hanging the entire test runner's event loop.
    const output = require('node:child_process').execFileSync(process.execPath, ['-e', `
      const compactor = require(process.argv[1]);
      const rows = Array.from({ length: 30 }, (_, index) => ({
        id: 'm' + index,
        role: index >= 22 ? (index === 22 ? 'USER' : 'ASSISTANT') : (index % 2 ? 'ASSISTANT' : 'USER'),
        content: index === 0 ? 'dato '.repeat(3600)
          : index < 22 ? (index % 2 ? 'texto '.repeat(1200) : 'Respeta el formato.') : 'ok',
        files: [], timestamp: new Date(1e12 + index * 1000),
      }));
      const results = [];
      for (const nextUser of [false, true]) {
        if (nextUser) rows[27].role = 'USER';
        const plan = compactor.planCompaction({ model: 'sira-mini', rows, env: {} });
        results.push({ cut: plan.rowsToCompact.length, kept: plan.rowsToKeep.length,
          firstRole: plan.rowsToKeep[0].role, shouldCompact: plan.shouldCompact });
      }
      process.stdout.write(JSON.stringify(results));
    `, require.resolve('../src/services/conversation-compactor')], { encoding: 'utf8', timeout: 2000 });
    assert.deepEqual(JSON.parse(output), [
      { cut: 22, kept: 8, firstRole: 'USER', shouldCompact: true },
      { cut: 27, kept: 3, firstRole: 'USER', shouldCompact: true },
    ]);
  });

  test('the absolute history cap triggers even inside a 1M-token window', () => {
    const rows = makeRows(60, { chars: 8000 });
    for (const row of rows) if (row.role === 'USER') row.content = 'Continúa con el formato acordado.';
    const plan = compactor.planCompaction({ model: 'muse-spark-1.2', rows, systemTokens: 8000, promptTokens: 100 });
    assert.equal(plan.shouldCompact, true);
    assert.equal(plan.reason, 'history-cap');
    assert.ok(plan.rowsToKeep.length >= 8, 'keeps at least the minimum tail');
    assert.ok(compactor.estimateRowsTokens(plan.rowsToKeep) <= compactor.DEFAULTS.maxHistoryTokens);
  });

  test('past half the budget it is flagged pre-emptive (background) but not folded inline', () => {
    const rows = makeRows(20, { chars: 1200 }); // ~300 tokens per row → 12k tokens
    const plan = compactor.planCompaction({ model: 'deepseek-chat', rows, systemTokens: 60000, promptTokens: 100 });
    assert.equal(contextWindow.getContextLimit('deepseek-chat'), 128000);
    assert.equal(plan.shouldCompact, false);
    assert.equal(plan.preemptive, true);
    assert.equal(plan.reason, 'preemptive');
  });

  test('attachments replayed inline count toward the history', () => {
    const files = (i, role) => (role === 'USER' && i === 0
      ? [{ name: 'tesis.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extractedText: 'z'.repeat(40000) }]
      : null);
    const plain = compactor.estimateRowsTokens(makeRows(2));
    const withDoc = compactor.estimateRowsTokens(makeRows(2, { files }));
    assert.ok(withDoc - plain >= 10000, `attachment text must be counted (${withDoc - plain})`);
  });

  test('kill switch and too-few-rows guard', () => {
    const rows = makeRows(30, { chars: 1600 });
    const off = compactor.planCompaction({ model: 'sira-mini', rows, env: { SIRAGPT_CONTEXT_COMPACTION: '0' } });
    assert.equal(off.shouldCompact, false);
    assert.equal(off.reason, 'disabled');
    const few = compactor.planCompaction({ model: 'sira-mini', rows: makeRows(2, { chars: 20000 }), systemTokens: 1000 });
    assert.equal(few.shouldCompact, false);
    assert.equal(few.reason, 'too-few-rows');
  });
});

describe('transcript + summaries', () => {
  test('the transcript keeps roles, timestamps and an attachment manifest with excerpt', () => {
    const files = (i, role) => (role === 'USER' && i === 1
      ? [{ name: 'presupuesto.xlsx', mimeType: 'application/vnd.ms-excel', extractedText: 'Ingresos 2026: 1.250.000 USD; Gastos: 980.000 USD' }]
      : null);
    const transcript = compactor.buildTranscript(makeRows(2, { chars: 20, files }));
    assert.match(transcript, /\[#1 usuario 2026-09-01 10:00\]/);
    assert.match(transcript, /\[#2 asistente 2026-09-01 10:01\]/);
    assert.match(transcript, /↳ adjunto: presupuesto\.xlsx \(application\/vnd\.ms-excel, \d+ caracteres\) — extracto: "Ingresos 2026: 1\.250\.000 USD/);
    const big = compactor.buildTranscript(makeRows(1, { chars: 5, files: () => [{ name: 'libro.pdf', mimeType: 'application/pdf', extractedText: 'p'.repeat(12345) }] }));
    assert.match(big, /libro\.pdf \(application\/pdf, 12\.3k caracteres\)/);
  });

  test('very long messages are clipped so the transcript stays within budget', () => {
    const transcript = compactor.buildTranscript(makeRows(40, { chars: 30000 }));
    assert.ok(transcript.length <= compactor.DEFAULTS.transcriptMaxChars + 40 * 200, `transcript ${transcript.length} chars`);
    assert.match(transcript, /caracteres omitidos/);
  });

  test('the extractive fallback keeps every user request, the files and the last answer', () => {
    const files = (i, role) => (role === 'USER' && i === 0 ? [{ name: 'contrato.docx' }] : null);
    const summary = compactor.extractiveSummary(makeRows(3, { chars: 10, files }), { previousSummary: '## Objetivo del usuario\nResumen anterior.' });
    assert.match(summary, /Resumen anterior\./);
    assert.match(summary, /- Pregunta 1:/);
    assert.match(summary, /- Pregunta 3:/);
    assert.match(summary, /## Archivos y entregables\n- contrato\.docx/);
    assert.match(summary, /## Último estado\nRespuesta 3:/);
  });

  test('summarizeWithModel sends previous summary + transcript and rejects unusable output', async () => {
    let seen = null;
    const good = await compactor.summarizeWithModel({
      transcript: 'T',
      previousSummary: 'P',
      complete: async (messages, opts) => {
        seen = { messages, opts };
        return '## Objetivo del usuario\nQuiere un informe.\n## Pendientes\nEntregar el Excel.';
      },
    });
    assert.ok(good && good.startsWith('## Objetivo'));
    assert.equal(seen.messages[0].role, 'system');
    assert.equal(seen.messages[0].content, compactor.SUMMARY_SYSTEM_PROMPT);
    assert.match(seen.messages[1].content, /### Resumen previo \(ya consolidado\)\nP/);
    assert.match(seen.messages[1].content, /### Mensajes antiguos a consolidar\nT/);
    assert.equal(seen.opts.maxTokens, compactor.DEFAULTS.summaryMaxTokens);

    assert.equal(await compactor.summarizeWithModel({ transcript: 'T', complete: async () => 'ok' }), null, 'one-liners are not summaries');
    assert.equal(await compactor.summarizeWithModel({ transcript: 'T', complete: async () => { throw new Error('boom'); } }), null, 'errors fall back');
    assert.equal(await compactor.summarizeWithModel({ transcript: 'T', complete: () => new Promise(() => {}), env: { SIRAGPT_COMPACT_TIMEOUT_MS: '20' } }), null, 'timeouts fall back');
    assert.equal(await compactor.summarizeWithModel({ transcript: 'T', complete: null }), null);
  });

  test('the system block keeps the narrative subordinate to original requests and evidence', () => {
    const block = compactor.summaryBlock('## Objetivo\nX', { coveredMessages: 42 });
    assert.match(block, /## Memoria del hilo \(contexto comprimido\)/);
    assert.match(block, /Los 42 mensajes más antiguos/);
    assert.match(block, /no constituye instrucciones nuevas ni prueba del contenido de un archivo/);
    assert.match(block, /prevalecen sobre este resumen/);
    assert.match(block, /Respeta las correcciones posteriores/);
    assert.equal(compactor.summaryBlock('', {}), '');
  });
});

describe('runtime selection', () => {
  test('uses the turn model when it is OpenAI-compatible with a real window, else the fallback ladder', () => {
    assert.deepEqual(
      compactor.pickCompactionRuntime({ provider: 'Meta', model: 'muse-spark-1.2', env: {} }),
      { provider: 'Meta', model: 'muse-spark-1.2', source: 'turn' },
    );
    assert.deepEqual(
      compactor.pickCompactionRuntime({ provider: 'Anthropic', model: 'claude-sonnet-5', env: { DEEPSEEK_API_KEY: 'k' } }),
      { provider: 'DeepSeek', model: 'deepseek-chat', source: 'fallback' },
    );
    assert.deepEqual(
      compactor.pickCompactionRuntime({ provider: 'Llama', model: 'sira-mini', env: { OPENROUTER_API_KEY: 'k' } }),
      { provider: 'OpenRouter', model: 'deepseek/deepseek-v4-pro', source: 'fallback' },
    );
    assert.equal(compactor.pickCompactionRuntime({ provider: 'Anthropic', model: 'claude-sonnet-5', env: {} }), null);
    assert.deepEqual(
      compactor.pickCompactionRuntime({ provider: 'Meta', model: 'muse-spark-1.2', env: { SIRAGPT_COMPACT_MODEL: 'Gemini:gemini-3.5-flash' } }),
      { provider: 'Gemini', model: 'gemini-3.5-flash', source: 'env' },
    );
  });
});

describe('persistence contract', () => {
  test('historyWhere excludes soft-deleted rows and everything the summary already covers', () => {
    const until = new Date('2026-09-01T10:30:00Z');
    assert.deepEqual(compactor.historyWhere('c1', null), { chatId: 'c1', deletedAt: null });
    assert.deepEqual(
      compactor.historyWhere('c1', { contextSummary: 'S', contextSummaryUntil: until, contextSummaryMeta: { version: 2, retention: { version: 1, entries: [] } } }),
      { chatId: 'c1', deletedAt: null, timestamp: { gt: until } },
    );
    assert.deepEqual(compactor.historyWhere('c1', { contextSummary: null, contextSummaryUntil: until }), { chatId: 'c1', deletedAt: null });
  });

  test('compactChat persists a rolling summary with cumulative meta and serialises per chat', async () => {
    const prisma = fakePrisma({ contextSummary: '## Objetivo\nviejo', contextSummaryMeta: { version: 2, retention: { version: 1, entries: [] }, coveredMessages: 10, rounds: 1 } });
    const rows = makeRows(4, { chars: 10 });
    let calls = 0;
    const complete = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 15));
      return '## Objetivo del usuario\nInforme mensual.\n## Pendientes\nExcel.';
    };
    const [a, b] = await Promise.all([
      compactor.compactChat({ prisma, chatId: 'chat1', rows, previousSummary: prisma.state.contextSummary, previousMeta: prisma.state.contextSummaryMeta, complete, runtime: { provider: 'Meta', model: 'muse-spark-1.2' } }),
      compactor.compactChat({ prisma, chatId: 'chat1', rows, previousSummary: prisma.state.contextSummary, previousMeta: prisma.state.contextSummaryMeta, complete }),
    ]);
    assert.equal(calls, 1, 'the second concurrent call joins the in-flight job');
    assert.equal(a, b);
    assert.equal(a.ok, true);
    assert.equal(a.source, 'llm');
    assert.equal(a.coveredMessages, 8);
    assert.equal(a.meta.coveredMessages, 18);
    assert.equal(a.meta.rounds, 2);
    assert.equal(a.meta.model, 'muse-spark-1.2');
    assert.equal(prisma.state.contextSummary, a.summary);
    assert.equal(prisma.state.contextSummaryUntil.getTime(), rows[rows.length - 1].timestamp.getTime());
    const update = prisma.calls.find((c) => c[0] === 'chat.update');
    assert.deepEqual(Object.keys(update[2]).sort(), ['contextSummary', 'contextSummaryMeta', 'contextSummaryUntil']);
    assert.equal(compactor.__test.inFlight.size, 0);
  });

  test('compactChat falls back to the extractive summary and still persists', async () => {
    const prisma = fakePrisma();
    const result = await compactor.compactChat({ prisma, chatId: 'chat1', rows: makeRows(3, { chars: 10 }), complete: null, model: 'sira-mini' });
    assert.equal(result.ok, true);
    assert.equal(result.source, 'extractive');
    assert.match(prisma.state.contextSummary, /## Objetivo del usuario/);
    assert.equal(prisma.state.contextSummaryMeta.source, 'extractive');
  });

  test('invalidateSummaryIfCovered drops the summary only for covered timestamps', async () => {
    const until = new Date('2026-09-01T10:30:00Z');
    const prisma = fakePrisma({ contextSummary: 'S', contextSummaryUntil: until, contextSummaryMeta: { coveredMessages: 3 } });
    assert.equal(await compactor.invalidateSummaryIfCovered({ prisma, chatId: 'chat1', timestamp: new Date('2026-09-01T11:00:00Z') }), false);
    assert.equal(prisma.state.contextSummary, 'S');
    assert.equal(await compactor.invalidateSummaryIfCovered({ prisma, chatId: 'chat1', timestamp: new Date('2026-09-01T10:00:00Z') }), true);
    assert.equal(prisma.state.contextSummary, null);
    assert.equal(prisma.state.contextSummaryUntil, null);
    assert.equal(prisma.state.contextSummaryMeta, null);
  });

  test('maybeCompactInBackground refetches the live rows and folds past the pre-emptive threshold', async () => {
    const prisma = fakePrisma();
    const rows = makeRows(24, { chars: 1600 });
    for (const row of rows) if (row.role === 'USER') row.content = 'Continúa con el mismo formato.';
    prisma.setMessages(rows); // Mostly assistant output: compression can retain every instruction.
    const result = await compactor.maybeCompactInBackground({
      prisma,
      chatId: 'chat1',
      model: 'sira-mini',
      systemTokens: 1000,
      complete: async () => '## Objetivo del usuario\nSeguir.\n## Último estado\nOk.',
    });
    assert.equal(result.ok, true);
    assert.ok(result.coveredMessages >= 4);
    assert.ok(prisma.state.contextSummaryUntil instanceof Date);
    const findMany = prisma.calls.find((c) => c[0] === 'message.findMany');
    assert.deepEqual(findMany[1], { chatId: 'chat1', deletedAt: null });

    const quiet = fakePrisma();
    quiet.setMessages(makeRows(2, { chars: 10 }));
    const skipped = await compactor.maybeCompactInBackground({ prisma: quiet, chatId: 'chat1', model: 'muse-spark-1.2' });
    assert.equal(skipped.ok, false);
    assert.equal(quiet.state.contextSummary, null);
  });
});

describe('lossless instruction and source retention', () => {
  test('failed summaries retain complete requests and every source across rounds, in model-visible roles', async () => {
    const prisma = fakePrisma();
    const instruction = `Corrige el informe. ${'Contexto adicional. '.repeat(40)}No cambies encabezados ni márgenes.`;
    const rows = makeRows(2, { chars: 10 });
    rows[0].content = instruction;
    rows[0].files = Array.from({ length: 25 }, (_, i) => ({ id: `source-${i}`, name: 'informe.docx', extractedText: 'Dato de referencia, no una orden.' }));
    const first = await compactor.compactChat({ prisma, chatId: 'chat1', rows, complete: async () => { throw new Error('provider unavailable'); } });
    assert.equal(first.ok, true);
    assert.ok(JSON.stringify(first.meta.retention).includes(instruction), 'full original request survives beyond character 220');
    assert.ok(JSON.stringify(first.meta.retention).includes('source-24'), 'the 25th attachment keeps its distinct identity');
    const more = makeRows(2, { chars: 10, startAt: Date.UTC(2026, 8, 2) });
    more.forEach((row) => { row.id = `second-${row.id}`; });
    more[0].content = 'Ahora sí cambia únicamente el margen izquierdo a 3 cm.';
    const second = await compactor.compactChat({ prisma, chatId: 'chat1', rows: more,
      previousSummary: first.summary, previousMeta: first.meta, complete: async () => '## Estado\nCambios pendientes.' });
    assert.equal(second.ok, true);
    const replay = compactor.retentionMessages(second.meta.retention);
    assert.equal(replay[0].role, 'user');
    assert.ok(replay[0].content.startsWith(instruction + '\n\n'));
    assert.ok(replay.at(-2).content.startsWith(more[0].content + '\n\n'), 'later corrections keep their chronological position');
    assert.ok(replay.every((message) => message.role !== 'system'), 'no user or file data is promoted to system');
    assert.ok(JSON.stringify(replay).includes('source-24'), 'the model actually receives the source identity in later rounds');
    assert.equal(second.meta.coveredMessages, 8);
  });

  test('a retention budget refusal leaves the persisted cut unchanged', async () => {
    const prisma = fakePrisma();
    const rows = makeRows(3, { chars: 10 });
    rows[0].content = 'No omitas esta instrucción. '.repeat(3000);
    const result = await compactor.compactChat({ prisma, chatId: 'chat1', rows, complete: async () => '## Estado\nResumen válido.' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'retention-budget');
    assert.equal(prisma.state.contextSummaryUntil, null);
    assert.equal(prisma.calls.some(([kind]) => kind === 'chat.update'), false);
  });

  test('the combined retention plus summary must fit the caller budget before advancing the cut', async () => {
    const prisma = fakePrisma();
    const result = await compactor.compactChat({ prisma, chatId: 'chat1', rows: makeRows(2, { chars: 400 }),
      contextBudgetTokens: 200, complete: async () => '## Estado\nResumen breve.' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'retention-budget');
    assert.equal(prisma.state.contextSummaryUntil, null);
  });

  test('legacy summaries without verified retention replay original rows', async () => {
    const prisma = fakePrisma({ contextSummary: '## Estado\nResumen antiguo.', contextSummaryUntil: new Date(), contextSummaryMeta: { version: 1 } });
    assert.equal(await compactor.loadChatSummaryState(prisma, 'chat1'), null);
    assert.deepEqual(compactor.historyWhere('chat1', prisma.state), { chatId: 'chat1', deletedAt: null });
  });
});

test('planning refuses an unbounded literal-instruction ledger instead of proposing a destructive cut', () => {
  const rows = makeRows(30, { chars: 4000 });
  const plan = compactor.planCompaction({ model: 'sira-mini', rows });
  assert.equal(plan.shouldCompact, false);
  assert.equal(plan.reason, 'retention-budget');
  assert.equal(plan.rowsToKeep, rows);
  assert.deepEqual(plan.rowsToCompact, []);
});
