'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const officeState = require('../src/services/codex/office-state');

const NOW = new Date('2026-07-28T15:00:00.000Z');
const TODAY_START = new Date('2026-07-28T00:00:00.000Z');

function fakePrisma(overrides = {}) {
  const state = {
    pools: [],
    lease: null,
    runs: [],
    missions: [],
    artifacts: 0,
    approvals: [],
    usage: [],
    inbox: [],
    actions: [],
    leads: 0,
    ...overrides,
  };
  const matchesStatus = (row, where) => {
    if (!where?.status) return true;
    if (typeof where.status === 'string') return row.status === where.status;
    if (Array.isArray(where.status.in)) return where.status.in.includes(row.status);
    return true;
  };
  return {
    state,
    codexDepartmentPool: {
      findMany: async () => structuredClone(state.pools),
    },
    codexProactiveLease: {
      findUnique: async () => (state.lease ? structuredClone(state.lease) : null),
    },
    codexRun: {
      findMany: async ({ where, take }) => {
        let rows = state.runs.filter((row) => matchesStatus(row, where));
        if (where?.updatedAt?.gte) {
          rows = rows.filter((row) => new Date(row.updatedAt) >= where.updatedAt.gte);
        }
        return structuredClone(rows.slice(0, take || rows.length));
      },
    },
    codexMission: {
      findMany: async ({ where, take }) => structuredClone(
        state.missions.filter((row) => matchesStatus(row, where)).slice(0, take || undefined),
      ),
      groupBy: async () => {
        const counts = new Map();
        for (const mission of state.missions) {
          counts.set(mission.status, (counts.get(mission.status) || 0) + 1);
        }
        return [...counts.entries()].map(([status, n]) => ({ status, _count: { _all: n } }));
      },
    },
    codexMissionArtifact: {
      count: async () => state.artifacts,
    },
    codexCeoApproval: {
      findMany: async ({ where, take }) => structuredClone(
        state.approvals
          .filter((row) => row.decision === where.decision)
          .slice(0, take || undefined),
      ),
    },
    codexUsageEntry: {
      findMany: async ({ where }) => structuredClone(
        state.usage.filter((row) => new Date(row.createdAt) >= where.createdAt.gte),
      ),
    },
    codexCompanyInboxItem: {
      count: async () => state.inbox.filter((row) =>
        ['pending_review', 'drafted', 'error'].includes(row.status)).length,
      findMany: async ({ where, take }) => structuredClone(
        state.inbox
          .filter((row) => matchesStatus(row, where))
          .filter((row) => !where?.urgency || where.urgency.in.includes(row.urgency))
          .slice(0, take || undefined),
      ),
    },
    codexExternalAction: {
      findMany: async ({ where, take }) => structuredClone(
        state.actions.filter((row) => matchesStatus(row, where)).slice(0, take || undefined),
      ),
    },
    codexCompanyLead: {
      count: async () => state.leads,
    },
  };
}

const PROJECT = { id: 'proj1', userId: 'user1', brief: null };

test('empty project produces a zeroed, well-formed state', async () => {
  const prisma = fakePrisma();
  const state = await officeState.getOfficeState({ prisma, project: PROJECT, now: NOW });
  assert.equal(state.projectId, 'proj1');
  assert.equal(state.generatedAt, NOW.toISOString());
  assert.deepEqual(state.pools, []);
  assert.equal(state.lease, null);
  assert.deepEqual(state.runs.active, []);
  assert.deepEqual(state.missions.counts, { in_progress: 0, blocked: 0, completed: 0 });
  assert.equal(state.evidence.artifacts, 0);
  assert.equal(state.approvals.count, 0);
  assert.deepEqual(state.usageToday, { costUsd: 0, tokensIn: 0, tokensOut: 0, entries: 0 });
  assert.deepEqual(state.blockers, []);
  assert.equal(state.proactive.enabled, false);
});

test('pools carry today spend and active run counts', async () => {
  const prisma = fakePrisma({
    pools: [
      { id: 'poolA', departmentId: 'engineering', size: 3, enabled: true, dailyBudgetUsd: 5 },
      { id: 'poolB', departmentId: 'marketing', size: 1, enabled: false, dailyBudgetUsd: null },
    ],
    runs: [
      { id: 'r1', mode: 'build', status: 'running', departmentPoolId: 'poolA', createdAt: NOW, updatedAt: NOW },
      { id: 'r2', mode: 'plan', status: 'queued', departmentPoolId: 'poolA', createdAt: NOW, updatedAt: NOW },
      { id: 'r3', mode: 'build', status: 'done', departmentPoolId: 'poolA', createdAt: NOW, updatedAt: NOW },
    ],
    usage: [
      { departmentPoolId: 'poolA', costAppliedUsd: 0.5, tokensIn: 100, tokensOut: 40, createdAt: NOW },
      { departmentPoolId: 'poolA', costAppliedUsd: 0.25, tokensIn: 50, tokensOut: 20, createdAt: NOW },
      // Yesterday — must not count toward today's budget.
      { departmentPoolId: 'poolA', costAppliedUsd: 9.99, tokensIn: 1, tokensOut: 1, createdAt: new Date('2026-07-27T23:59:00.000Z') },
    ],
  });
  const state = await officeState.getOfficeState({ prisma, project: PROJECT, now: NOW });
  const poolA = state.pools.find((p) => p.id === 'poolA');
  assert.equal(poolA.spentTodayUsd, 0.75);
  assert.equal(poolA.activeRuns, 2);
  assert.equal(poolA.dailyBudgetUsd, 5);
  const poolB = state.pools.find((p) => p.id === 'poolB');
  assert.equal(poolB.enabled, false);
  assert.equal(poolB.spentTodayUsd, 0);
  assert.equal(state.usageToday.costUsd, 0.75);
  assert.equal(state.usageToday.entries, 2);
});

