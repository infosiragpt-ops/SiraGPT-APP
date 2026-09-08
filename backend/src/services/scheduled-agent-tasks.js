'use strict';

/**
 * scheduled-agent-tasks — per-user agent task scheduler core (OpenClaw port #3).
 *
 * Native rewrite of the scheduling decisions in OpenClaw's cron subsystem
 * (MIT, github.com/openclaw/openclaw `src/cron`), per
 * docs/code/openclaw-port-charter.md. Architecture derived from OpenClaw;
 * no code copied — the contract is re-expressed on the repo's own utilities.
 *
 * Decisions preserved from the reference implementation:
 *  - **Optimistic claim lock.** Claiming a due task stamps `claimedAt`; a
 *    task claimed less than CLAIM_STALE_MS (2 min) ago is never re-delivered,
 *    so two workers polling the same store cannot double-run one task. If a
 *    worker crashes mid-run its claim goes stale and the task is re-delivered
 *    on a later poll with its ORIGINAL nextRunAt anchor intact.
 *  - **Catch-up runs once.** When the process was down and a task missed N
 *    scheduled fires, the task is delivered exactly ONCE (never N times) and
 *    `completeRun` re-anchors `nextRunAt` strictly into the future. Missed
 *    executions are coalesced, not replayed.
 *  - **Deterministic jitter.** `jitterMs(taskId)` hashes the id into
 *    0..JITTER_MAX_MS (30 s) so a fleet restart spreads task starts instead
 *    of stampeding every task at the same instant. Same id → same delay.
 *
 * Cron expressions are validated and expanded with `utils/cron-next-runs`
 * (classic 5-field crontab). Malformed AND unsatisfiable expressions (e.g.
 * `* * 31 2 *`, February 31st) yield no upcoming runs there and are rejected
 * at task creation. `tz` is an optional IANA timezone: next runs are computed
 * against that timezone's wall clock via an offset shift (minute resolution;
 * fires inside a DST transition minute may shift by the offset delta).
 *
 * The store is injectable — `createMemoryStore()` covers tests and
 * single-process use. A store backed by a `ScheduledAgentTask` Prisma model
 * must implement the same contract, with `claimTask` as a conditional
 * UPDATE (`updateMany` guarded on `claimedAt` null-or-stale, count === 1)
 * so the optimistic lock holds across processes.
 */

const crypto = require('node:crypto');
const { nextRunsForSchedule } = require('../utils/cron-next-runs');

const CLAIM_STALE_MS = 2 * 60 * 1000;
const JITTER_MAX_MS = 30 * 1000;
const DEFAULT_CLAIM_LIMIT = 10;
const MAX_CLAIM_LIMIT = 100;
const MISSED_SCAN_CAP = 500;
const CATCH_UP_POLICY = 'run_once_reanchor_future';

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** True when `expr` parses AND has at least one future fire. */
function isValidCronExpr(expr) {
  return nextRunsForSchedule(expr, 1).length === 1;
}

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    // Throws RangeError for unknown IANA names.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Milliseconds between `tz`'s wall clock and UTC at `date` (positive east
 * of Greenwich), derived from Intl so DST is honored.
 */
