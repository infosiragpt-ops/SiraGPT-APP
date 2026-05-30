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
  });

  assert.equal(result.created, true);
  assert.equal(result.goalRunId, 'goal_auto_1');
  assert.equal(createdRows[0].status, 'queued');
  assert.equal(createdRows[0].depth, 'deep');
  assert.equal(createdRows[0].agentKind, 'research');
  // Test env has no REDIS_URL, so enqueue is allowed to warn without
  // failing the persisted goal run.
  assert.ok(result.enqueueWarning || result.ok);
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