test('blockers unify blocked missions, approval waits, run errors and urgent inbox', async () => {
  const prisma = fakePrisma({
    missions: [
      { id: 'm1', missionKey: 'k1', title: 'Landing nueva', department: 'engineering', status: 'blocked', objective: 'Deploy bloqueado por credenciales', updatedAt: NOW, createdAt: NOW },
      { id: 'm2', missionKey: 'k2', title: 'SEO', department: 'marketing', status: 'in_progress', updatedAt: NOW, createdAt: NOW },
    ],
    runs: [
      { id: 'r1', mode: 'build', status: 'waiting_approval', departmentPoolId: 'poolA', createdAt: NOW, updatedAt: NOW },
      { id: 'r2', mode: 'build', status: 'error', error: 'TypeError: x is not a function', finishedAt: NOW, updatedAt: NOW, createdAt: NOW },
      // Old error outside the 24h window — not a current blocker.
      { id: 'r3', mode: 'build', status: 'error', error: 'old', finishedAt: new Date('2026-07-20T00:00:00.000Z'), updatedAt: new Date('2026-07-20T00:00:00.000Z'), createdAt: new Date('2026-07-20T00:00:00.000Z') },
    ],
    approvals: [
      { id: 'a1', decision: 'pending', resourceType: 'mission', resourceId: 'm1', createdAt: NOW },
    ],
    inbox: [
      { id: 'i1', status: 'pending_review', urgency: 'critical', subject: 'Factura vencida', createdAt: NOW },
      { id: 'i2', status: 'sent', urgency: 'critical', subject: 'ya resuelto', createdAt: NOW },
    ],
    actions: [
      { id: 'x1', status: 'pending_review', kind: 'email_send', summary: 'Enviar propuesta a ACME', createdAt: NOW },
    ],
  });
  const state = await officeState.getOfficeState({ prisma, project: PROJECT, now: NOW });
  const kinds = state.blockers.map((b) => b.kind).sort();
  assert.deepEqual(kinds, [
    'approval_pending',
    'external_action_review',
    'inbox_attention',
    'mission_blocked',
    'run_error',
    'run_waiting_approval',
  ]);
  const runError = state.blockers.find((b) => b.kind === 'run_error');
  assert.equal(runError.id, 'r2');
  assert.match(runError.detail, /TypeError/);
  assert.ok(!state.blockers.some((b) => b.id === 'r3'), 'stale errors are not blockers');
  assert.equal(state.missions.counts.blocked, 1);
  assert.equal(state.missions.counts.in_progress, 1);
});

test('projection is safe: no prompts, drafts or oversized error text', async () => {
  const prisma = fakePrisma({
    runs: [
      {
        id: 'r1',
        mode: 'build',
        status: 'error',
        prompt: 'SECRET user instructions',
        error: 'x'.repeat(5_000),
        finishedAt: NOW,
        updatedAt: NOW,
        createdAt: NOW,
      },
    ],
    inbox: [
      {
        id: 'i1',
        status: 'pending_review',
        urgency: 'high',
        subject: 'Consulta',
        draftBody: 'SECRET draft body',
        snippet: 'SECRET snippet',
        createdAt: NOW,
      },
    ],
  });
  const state = await officeState.getOfficeState({ prisma, project: PROJECT, now: NOW });
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes('SECRET'), 'no prompt/draft/snippet text may leak');
  const runError = state.runs.recentErrors.find((r) => r.id === 'r1');
  assert.ok(runError.error.length <= 300);
});

test('proactive summary resets stale day counters and lease reports activity', async () => {
  const prisma = fakePrisma({
    lease: { projectId: 'proj1', expiresAt: new Date(NOW.getTime() + 60_000) },
  });
  const project = {
    ...PROJECT,
    brief: {
      proactive: {
        enabled: true,
        dayKey: '2026-07-27',
        runsToday: 7,
        lastCycleAt: '2026-07-27T22:00:00.000Z',
        lastError: null,
      },
    },
  };
  const state = await officeState.getOfficeState({ prisma, project, now: NOW });
  assert.equal(state.proactive.enabled, true);
  assert.equal(state.proactive.runsToday, 0, 'yesterday\'s counter must not read as today');
  assert.equal(state.lease.active, true);
});

test('invalid input fails closed with a typed error', async () => {
  await assert.rejects(
    () => officeState.getOfficeState({ prisma: null, project: PROJECT }),
    (err) => err.code === 'codex_office_state_invalid_input' && err.status === 400,
  );
});
