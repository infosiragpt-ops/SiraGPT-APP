'use strict';

/**
 * stale-run-watchdog — proactive alerting for runs that fail or stall.
 *
 * Scans AgentTask and CodexRun rows stuck in a non-terminal status whose
 * updatedAt is older than the stall threshold. For each stale run:
 *   - alerts the team through the shared alerting channels
 *     (SLACK_ALERT_WEBHOOK_URL / PagerDuty / email) with escalating severity;
 *   - creates (or refreshes cooldown for) a Notification row so the run's
 *     owner learns their run stalled even after closing the browser.
 *
 * Design constraints:
 *   - Never throws: every failure path degrades to a warn log. The watchdog
 *     must not become another thing that needs a watchdog.
 *   - ONE alert per run and severity, persisted (AuditLog `stale_run_alerted`,
 *     resourceId `<kind>:<runId>`): restarts and later sweeps never re-alert
 *     a run already reported (prod 2026-09-26: zombie runs re-alerted
 *     `critical` on every sweep — ~25 red lines per restart). The in-memory
 *     cooldown stays as a first-level cache.
 *   - Zombies are closed: a run with no update for STALE_RUN_ABANDON_HOURS is
 *     marked terminal («abandonado») — agent task → cancelled, codex run →
 *     cancelled with `error` — and recorded once (`stale_run_abandoned`). The
 *     update is conditional on the row not having moved since the scan.
 *   - Degrades to no-op when prisma/tables are unavailable (tests, boot).
 *
 * Env:
 *   STALE_RUN_WATCHDOG_DISABLED=1        turn the whole scan off
 *   STALE_RUN_WARN_MINUTES=15            threshold for 'warn' severity
 *   STALE_RUN_CRITICAL_MINUTES=45        threshold for 'error' severity
 *   STALE_RUN_ALERT_COOLDOWN_MINUTES=30  min minutes between alerts per run
 *   STALE_RUN_ABANDON_HOURS=24           close runs silent for this long (0 = never)
 */

const DEFAULT_WARN_MS = 15 * 60 * 1000;
const DEFAULT_CRITICAL_MS = 45 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_ABANDON_HOURS = 24;
const MAX_ALERTS_PER_SCAN = 25;
const MAX_ABANDONS_PER_SCAN = 100;
const ALERTED_ACTION = 'stale_run_alerted';
const ABANDONED_ACTION = 'stale_run_abandoned';
const SEVERITY_RANK = { warn: 1, critical: 2 };

// Real AgentTask statuses, from its writers (agents/agent-task-persistence.js
// TERMINAL_STATUSES + agents/task-store.js validStatuses):
//   live      queued · running
//   terminal  completed · failed · cancelled · error
// timeout / aborted are listed defensively (legacy writers). `failed` was
// missing here, so every failed task was alerted as «estancado» forever
// (prod 2026-09-26: all 7 failed tasks).
const TERMINAL_AGENT_TASK = new Set(['completed', 'failed', 'cancelled', 'error', 'timeout', 'aborted']);
// CodexRun statuses (schema): queued · running · waiting_approval (live) —
// done · error · cancelled (terminal). queued is excluded from the scan
// because the queue handoff watchdog in routes/agent-task.js owns queued
// recovery and BullMQ's own stalled machinery owns queued re-delivery.
const TERMINAL_CODEX_RUN = new Set(['done', 'error', 'cancelled']);
const NON_TERMINAL_CODEX_RUN = new Set(['running', 'waiting_approval']);

const _alertedAt = new Map(); // `${kind}:${id}` → last alert epoch ms

function _now() { return Date.now(); }

function readPositiveInt(rawValue, fallback) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return fallback;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function thresholds(env = process.env) {
  const warnMs = readPositiveInt(env.STALE_RUN_WARN_MINUTES, DEFAULT_WARN_MS / 60000) * 60000;
  const criticalMs = Math.max(
    readPositiveInt(env.STALE_RUN_CRITICAL_MINUTES, DEFAULT_CRITICAL_MS / 60000) * 60000,
    warnMs,
  );
  return { warnMs, criticalMs };
}

function cooldownMs(env = process.env) {
  return readPositiveInt(env.STALE_RUN_ALERT_COOLDOWN_MINUTES, DEFAULT_COOLDOWN_MS / 60000) * 60000;
}

