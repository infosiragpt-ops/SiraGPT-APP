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

test('appendLedgerEntry enforces the FIFO cap: oldest entries drop, newest survive', async () => {
  const seeded = Array.from({ length: ledger.MAX_LEDGER_ENTRIES }, (_, index) => ({
    runId: `run-${index}`,
    department: 'Producto',
    outcome: 'passed',
    title: `Tarea ${index}`,
    ts: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
  }));
  const state = { project: { id: 'p-cap', brief: { goal: 'Persistir la meta', ledger: seeded } } };
  const prisma = {
    codexProject: {
      findUnique: async () => state.project,
      update: async ({ data }) => {
        state.project = { ...state.project, ...data };
        return state.project;
      },
    },
  };

  const appended = await ledger.appendLedgerEntry({
    prisma,
    project: state.project,
    entry: { runId: 'run-newest', department: 'Producto', outcome: 'failed', title: 'La más nueva' },
  });

  const stored = state.project.brief.ledger;
  assert.equal(stored.length, ledger.MAX_LEDGER_ENTRIES, 'cap holds after overflow');
  assert.equal(stored.at(-1).runId, 'run-newest', 'newest entry survives at the tail');
  assert.equal(appended.runId, 'run-newest');
  assert.equal(stored.some((entry) => entry.runId === 'run-0'), false, 'oldest entry dropped');
  assert.equal(stored[0].runId, 'run-1', 'FIFO order preserved for the rest');
  assert.equal(state.project.brief.goal, 'Persistir la meta', 'sibling brief fields intact');
});

test('formatProgressContext truncates to maxChars and honors maxEntries', () => {
  const entries = Array.from({ length: 40 }, (_, index) => ({
    runId: `run-${index}`,
    department: 'Producto',
    outcome: index % 2 === 0 ? 'passed' : 'failed',
    title: `Iteración ${index}: ${'detalle largo del trabajo realizado '.repeat(8)}`,
    learnings: [`Aprendizaje ${index}: ${'evidencia acumulada del ciclo '.repeat(6)}`],
    ts: new Date(Date.UTC(2026, 6, 2, 0, index)).toISOString(),
  }));
  const project = { id: 'p-fmt', brief: { ledger: entries } };

  const block = ledger.formatProgressContext(project, { maxEntries: 12, maxChars: 1200 });
  assert.ok(block.length <= 1200, 'summary never exceeds the character budget');
  assert.match(block, /LEDGER DE CORRIDAS RECIENTES:/);
  assert.doesNotMatch(block, /run=run-27\b/, 'entries older than maxEntries are excluded');
  assert.match(block, /run=run-28\b/, 'window starts at the last maxEntries entries');

  const unbounded = ledger.formatProgressContext(project, { maxEntries: 12 });
  assert.ok(unbounded.length > 1200, 'the cap is what truncates, not the data');
  assert.doesNotMatch(unbounded, /run=run-15\b/, 'maxEntries window enforced without char cap too');
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

test('CEO Office persists reviewed OKRs with measurable key results and audit revision', async () => {
  const state = {
    project: {
      id: 'p-okrs',
      userId: 'u-okrs',
      name: 'SiraGPT',
      brief: { goal: 'Operar con resultados medibles' },
    },
  };
  const prisma = {
    codexProject: {
      findFirst: async () => structuredClone(state.project),
      update: async ({ data }) => {
        state.project = { ...state.project, ...structuredClone(data) };
        return structuredClone(state.project);
      },
    },
  };

  const portfolio = await ledger.reviewObjectives({
    prisma,
    project: state.project,
    objectives: [{
      id: 'okr-activation',
      title: 'Aumentar activación empresarial',
      ownerDepartmentId: 'growth-engines',
      status: 'active',
      priority: 1,
      keyResults: [{
        id: 'kr-first-value',
        title: 'Usuarios que alcanzan el primer valor',
        metric: 'activation_rate',
        baseline: '20',
        current: '24',
        target: '40',
        unit: '%',
        status: 'on_track',
        progress: 35,
      }],
    }],
    reviewer: 'CEO Office',
    rationale: 'Prioridad validada con la línea base disponible.',
    expectedRevision: 0,
    now: new Date('2026-07-28T12:00:00.000Z'),
  });

  assert.equal(portfolio.revision, 1);
  assert.equal(portfolio.objectives[0].reviewStatus, 'approved');
  assert.equal(portfolio.objectives[0].keyResults[0].progress, 35);
  assert.equal(portfolio.latestReview.reviewer, 'CEO Office');
  assert.equal(portfolio.latestReview.changes.added, 1);
  assert.equal(state.project.brief.goal, 'Operar con resultados medibles');
  assert.equal(state.project.brief.okrPortfolio.revision, 1);
});

test('CEO Office reprioritizes stable objective ids and rejects stale revisions', async () => {
  const state = {
    project: {
      id: 'p-priority',
      userId: 'u-priority',
      name: 'SiraGPT',
      brief: {
        objectives: [
          { id: 'okr-product', title: 'Mejorar producto', priority: 1 },
          { id: 'okr-growth', title: 'Validar crecimiento', priority: 2 },
        ],
        okrPortfolio: { version: 1, revision: 3, reviews: [] },
      },
    },
  };
  const prisma = {
    codexProject: {
      findFirst: async () => structuredClone(state.project),
      update: async ({ data }) => {
        state.project = { ...state.project, ...structuredClone(data) };
        return structuredClone(state.project);
      },
    },
  };

  const portfolio = await ledger.reprioritizeObjectives({
    prisma,
    project: state.project,
    orderedIds: ['okr-growth'],
    reviewer: 'CEO Office',
    rationale: 'La evidencia comercial requiere validación primero.',
    expectedRevision: 3,
    now: new Date('2026-07-28T13:00:00.000Z'),
  });
  assert.equal(portfolio.revision, 4);
  assert.deepEqual(
    portfolio.objectives.map((objective) => [objective.id, objective.priority]),
    [['okr-growth', 1], ['okr-product', 2]],
  );
  assert.equal(portfolio.latestReview.source, 'ceo_reprioritization');
  assert.equal(portfolio.latestReview.changes.reprioritized, 2);

  await assert.rejects(
    ledger.reviewObjectives({
      prisma,
      project: state.project,
      objectives: portfolio.objectives,
      expectedRevision: 3,
    }),
    (error) => error.code === 'okr_revision_conflict' && error.status === 409,
  );
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