function tzWallOffsetMs(tz, date) {
  const parts = {};
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  for (const part of formatted) parts[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24, // Intl emits "24" for midnight in some engines
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

/**
 * Shift to add to a real instant so the HOST-local fields of the shifted
 * Date equal the `tz` wall-clock fields of the original instant. This lets
 * cron-next-runs (which evaluates host-local time) compute fires for `tz`.
 */
function timezoneShiftMs(tz, date) {
  return tzWallOffsetMs(tz, date) + date.getTimezoneOffset() * 60_000;
}

/**
 * Next fire of `cronExpr` strictly after `from`, as a Date (null when the
 * expression never fires). Honors the optional IANA `tz`.
 */
function computeNextRunAt(cronExpr, { tz = null, from = new Date() } = {}) {
  const fromDate = toDate(from) || new Date();
  if (!tz) {
    const [iso] = nextRunsForSchedule(cronExpr, 1, fromDate);
    return iso ? new Date(iso) : null;
  }
  const shiftAtFrom = timezoneShiftMs(tz, fromDate);
  const [iso] = nextRunsForSchedule(cronExpr, 1, new Date(fromDate.getTime() + shiftAtFrom));
  if (!iso) return null;
  const shiftedNext = new Date(iso);
  // Map the shifted fire back to a real instant; one fixed-point refinement
  // keeps the result correct when a DST boundary sits between from and next.
  const guess = new Date(shiftedNext.getTime() - shiftAtFrom);
  return new Date(shiftedNext.getTime() - timezoneShiftMs(tz, guess));
}

/**
 * How many scheduled fires of the task fall in [nextRunAt .. until]. 1 means
 * "due exactly once, on time"; anything above 1 means fires were missed while
 * no worker was polling. Scan is capped at MISSED_SCAN_CAP.
 */
function countDueRuns(task, until) {
  const anchor = toDate(task?.nextRunAt);
  const untilDate = toDate(until);
  if (!anchor || !untilDate || anchor.getTime() > untilDate.getTime()) return 0;
  const shift = task.tz ? timezoneShiftMs(task.tz, untilDate) : 0;
  const shiftedUntil = untilDate.getTime() + shift;
  let cursor = new Date(anchor.getTime() + shift);
  let count = 1; // the anchor itself is a due fire
  while (count < MISSED_SCAN_CAP) {
    const batch = nextRunsForSchedule(
      task.cronExpr,
      Math.min(100, MISSED_SCAN_CAP - count),
      cursor,
    );
    if (batch.length === 0) return count;
    for (const iso of batch) {
      const fire = new Date(iso);
      if (fire.getTime() > shiftedUntil) return count;
      count += 1;
      cursor = fire;
      if (count >= MISSED_SCAN_CAP) return count;
    }
  }
  return count;
}

/** FNV-1a over the task id → deterministic anti-stampede delay 0..30 s. */
function jitterMs(taskId) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(String(taskId))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % (JITTER_MAX_MS + 1);
}

function normalizeStatus(status) {
  const value = String(status ?? 'ok').trim();
  return (value || 'ok').slice(0, 64);
}

function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CLAIM_LIMIT;
  return Math.min(Math.floor(n), MAX_CLAIM_LIMIT);
}

/**
 * In-memory store implementing the scheduler store contract:
 *   createTask(task) / getTask(id) / listTasks({userId})
 *   listDueTasks({now, staleBefore, limit}) — enabled, nextRunAt <= now,
 *     claim absent or older than staleBefore, ordered oldest-due first.
 *   claimTask({id, now, staleBefore})       — compare-and-set on claimedAt;
 *     returns the claimed row or null when the lock was lost.
 *   updateTask(id, patch)
 */
function createMemoryStore() {
  const tasks = new Map();
  const clone = (task) => (task ? { ...task } : null);

  return {
    async createTask(task) {
      if (tasks.has(task.id)) throw new Error(`scheduled-agent-tasks: task ${task.id} already exists`);
      tasks.set(task.id, { ...task });
      return clone(tasks.get(task.id));
    },
    async getTask(id) {
      return clone(tasks.get(id));
    },
    async listTasks({ userId = null } = {}) {
      const out = [];
      for (const task of tasks.values()) {
        if (userId && task.userId !== userId) continue;
        out.push(clone(task));
      }
      return out;
    },
    async listDueTasks({ now, staleBefore, limit = DEFAULT_CLAIM_LIMIT } = {}) {
      const nowMs = toDate(now)?.getTime() ?? Date.now();
      const staleMs = toDate(staleBefore)?.getTime() ?? (nowMs - CLAIM_STALE_MS);
      const due = [];
      for (const task of tasks.values()) {
        if (task.enabled === false) continue;
        const next = toDate(task.nextRunAt);
        if (!next || next.getTime() > nowMs) continue;
        const claimed = toDate(task.claimedAt);
        if (claimed && claimed.getTime() >= staleMs) continue; // fresh claim — not re-delivered
        due.push(task);
      }
      due.sort((a, b) => toDate(a.nextRunAt).getTime() - toDate(b.nextRunAt).getTime());
      return due.slice(0, clampLimit(limit)).map(clone);
    },
    async claimTask({ id, now, staleBefore }) {
      const task = tasks.get(id);
      if (!task || task.enabled === false) return null;
      const nowDate = toDate(now) || new Date();
      const next = toDate(task.nextRunAt);
      if (!next || next.getTime() > nowDate.getTime()) return null;
      const claimed = toDate(task.claimedAt);
      const staleMs = toDate(staleBefore)?.getTime() ?? (nowDate.getTime() - CLAIM_STALE_MS);
      if (claimed && claimed.getTime() >= staleMs) return null; // optimistic lock lost
      task.claimedAt = new Date(nowDate);
      task.updatedAt = new Date(nowDate);
      return clone(task);
    },
    async updateTask(id, patch) {
      const task = tasks.get(id);
      if (!task) return null;
      Object.assign(task, patch);
      return clone(task);
    },
  };
}

