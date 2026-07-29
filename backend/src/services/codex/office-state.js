'use strict';

/**
 * Office state — the single source of truth the visual office reads.
 *
 * The 3D/2D office must render REAL operating data, not decoration. Until
 * now that data lived scattered across per-concern endpoints (operations
 * snapshot, activity timeline, mission-evidence ledger) and the office
 * model derived everything from sessions + runs alone. This service
 * aggregates the seven signals a company dashboard needs in ONE
 * tenant-scoped, read-only projection:
 *
 *   pool activo · tarea (misión) · run · coste · evidencia · aprobación ·
 *   bloqueo
 *
 * Contract:
 * - Read-only: never writes, never mutates brief state.
 * - Safe projection: no prompts, no drafts, no snapshots, no credentials —
 *   the same rule project-activity follows. Free-text fields are sliced.
 * - Tenant-scoped: every query filters by projectId (ownership is enforced
 *   by the route via loadOwnedProjectRecord) and, where the table carries
 *   it, by the owner's userId.
 * - Prisma is injected so tests run offline against a fake.
 */

const MAX_TEXT = 240;
const MAX_ERROR = 300;
const MAX_ROWS = 50;
const RECENT_ERROR_WINDOW_MS = 24 * 60 * 60 * 1000;

function boundedText(value, max = MAX_TEXT) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function boundedTake(value, fallback = MAX_ROWS) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(100, n);
}

/** UTC day bucket — mirrors proactive-engine's dayKey so budgets agree. */
function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function startOfUtcDay(now = new Date()) {
  return new Date(`${dayKey(now)}T00:00:00.000Z`);
}

function round6(value) {
  return Number((Math.round((Number(value) || 0) * 1e6) / 1e6).toFixed(6));
}

function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Aggregate today's usage entries into totals + a per-pool spend map. */
function summarizeUsage(entries) {
  const totals = { costUsd: 0, tokensIn: 0, tokensOut: 0, entries: 0 };
  const byPool = new Map();
  for (const entry of entries || []) {
    const cost = Number(entry?.costAppliedUsd) || 0;
    totals.costUsd += cost;
    totals.tokensIn += Number(entry?.tokensIn) || 0;
    totals.tokensOut += Number(entry?.tokensOut) || 0;
    totals.entries += 1;
    const poolId = entry?.departmentPoolId || null;
    if (poolId) byPool.set(poolId, (byPool.get(poolId) || 0) + cost);
  }
  totals.costUsd = round6(totals.costUsd);
  return { totals, byPool };
}

/**
 * Normalise every "needs a human / cannot advance" signal into one list.
 * A runtime error is a blocker here, never progress — the office paces the
 * agent instead of celebrating it.
 */