/** Hours of silence after which a non-terminal run is closed as abandoned (0 = never). */
function abandonMs(env = process.env) {
  const raw = env.STALE_RUN_ABANDON_HOURS;
  if (raw !== undefined && raw !== null && String(raw).trim() === '0') return 0;
  return readPositiveInt(raw, DEFAULT_ABANDON_HOURS) * 3600 * 1000;
}

function isDisabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env.STALE_RUN_WATCHDOG_DISABLED || '').trim().toLowerCase());
}

function severityFor(ageMs, { warnMs, criticalMs }) {
  if (ageMs >= criticalMs) return 'critical';
  if (ageMs >= warnMs) return 'warn';
  return null;
}

function redact(value, max = 160) {
  return String(value ?? '')
    .replace(/\b(?:sk|pk|gsk)[a-zA-Z0-9_-]{8,}\b/g, '[secret]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]{12,}\b/gi, 'Bearer [secret]')
    .trim()
    .slice(0, max);
}

function minutesLabel(ms) {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`;
}

async function loadAlerting() {
  try {
    // eslint-disable-next-line global-require
    return require('../services/alerting');
  } catch {
    return null;
  }
}

async function loadPrisma(injected) {
  if (injected !== undefined) return injected;
  try {
    // eslint-disable-next-line global-require
    return require('../config/database');
  } catch {
    return null;
  }
}

/**
 * Scan one table shape. `model` must expose findMany; rows need
 * { id, userId, updatedAt } (+ goal/mode for context when present).
 */
async function scanStaleRows(model, where, ageOf, thresholdsOpts, limit = 50) {
  if (!model || typeof model.findMany !== 'function') return [];
  let rows;
  try {
    rows = await model.findMany({
      where,
      select: { id: true, userId: true, status: true, updatedAt: true, createdAt: true },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
  } catch {
    return [];
  }
  const now = _now();
  const out = [];
  for (const row of rows) {
    const updated = Date.parse(row.updatedAt || row.createdAt || '');
    if (!Number.isFinite(updated)) continue;
    const ageMs = now - updated;
    const severity = severityFor(ageMs, thresholdsOpts);
    if (!severity) continue;
    out.push({ ...row, ageMs, severity });
  }
  out.sort((a, b) => b.ageMs - a.ageMs);
  return out;
}

async function notifyOwner(prisma, userId, kind, runId, ageMs, severity) {
  if (!prisma?.notification || typeof prisma.notification.findFirst !== 'function') return false;
  try {
    const recent = await prisma.notification.findFirst({
      where: {
        userId: String(userId),
        type: 'run_stalled',
        createdAt: { gte: new Date(_now() - cooldownMs()) },
      },
      select: { id: true },
    });
    if (recent) return false;
    // createNotification (services/user-notifications) persists the inbox row
    // and fans critical severity out to web-push + SMS — the owner learns
    // about the stall even with no browser open.
    // eslint-disable-next-line global-require
    const userNotifications = require('../services/user-notifications');
    const row = await userNotifications.createNotification(prisma, {
      userId: String(userId),
      type: 'run_stalled',
      title: 'Tu tarea lleva demasiado tiempo en marcha',
      message: `Detectamos que tu ${kind === 'agent_task' ? 'tarea' : 'run'} (${String(runId).slice(0, 8)}) lleva ${minutesLabel(ageMs)} sin avanzar. El equipo fue notificado y lo estamos revisando; puedes cancelarla e intentarlo de nuevo si prefieres.`,
      severity: severity === 'critical' ? 'critical' : 'warning',
      metadata: { runId: String(runId), kind, ageSeconds: Math.round(ageMs / 1000), source: 'stale-run-watchdog' },
    });
    return Boolean(row);
  } catch {
    return false;
  }
}

/** Persisted «already alerted» severities for these candidates (key → rank). */
async function loadAlertedRanks(prisma, keys) {
  const out = new Map();
  if (!keys.length || !prisma?.auditLog || typeof prisma.auditLog.findMany !== 'function') return out;
  try {
    const rows = await prisma.auditLog.findMany({
      where: { action: ALERTED_ACTION, resourceType: 'stale_run', resourceId: { in: keys } },
      select: { resourceId: true, metadata: true },
      take: keys.length * 4,
    });
    for (const row of rows) {
      const rank = SEVERITY_RANK[row.metadata && row.metadata.severity] || 1;
      out.set(row.resourceId, Math.max(out.get(row.resourceId) || 0, rank));
    }
  } catch { /* table unavailable → in-memory cooldown only */ }
  return out;
}

async function recordAudit(prisma, { action, key, candidate, extra = {} }) {
  if (!prisma?.auditLog || typeof prisma.auditLog.create !== 'function') return false;
  try {
    await prisma.auditLog.create({
      data: {
        actorType: 'system',
        actorId: null,
        actorName: 'stale-run-watchdog',
        resourceType: 'stale_run',
        resourceId: key,
        action,
        metadata: {
          kind: candidate.kind,
          runId: String(candidate.id),
          userId: candidate.userId || null,
          status: candidate.status || null,
          ageSeconds: Math.round(candidate.ageMs / 1000),
          ...extra,
        },
      },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminal status for a zombie run («abandonado»): an agent task that never
 * finished → failed; a codex plan nobody approved → cancelled; a codex run
 * stuck running → error.
 */
function abandonedStatusFor(candidate) {
  if (candidate.kind === 'agent_task') return 'failed';
  return candidate.status === 'waiting_approval' ? 'cancelled' : 'error';
}

/**
 * Close a zombie run: terminal status + reason, only if the row has not
 * moved since the scan (same live status + updatedAt), so a terminal row is
 * never rewritten. Returns the new status, or null when nothing changed.
 */
async function abandonRun(prisma, candidate) {
  const isAgentTask = candidate.kind === 'agent_task';
  const live = isAgentTask ? !TERMINAL_AGENT_TASK.has(candidate.status) : NON_TERMINAL_CODEX_RUN.has(candidate.status);
  if (!candidate.status || !live) return null;
  const hours = Math.round(candidate.ageMs / 3600000);
  const reason = `abandonado: sin actividad desde hace ${hours} h (stale-run-watchdog)`;
  const where = { id: candidate.id, status: candidate.status, updatedAt: new Date(candidate.updatedAt) };
  const now = new Date(_now());
  const status = abandonedStatusFor(candidate);
  try {
    if (isAgentTask) {
      if (typeof prisma.agentTask?.updateMany !== 'function') return null;
      const res = await prisma.agentTask.updateMany({ where, data: { status, failedAt: now } });
      return Number(res && res.count) > 0 ? status : null;
    }
    if (typeof prisma.codexRun?.updateMany !== 'function') return null;
    const res = await prisma.codexRun.updateMany({ where, data: { status, finishedAt: now, error: reason } });
    return Number(res && res.count) > 0 ? status : null;
  } catch {
    return null;
  }
}

/**
 * scanStaleRuns — one pass over both tables. Returns a summary suitable for
 * cron meta / admin health surfaces.
 */
async function scanStaleRuns(opts = {}) {
  const env = opts.env || process.env;
  const summary = {
    scanned: 0,
    alerted: 0,
    notifiedUsers: 0,
    suppressedByCooldown: 0,
    alreadyAlerted: 0,
    abandoned: 0,
    skipped: null,
  };
  if (isDisabled(env)) {
    summary.skipped = 'disabled';
    return summary;
  }

  const prisma = await loadPrisma(opts.prisma);
  if (!prisma?.agentTask && !prisma?.codexRun) {
    summary.skipped = 'no_prisma';
    return summary;
  }

  const thresholdsOpts = thresholds(env);
  const alerting = await loadAlerting();
  const candidates = [];

  if (prisma.agentTask) {
    const rows = await scanStaleRows(
      prisma.agentTask,
      // Prisma's operator is `notIn` (`nin` threw «Unknown argument» on every sweep).
      { status: { notIn: Array.from(TERMINAL_AGENT_TASK) } },
      null,
      thresholdsOpts,
    );
    candidates.push(...rows.map((r) => ({ kind: 'agent_task', ...r })));
  }
  if (prisma.codexRun) {
    const rows = await scanStaleRows(
      prisma.codexRun,
      { status: { in: Array.from(NON_TERMINAL_CODEX_RUN) } },
      null,
      thresholdsOpts,
    );
    candidates.push(...rows.map((r) => ({ kind: 'codex_run', ...r })));
  }
  summary.scanned = candidates.length;

  const cooldown = cooldownMs(env);
  const now = _now();

  // Zombies first: closed as «abandonado», recorded once, never alerted again.
  const abandonAfter = abandonMs(env);
  const live = [];
  const abandonedIds = [];
  for (const candidate of candidates) {
    if (abandonAfter > 0 && candidate.ageMs >= abandonAfter && abandonedIds.length < MAX_ABANDONS_PER_SCAN) {
      // eslint-disable-next-line no-await-in-loop
      const closedAs = await abandonRun(prisma, candidate);
      if (closedAs) {
        const key = `${candidate.kind}:${candidate.id}`;
        // eslint-disable-next-line no-await-in-loop
        await recordAudit(prisma, { action: ABANDONED_ACTION, key, candidate, extra: { reason: 'abandonado', previousStatus: candidate.status || null, newStatus: closedAs } });
        _alertedAt.delete(key);
        abandonedIds.push(key);
        continue;
      }
    }
    live.push(candidate);
  }
  summary.abandoned = abandonedIds.length;
  if (abandonedIds.length) {
    try {
      console.log(`[stale-run-watchdog] ${abandonedIds.length} run(s) sin actividad cerrados como «abandonado»: ${abandonedIds.slice(0, 10).join(', ')}${abandonedIds.length > 10 ? '…' : ''}`);
    } catch { /* never throw */ }
  }

  const window = live.slice(0, MAX_ALERTS_PER_SCAN);
  const alertedRanks = await loadAlertedRanks(prisma, window.map((c) => `${c.kind}:${c.id}`));

  for (const candidate of window) {
    const key = `${candidate.kind}:${candidate.id}`;
    const lastAlerted = _alertedAt.get(key) || 0;
    if (now - lastAlerted < cooldown) {
      summary.suppressedByCooldown += 1;
      continue;
    }
    // Persisted dedupe: one alert per run and severity, across restarts.
    const alreadyRank = alertedRanks.get(key) || 0;
    if (alreadyRank >= (SEVERITY_RANK[candidate.severity] || 1)) {
      _alertedAt.set(key, now);
      summary.alreadyAlerted += 1;
      continue;
    }

    const label = candidate.kind === 'agent_task' ? 'agent-task' : 'codex-run';
    const title = `[${label}] run estancado ${minutesLabel(candidate.ageMs)} — ${String(candidate.id).slice(0, 8)}`;
    const message = `Run ${label} ${candidate.id} lleva ${minutesLabel(candidate.ageMs)} en estado no-terminal sin actualizarse (updatedAt ${candidate.updatedAt}). Severidad ${candidate.severity}.`;

    if (alerting?.sendAlert) {
      try {
        Promise.resolve(alerting.sendAlert({
          title,
          message,
          severity: candidate.severity,
          context: {
            domain: 'stale-run-watchdog',
            kind: candidate.kind,
            runId: candidate.id,
            userId: candidate.userId || null,
            ageSeconds: Math.round(candidate.ageMs / 1000),
            severity: candidate.severity,
          },
        })).catch(() => {});
      } catch { /* never throw */ }
    }

    // The owner hears about a stalled run once (its first alert), never on
    // the escalation to critical.
    const notified = alreadyRank === 0
      ? await notifyOwner(prisma, candidate.userId, candidate.kind, candidate.id, candidate.ageMs, candidate.severity)
      : false;
    if (notified) summary.notifiedUsers += 1;

    await recordAudit(prisma, { action: ALERTED_ACTION, key, candidate, extra: { severity: candidate.severity } });
    _alertedAt.set(key, now);
    summary.alerted += 1;
  }

  if (_alertedAt.size > 512) {
    for (const [key, ts] of _alertedAt) {
      if (now - ts > cooldown * 4) _alertedAt.delete(key);
    }
  }

  return summary;
}

function _resetForTests() {
  _alertedAt.clear();
}

module.exports = {
  MAX_ALERTS_PER_SCAN,
  TERMINAL_AGENT_TASK,
  TERMINAL_CODEX_RUN,
  NON_TERMINAL_CODEX_RUN,
  abandonedStatusFor,
  ALERTED_ACTION,
  ABANDONED_ACTION,
  abandonMs,
  cooldownMs,
  scanStaleRuns,
  severityFor,
  thresholds,
  _resetForTests,
};
