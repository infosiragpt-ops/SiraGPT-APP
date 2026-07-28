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
      missionId: 'code-excellence',
      department: 'CEO',
      outcome: 'passed',
      diffstat: { additions: 12, deletions: 3 },
      learnings: ['El gate pasó'],
    },
  });
  assert.equal(state.project.brief.goal, 'Construir producto');
  assert.equal(state.project.brief.ledger.length, 1);
  assert.equal(state.project.brief.ledger[0].outcome, 'passed');
  assert.equal(state.project.brief.ledger[0].missionId, 'code-excellence');
  assert.deepEqual(state.project.brief.ledger[0].diffstat, {
    additions: 12,
    deletions: 3,
    filesChanged: 0,
  });
  assert.equal(state.project.brief.ledger[0].title, null);
  assert.equal(state.project.brief.ledger[0].ts, state.project.brief.ledger[0].createdAt);
});

test('failed build memory stays open beyond the recent window and a later pass resolves it', () => {
  const failed = {
    runId: 'run-failed',
    department: 'Producto',
    title: 'Corrige checkout roto',
    outcome: 'failed',
    learnings: ['El contrato de pagos no acepta currency vacía.'],
    ts: '2026-07-25T10:00:00.000Z',
  };
  const unrelated = Array.from({ length: 20 }, (_, index) => ({
    runId: `run-${index}`,
    title: `Tarea distinta ${index}`,
    outcome: 'passed',
  }));
  const open = ledger.readOpenFailures([failed, ...unrelated]);

  assert.equal(open.length, 1);
  assert.equal(open[0].runId, 'run-failed');
  assert.equal(open[0].failureKey, 'corrige-checkout-roto');
  assert.equal(ledger.findOpenFailure([failed, ...unrelated], 'Corrige checkout roto').runId, 'run-failed');

  const resolved = ledger.readOpenFailures([
    failed,
    ...unrelated,
    {
      runId: 'run-fixed',
      title: 'Corrige checkout roto',
      outcome: 'passed',
    },
  ]);
  assert.deepEqual(resolved, []);
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