function deriveBlockers({ missions, runs, approvals, inboxItems, actions, now = new Date() }) {
  const blockers = [];
  for (const mission of missions || []) {
    if (mission.status !== 'blocked') continue;
    blockers.push({
      kind: 'mission_blocked',
      id: mission.id,
      department: mission.department || null,
      title: boundedText(mission.title),
      detail: boundedText(mission.objective || mission.summary, MAX_ERROR),
      since: toIso(mission.updatedAt || mission.createdAt),
    });
  }
  const cutoff = now.getTime() - RECENT_ERROR_WINDOW_MS;
  for (const run of runs || []) {
    if (run.status === 'waiting_approval') {
      blockers.push({
        kind: 'run_waiting_approval',
        id: run.id,
        department: run.departmentPoolId || null,
        title: `Run ${run.mode || 'build'} espera aprobación`,
        detail: '',
        since: toIso(run.updatedAt || run.createdAt),
      });
      continue;
    }
    if (run.status === 'error') {
      const at = new Date(run.finishedAt || run.updatedAt || run.createdAt || now).getTime();
      if (Number.isFinite(at) && at >= cutoff) {
        blockers.push({
          kind: 'run_error',
          id: run.id,
          department: run.departmentPoolId || null,
          title: `Run ${run.mode || 'build'} falló`,
          detail: boundedText(run.error, MAX_ERROR),
          since: toIso(run.finishedAt || run.updatedAt || run.createdAt),
        });
      }
    }
  }
  for (const approval of approvals || []) {
    blockers.push({
      kind: 'approval_pending',
      id: approval.id,
      department: null,
      title: `Aprobación CEO pendiente: ${boundedText(approval.resourceType, 60)}`,
      detail: boundedText(approval.resourceId, 120),
      since: toIso(approval.createdAt),
    });
  }
  for (const item of inboxItems || []) {
    // Subject only — inbox bodies and drafts never leave the triage surface.
    blockers.push({
      kind: 'inbox_attention',
      id: item.id,
      department: null,
      title: `Correo ${item.urgency === 'critical' ? 'crítico' : 'urgente'} sin resolver`,
      detail: boundedText(item.subject, 140),
      since: toIso(item.receivedAt || item.createdAt),
    });
  }
  for (const action of actions || []) {
    blockers.push({
      kind: 'external_action_review',
      id: action.id,
      department: null,
      title: `Acción externa en revisión: ${boundedText(action.kind || action.type || 'acción', 60)}`,
      detail: boundedText(action.summary || action.title, 140),
      since: toIso(action.createdAt),
    });
  }
  return blockers;
}

/** Minimal, defensive read of the proactive brief state (never throws). */
function readProactiveSummary(project, now = new Date()) {
  const p = project?.brief?.proactive;
  if (!p || typeof p !== 'object') {
    return { enabled: false, runsToday: 0, lastCycleAt: null, lastError: null };
  }
  const today = dayKey(now);
  return {
    enabled: p.enabled === true,
    runsToday: p.dayKey === today ? Math.max(0, Number(p.runsToday) || 0) : 0,
    lastCycleAt: toIso(p.lastCycleAt),
    lastError: boundedText(p.lastError, MAX_ERROR) || null,
  };
}

const ACTIVE_RUN_STATUSES = ['queued', 'running', 'waiting_approval'];