function createScheduler({ store = createMemoryStore(), now = () => new Date() } = {}) {
  const nowDate = () => toDate(now()) || new Date();

  /**
   * Register a task. Rejects malformed/unsatisfiable cron expressions and
   * unknown timezones up front so bad rows never reach the polling loop.
   */
  async function createTask({
    id,
    userId,
    cronExpr,
    tz = null,
    payload = null,
    enabled = true,
  } = {}) {
    if (!userId || typeof userId !== 'string') {
      throw new Error('scheduled-agent-tasks: userId is required');
    }
    if (!isValidCronExpr(cronExpr)) {
      throw new Error(`scheduled-agent-tasks: invalid or unsatisfiable cron expression "${cronExpr}"`);
    }
    if (tz != null && !isValidTimezone(tz)) {
      throw new Error(`scheduled-agent-tasks: invalid timezone "${tz}"`);
    }
    const at = nowDate();
    return store.createTask({
      id: typeof id === 'string' && id ? id : `sat_${crypto.randomUUID()}`,
      userId,
      cronExpr,
      tz: tz || null,
      payload,
      enabled: enabled !== false,
      nextRunAt: computeNextRunAt(cronExpr, { tz, from: at }),
      claimedAt: null,
      lastRunAt: null,
      lastStatus: null,
      lastDetail: null,
      runCount: 0,
      createdAt: at,
      updatedAt: at,
    });
  }

  /**
   * OpenClaw catch-up decision for one task at instant `at`: no matter how
   * many fires were missed while the process was down, deliver ONE run and
   * re-anchor to the future on completion.
   */
  function catchUpPolicy(task, at = nowDate()) {
    const dueRuns = countDueRuns(task, at);
    const missed = Math.max(0, dueRuns - 1);
    return {
      policy: CATCH_UP_POLICY,
      dueRuns,
      missed,
      coalesced: missed > 0,
      capped: dueRuns >= MISSED_SCAN_CAP,
    };
  }

  /**
   * Deliver up to `limit` due tasks, each claimed with the optimistic lock.
   * A task already claimed less than CLAIM_STALE_MS ago is skipped; losing
   * the claim CAS to a concurrent worker silently drops the candidate.
   * Each delivery carries its `catchUp` decision.
   */
  async function claimDue({ limit = DEFAULT_CLAIM_LIMIT } = {}) {
    const at = nowDate();
    const lim = clampLimit(limit);
    const staleBefore = new Date(at.getTime() - CLAIM_STALE_MS);
    const candidates = await store.listDueTasks({ now: at, staleBefore, limit: lim });
    const claimed = [];
    for (const candidate of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const task = await store.claimTask({ id: candidate.id, now: at, staleBefore });
      if (!task) continue; // another worker won the claim between list and CAS
      claimed.push({ ...task, catchUp: catchUpPolicy(task, at) });
      if (claimed.length >= lim) break;
    }
    return claimed;
  }

  /**
   * Record the outcome of a claimed run and re-anchor. `nextRunAt` is
   * computed strictly after NOW (not after the old anchor) — this is what
   * makes missed executions coalesce instead of replaying.
   */
  async function completeRun({ taskId, status = 'ok', detail = null } = {}) {
    if (!taskId) throw new Error('scheduled-agent-tasks: taskId is required');
    const task = await store.getTask(taskId);
    if (!task) return null;
    const at = nowDate();
    const nextRunAt = task.enabled === false
      ? null
      : computeNextRunAt(task.cronExpr, { tz: task.tz, from: at });
    return store.updateTask(taskId, {
      lastRunAt: at,
      lastStatus: normalizeStatus(status),
      lastDetail: detail == null ? null : String(detail).slice(0, 2000),
      claimedAt: null,
      nextRunAt,
      runCount: (Number(task.runCount) || 0) + 1,
      updatedAt: at,
    });
  }

  return {
    createTask,
    claimDue,
    completeRun,
    catchUpPolicy,
    jitterMs,
    store,
  };
}

module.exports = {
  createScheduler,
  createMemoryStore,
  computeNextRunAt,
  countDueRuns,
  isValidCronExpr,
  isValidTimezone,
  jitterMs,
  CLAIM_STALE_MS,
  JITTER_MAX_MS,
  DEFAULT_CLAIM_LIMIT,
  MAX_CLAIM_LIMIT,
  MISSED_SCAN_CAP,
  CATCH_UP_POLICY,
};
