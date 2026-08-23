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
 *   - Idempotent + cooled down per run id, so overlapping scans or repeated
 *     invocations don't spam the channels.
 *   - Degrades to no-op when prisma/tables are unavailable (tests, boot).
 *
 * Env:
 *   STALE_RUN_WATCHDOG_DISABLED=1        turn the whole scan off
 *   STALE_RUN_WARN_MINUTES=15            threshold for 'warn' severity
 *   STALE_RUN_CRITICAL_MINUTES=45        threshold for 'error' severity
 *   STALE_RUN_ALERT_COOLDOWN_MINUTES=30  min minutes between alerts per run
 */

const DEFAULT_WARN_MS = 15 * 60 * 1000;
const DEFAULT_CRITICAL_MS = 45 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_ALERTS_PER_SCAN = 25;

const TERMINAL_AGENT_TASK = new Set(['completed', 'cancelled', 'error']);
// CodexRun terminals include done/error/cancelled; queued is excluded because
// the queue handoff watchdog in routes/agent-task.js owns queued recovery and
// BullMQ's own stalled machinery owns queued re-delivery.
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
      select: { id: true, userId: true, updatedAt: true, createdAt: true },
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
      { status: { nin: Array.from(TERMINAL_AGENT_TASK) } },
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

  for (const candidate of candidates.slice(0, MAX_ALERTS_PER_SCAN)) {
    const key = `${candidate.kind}:${candidate.id}`;
    const lastAlerted = _alertedAt.get(key) || 0;
    if (now - lastAlerted < cooldown) {
      summary.suppressedByCooldown += 1;
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

    const notified = await notifyOwner(prisma, candidate.userId, candidate.kind, candidate.id, candidate.ageMs, candidate.severity);
    if (notified) summary.notifiedUsers += 1;

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
  NON_TERMINAL_CODEX_RUN,
  cooldownMs,
  scanStaleRuns,
  severityFor,
  thresholds,
  _resetForTests,
};
