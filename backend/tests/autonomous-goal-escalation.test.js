'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAutonomousGoalEscalation,
  maybeCreateAutonomousGoalRun,
} = require('../src/services/autonomous-goal-escalation');

test('detects natural long-running thesis/research requests as durable goal runs', () => {
  const decision = buildAutonomousGoalEscalation({
    prompt: 'Trabaja durante meses sin detenerse: investiga artículos científicos reales con DOI para una tesis y verifica todas las referencias APA 7.',
  });

  assert.equal(decision.shouldEscalate, true);
  assert.equal(decision.depth, 'deep');
  assert.equal(decision.agentKind, 'research');
  assert.ok(decision.score >= 4);
  assert.ok(decision.reasons.includes('long_running_language'));
  assert.ok(decision.reasons.includes('research_or_thesis_scope'));
  assert.ok(decision.reasons.includes('verification_required'));
});

test('does not steal normal coding requests from the Codex path', () => {
  const decision = buildAutonomousGoalEscalation({
    prompt: 'Arregla el bug del backend, haz commit y push a GitHub.',
    codeIntent: { isCodeTask: true, confidence: 0.9 },
  });

  assert.equal(decision.shouldEscalate, false);
  assert.equal(decision.agentKind, 'codex');
  assert.ok(decision.reasons.includes('code_task_prefers_codex'));
});

test('honors explicit /goal commands as durable work even for code-heavy goals', () => {
  const decision = buildAutonomousGoalEscalation({
    prompt: '/goal mejora el backend, ejecuta pruebas, verifica fallos y continúa hasta terminar.',
    codeIntent: { isCodeTask: true, confidence: 0.9 },
  });

  assert.equal(decision.shouldEscalate, true);
  assert.notEqual(decision.depth, 'quick');
  assert.equal(decision.agentKind, 'research-codex-support');
  assert.ok(decision.reasons.includes('explicit_goal_command'));
  assert.ok(decision.reasons.includes('code_task_prefers_codex'));
});

test('detects OpenClaw autonomous software fusion as durable codex-supported work', () => {
  const decision = buildAutonomousGoalEscalation({
    prompt: 'Quiero que mejores el sofware con OpenClaw y lo fusiones como agente autonomo potente.',
  });

  assert.equal(decision.shouldEscalate, true);
  assert.equal(decision.agentKind, 'research-codex-support');
  assert.ok(decision.reasons.includes('openclaw_autonomous_software_scope'));
  assert.ok(decision.reasons.includes('code_task_prefers_codex'));
});


test('uses chat history to detect follow-up durable research work', () => {
  const decision = buildAutonomousGoalEscalation({
    history: [
      { role: 'user', content: 'Necesito un generador de tesis que investigue artículos científicos y no invente DOI.' },
      { role: 'assistant', content: 'Haré una primera mejora.' },
    ],
    prompt: 'Aún no funciona, que siga en segundo plano hasta terminar y verifique todo.',
  });

  assert.equal(decision.shouldEscalate, true);
  assert.ok(decision.reasons.includes('research_or_thesis_scope'));
  assert.ok(decision.reasons.includes('long_running_language'));
});

test('maybeCreateAutonomousGoalRun persists, appends initial event and enqueues best-effort', async () => {
  const createdRows = [];
  const appendedEvents = [];
  const enqueuedRuns = [];
  const prisma = {
    goalRun: {
      create: async ({ data }) => {
        const row = {
          id: 'goal_auto_1',
          ...data,
          createdAt: new Date('2026-05-24T13:30:00Z'),
        };
        createdRows.push(row);
        return row;
      },
    },
  };

  const result = await maybeCreateAutonomousGoalRun({
    prisma,
    userId: 'user-1',
    chatId: 'chat-1',
    prompt: 'Investiga por semanas artículos científicos reales con DOI y verifica referencias APA 7.',
    appendEvent: async (event) => {
      appendedEvents.push(event);
      return { ok: true, seq: appendedEvents.length, eventId: `event-${appendedEvents.length}` };
    },
    enqueueGoalRun: async (payload) => {
      enqueuedRuns.push(payload);
      return { id: payload.goalRunId };
    },
  });

  assert.equal(result.created, true);
  assert.equal(result.goalRunId, 'goal_auto_1');
  assert.equal(createdRows[0].status, 'queued');
  assert.equal(createdRows[0].depth, 'deep');
  assert.equal(createdRows[0].agentKind, 'research');
  assert.equal(result.enqueueWarning, null);
  assert.equal(appendedEvents.length, 1);
  assert.equal(appendedEvents[0].goalRunId, 'goal_auto_1');
  assert.equal(appendedEvents[0].payload.message, 'auto_queued_from_chat');
  assert.deepEqual(enqueuedRuns, [{ goalRunId: 'goal_auto_1' }]);
});

test('maybeCreateAutonomousGoalRun is a no-op for ordinary chat', async () => {
  const result = await maybeCreateAutonomousGoalRun({
    prisma: { goalRun: { create: async () => { throw new Error('should not create'); } } },
    userId: 'user-1',
    chatId: 'chat-1',
    prompt: 'Explícame qué es React en dos párrafos.',
  });

  assert.equal(result.created, false);
  assert.equal(result.decision.shouldEscalate, false);
});

// Prod 2026-09-27: in a thesis chat, four one-line replies («y puedes resolver
// ejercicios más avanzado?», «entiendo», «excelente estaré pidiéndote ayuda»,
// «cuando es 2+2?») each scored 0 on their own but 4 from the history
// (research + verification words, partly from the assistant's own replies)
// and each started a background /goal research run.
const THESIS_HISTORY = [
  { role: 'user', content: 'Ayúdame con mi tesis: necesito la metodología, los resultados y las referencias en APA 7.' },
  { role: 'assistant', content: 'Claro. Verifica que tus fuentes sean reales; revisemos los resultados y las conclusiones.' },
  { role: 'user', content: 'Gracias, ahora resuelve este ejercicio de (a+b)^2.' },
  { role: 'assistant', content: 'Resultado: a² + 2ab + b². Puedo validar más ejercicios si quieres.' },
];

test('short follow-ups in a thesis chat never start an autonomous run (prod regression)', () => {
  for (const prompt of [
    'y puedes resolver ejercicios mas avanzado?',
    'entiendo',
    'excelente estare pidiéndote ayuda',
    'cuando es 2+2?',
    '¿cuántos días tiene un mes?',
    'continúa',
    'gracias, verifica el resultado por favor',
  ]) {
    const decision = buildAutonomousGoalEscalation({ prompt, history: THESIS_HISTORY });
    assert.equal(decision.shouldEscalate, false, `«${prompt}» must answer normally`);
  }
});

test("the assistant's own words never count as the user's intent", () => {
  const decision = buildAutonomousGoalEscalation({
    history: [
      { role: 'assistant', content: 'Puedo investigar artículos científicos con DOI y verificar referencias APA 7 durante semanas.' },
    ],
    prompt: 'Sigue en segundo plano hasta terminar.',
  });
  // Long-running request (3) alone is below the threshold: the research scope
  // came only from the assistant, so it must not be credited to the user.
  assert.equal(decision.reasons.includes('research_or_thesis_scope'), false);
  assert.equal(decision.shouldEscalate, false);
});

test('an explicit durable request in the current message still escalates', () => {
  const decision = buildAutonomousGoalEscalation({
    history: THESIS_HISTORY,
    prompt: 'Sigue investigando en segundo plano durante varios días y verifica todas las referencias.',
  });
  assert.equal(decision.shouldEscalate, true);
  assert.ok(decision.reasons.includes('long_running_language'));
});