async function getOfficeState({ prisma, project, now = new Date(), take } = {}) {
  if (!prisma || !project?.id) {
    const error = new Error('codex_office_state_invalid_input');
    error.code = 'codex_office_state_invalid_input';
    error.status = 400;
    throw error;
  }
  const limit = boundedTake(take);
  const projectId = project.id;
  const userId = project.userId;
  const since = startOfUtcDay(now);
  const errorCutoff = new Date(now.getTime() - RECENT_ERROR_WINDOW_MS);

  const [
    pools,
    lease,
    activeRuns,
    errorRuns,
    missions,
    missionCounts,
    artifactCounts,
    approvals,
    usageEntries,
    pendingInboxCount,
    urgentInbox,
    pendingActions,
    leadCount,
  ] = await Promise.all([
    prisma.codexDepartmentPool.findMany({ where: { projectId } }),
    prisma.codexProactiveLease.findUnique
      ? prisma.codexProactiveLease.findUnique({ where: { projectId } })
      : Promise.resolve(null),
    prisma.codexRun.findMany({
      where: { projectId, status: { in: ACTIVE_RUN_STATUSES } },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    }),
    prisma.codexRun.findMany({
      where: { projectId, status: 'error', updatedAt: { gte: errorCutoff } },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    }),
    prisma.codexMission.findMany({
      where: { projectId, status: { in: ['in_progress', 'blocked'] } },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    }),
    prisma.codexMission.groupBy
      ? prisma.codexMission.groupBy({
        by: ['status'],
        where: { projectId },
        _count: { _all: true },
      })
      : Promise.resolve([]),
    prisma.codexMissionArtifact.count({ where: { projectId } }),
    prisma.codexCeoApproval.findMany({
      where: { projectId, userId, decision: 'pending' },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.codexUsageEntry.findMany({
      where: { projectId, createdAt: { gte: since } },
      select: { departmentPoolId: true, costAppliedUsd: true, tokensIn: true, tokensOut: true },
    }),
    prisma.codexCompanyInboxItem.count({
      where: { projectId, userId, status: { in: ['pending_review', 'drafted', 'error'] } },
    }),
    prisma.codexCompanyInboxItem.findMany({
      where: {
        projectId,
        userId,
        status: { in: ['pending_review', 'error'] },
        urgency: { in: ['high', 'critical'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    prisma.codexExternalAction.findMany({
      where: { projectId, userId, status: 'pending_review' },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.codexCompanyLead.count({ where: { projectId, userId } }),
  ]);

  const usage = summarizeUsage(usageEntries);
  const runsByPool = new Map();
  for (const run of activeRuns) {
    if (!run.departmentPoolId) continue;
    runsByPool.set(run.departmentPoolId, (runsByPool.get(run.departmentPoolId) || 0) + 1);
  }

  const missionStatusCounts = { in_progress: 0, blocked: 0, completed: 0 };
  for (const row of missionCounts || []) {
    const key = row?.status;
    if (key && key in missionStatusCounts) {
      missionStatusCounts[key] = Number(row?._count?._all) || 0;
    }
  }

  const blockers = deriveBlockers({
    missions,
    runs: [...activeRuns, ...errorRuns],
    approvals,
    inboxItems: urgentInbox,
    actions: pendingActions,
    now,
  });

  return {
    generatedAt: now.toISOString(),
    projectId,
    proactive: readProactiveSummary(project, now),
    lease: lease
      ? {
        active: new Date(lease.expiresAt).getTime() > now.getTime(),
        expiresAt: toIso(lease.expiresAt),
      }
      : null,
    pools: pools.map((pool) => ({
      id: pool.id,
      departmentId: pool.departmentId,
      size: Number(pool.size) || 0,
      enabled: pool.enabled !== false,
      dailyBudgetUsd: pool.dailyBudgetUsd == null ? null : Number(pool.dailyBudgetUsd),
      spentTodayUsd: round6(usage.byPool.get(pool.id) || 0),
      activeRuns: runsByPool.get(pool.id) || 0,
    })),
    runs: {
      active: activeRuns.map((run) => ({
        id: run.id,
        mode: run.mode || null,
        status: run.status,
        departmentPoolId: run.departmentPoolId || null,
        swarmTaskId: run.swarmTaskId || null,
        createdAt: toIso(run.createdAt),
        startedAt: toIso(run.startedAt),
        updatedAt: toIso(run.updatedAt),
      })),
      recentErrors: errorRuns.map((run) => ({
        id: run.id,
        mode: run.mode || null,
        departmentPoolId: run.departmentPoolId || null,
        error: boundedText(run.error, MAX_ERROR) || null,
        finishedAt: toIso(run.finishedAt || run.updatedAt),
      })),
    },
    missions: {
      counts: missionStatusCounts,
      open: missions.map((mission) => ({
        id: mission.id,
        missionKey: mission.missionKey,
        title: boundedText(mission.title),
        department: mission.department || null,
        status: mission.status,
        updatedAt: toIso(mission.updatedAt),
      })),
    },
    evidence: { artifacts: artifactCounts || 0 },
    approvals: {
      pending: approvals.map((approval) => ({
        id: approval.id,
        resourceType: approval.resourceType,
        resourceId: boundedText(approval.resourceId, 120),
        missionId: approval.missionId || null,
        reportId: approval.reportId || null,
        createdAt: toIso(approval.createdAt),
      })),
      count: approvals.length,
    },
    operations: {
      pendingInbox: pendingInboxCount || 0,
      pendingActions: pendingActions.length,
      leads: leadCount || 0,
    },
    usageToday: usage.totals,
    blockers,
  };
}

module.exports = {
  getOfficeState,
  deriveBlockers,
  summarizeUsage,
  readProactiveSummary,
  startOfUtcDay,
  dayKey,
};
