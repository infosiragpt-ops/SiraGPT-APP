'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ledger = require('../src/services/codex/progress-ledger');
const companyProfile = require('../src/services/codex/company-operating-profile');

test('proactive prompt round-trips structured department and acceptance metadata', () => {
  const prompt = ledger.formatProactivePrompt({
    department: { id: 'product-engineering', name: 'Producto' },
    title: 'Corrige la vista previa',
    goal: 'Evita una página en blanco.',
    acceptanceCriteria: ['#root contiene datos', 'No hay errores 404'],
    objectiveIds: ['okr-preview'],
    qaCycle: true,
    swarm: [{ agent: 'qa_reviewer', task: 'Revisa el diff acumulado' }],
  });
  assert.deepEqual(ledger.taskMetaFromPrompt(prompt), {
    department: 'Producto',
    departmentId: 'product-engineering',
    title: 'Corrige la vista previa',
    acceptanceCriteria: ['#root contiene datos', 'No hay errores 404'],
    objectiveIds: ['okr-preview'],
    qaCycle: true,
    swarm: [{ agent: 'qa_reviewer', task: 'Revisa el diff acumulado' }],
  });
});

test('proactive prompt preserves a mission id when the cycle is mission-driven', () => {
  const prompt = ledger.formatProactivePrompt({
    department: { id: 'ceo-office', name: 'CEO Office' },
    title: 'Define la misión verificable',
    goal: 'Alinea el trabajo autónomo con el propósito de la empresa.',
    acceptanceCriteria: ['La misión queda documentada'],
    objectiveIds: ['okr-company-purpose'],
    missionId: 'company-purpose',
  });

  assert.equal(ledger.taskMetaFromPrompt(prompt).missionId, 'company-purpose');
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

test('concurrent brief mutations preserve both company profile and ledger', async () => {
  const state = {
    project: {
      id: 'p-concurrent',
      userId: 'u-concurrent',
      name: 'SiraGPT',
      brief: { goal: 'Operar la empresa' },
    },
  };
  const prisma = {
    codexProject: {
      findUnique: async () => structuredClone(state.project),
      findFirst: async () => structuredClone(state.project),
      update: async ({ data }) => {
        await new Promise((resolve) => setImmediate(resolve));
        state.project = { ...state.project, ...structuredClone(data) };
        return structuredClone(state.project);
      },
    },
  };
  await Promise.all([
    companyProfile.writeCompanyProfile({
      prisma,
      project: state.project,
      patch: { mission: 'Construir software empresarial autónomo.' },
    }),
    ledger.appendLedgerEntry({
      prisma,
      project: state.project,
      entry: {
        runId: 'run-concurrent',
        department: 'CEO Office',
        outcome: 'passed',
        learnings: ['El objetivo quedó verificado.'],
      },
    }),
  ]);
  assert.equal(state.project.brief.goal, 'Operar la empresa');
  assert.equal(state.project.brief.companyProfile.mission, 'Construir software empresarial autónomo.');
  assert.equal(state.project.brief.ledger[0].runId, 'run-concurrent');
});
