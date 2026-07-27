'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ledger = require('../src/services/codex/progress-ledger');

test('proactive prompt round-trips structured department and acceptance metadata', () => {
  const prompt = ledger.formatProactivePrompt({
    department: { id: 'product-engineering', name: 'Producto' },
    title: 'Corrige la vista previa',
    goal: 'Evita una página en blanco.',
    acceptanceCriteria: ['#root contiene datos', 'No hay errores 404'],
    objectiveIds: ['okr-preview'],
    qaCycle: true,
  });
  assert.deepEqual(ledger.taskMetaFromPrompt(prompt), {
    department: 'Producto',
    departmentId: 'product-engineering',
    title: 'Corrige la vista previa',
    acceptanceCriteria: ['#root contiene datos', 'No hay errores 404'],
    objectiveIds: ['okr-preview'],
    qaCycle: true,
  });
});

test('appendLedgerEntry preserves other brief fields and replaces the same run id', async () => {
  const state = {
    project: {
      id: 'p1',
      brief: {
        goal: 'Construir producto',
        ledger: [{ runId: 'r1', department: 'CEO', outcome: 'failed' }],
      },
    },
  };
  const prisma = {
    codexProject: {
      findUnique: async () => state.project,
      update: async ({ data }) => {
        state.project = { ...state.project, ...data };
        return state.project;
      },
    },
  };
  await ledger.appendLedgerEntry({
    prisma,
    project: state.project,
    entry: {
      runId: 'r1',
      department: 'CEO',
      outcome: 'passed',
      diffstat: { additions: 12, deletions: 3 },
      learnings: ['El gate pasó'],
    },
  });
  assert.equal(state.project.brief.goal, 'Construir producto');
  assert.equal(state.project.brief.ledger.length, 1);
  assert.equal(state.project.brief.ledger[0].outcome, 'passed');
  assert.deepEqual(state.project.brief.ledger[0].diffstat, {
    additions: 12,
    deletions: 3,
    filesChanged: 0,
  });
});

test('CEO objective merge keeps stable ids and applies the new priority', () => {
  const current = [{
    id: 'okr-growth',
    title: 'Aumentar activación',
    metric: 'activation',
    target: '40%',
    status: 'active',
    priority: 2,
  }];
  const merged = ledger.mergeObjectives(current, [{
    id: 'okr-growth',
    title: 'Aumentar activación inicial',
    metric: 'activation',
    target: '50%',
    status: 'at_risk',
    priority: 1,
  }], new Date('2026-07-26T12:00:00.000Z'));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'okr-growth');
  assert.equal(merged[0].priority, 1);
  assert.equal(merged[0].target, '50%');
  assert.equal(merged[0].updatedAt, '2026-07-26T12:00:00.000Z');
});
