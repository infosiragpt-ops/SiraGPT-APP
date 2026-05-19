'use strict';

/**
 * cost-alert — per-org and per-user runaway-cost alert detector.
 *
 * Watches the in-memory cost-tracker records and, when triggered, fires
 * an alert through the cycle 32 alerting service if BOTH of these are
 * true for the scope (a single userId or the union of an org's members):
 *
 *   1. today's cost is more than 2x the 7-day rolling average, and
 *   2. today's cost is greater than $10.
 *
 * The check is intentionally cheap (O(n) over in-memory records, which
 * are already bounded by the tracker's MAX_RECORDS) and best-effort:
 *   - never throws,
 *   - all alerting errors are swallowed,
 *   - dedup is delegated to the alerting layer (stable `title` per
 *     scope, so repeated invocations within the dedup window collapse).
 *
 * Wiring: cost-tracker.track() samples every Nth request (default 100)
 * and calls `maybeCheck()` with the relevant scope. This keeps the
 * fast path allocation-free for the other 99 calls.
 *
 * Exports `maybeCheck`, `checkUser`, `checkOrg`, plus internal helpers
 * for tests.
 */

const COST_ALERT_DOLLAR_THRESHOLD = 10;
const COST_ALERT_RATIO = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WARN_THRESHOLD_PCT = 80;

function _startOfUtcDay(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function _round6(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Summarise a set of records into todayCost + 7-day rolling average
 * (the average is computed over the 7 days that ended yesterday — so
 * today's spike is compared against a stable baseline, not against
 * itself).
 *
 * @param {Array<{ts: string, costUSD: number}>} records
 * @param {number} [nowMs]
 * @returns {{ todayUSD: number, avg7dUSD: number, baselineDays: number }}
 */
function summarize(records, nowMs = Date.now()) {
  if (!Array.isArray(records) || records.length === 0) {
    return { todayUSD: 0, avg7dUSD: 0, baselineDays: 0 };
  }
  const todayStart = _startOfUtcDay(nowMs);
  const windowStart = todayStart - 7 * DAY_MS;
  let todayUSD = 0;
  let baselineUSD = 0;
  for (const r of records) {
    if (!r) continue;
    const t = new Date(r.ts).getTime();
    if (!Number.isFinite(t)) continue;
    const cost = Number(r.costUSD) || 0;
    if (cost <= 0) continue;
    if (t >= todayStart) {
      todayUSD += cost;
    } else if (t >= windowStart) {
      baselineUSD += cost;
    }
  }
  return {
    todayUSD: _round6(todayUSD),
    avg7dUSD: _round6(baselineUSD / 7),
    baselineDays: 7,
  };
}

/**
 * Decide whether the summary trips the alert thresholds.
 * Returns null when no alert is warranted.
 */
function evaluate(summary) {
  if (!summary) return null;
  const { todayUSD, avg7dUSD } = summary;
  if (todayUSD <= COST_ALERT_DOLLAR_THRESHOLD) return null;
  // When baseline is effectively 0 we still want to surface unusually
  // large spend, but we don't want a single $11 day on a fresh account
  // to page anyone — gate on the dollar threshold AND require some
  // baseline activity (avg7dUSD > 0) to compute a meaningful ratio.
  if (!(avg7dUSD > 0)) return null;
  const ratio = todayUSD / avg7dUSD;
  if (ratio <= COST_ALERT_RATIO) return null;
  return { ratio: _round6(ratio), todayUSD, avg7dUSD };
}

async function checkUser({ userId, getRecords, alerting } = {}) {
  if (!userId || typeof getRecords !== 'function' || !alerting) return null;
  let records;
  try { records = getRecords(); } catch { return null; }
  const scoped = (Array.isArray(records) ? records : []).filter(
    (r) => r && String(r.userId) === String(userId),
  );
  const summary = summarize(scoped);
  const verdict = evaluate(summary);
  if (!verdict) return null;
  try {
    await alerting.sendAlert({
      title: `ai_cost_runaway_user:${userId}`,
      message: `User ${userId} spent $${verdict.todayUSD.toFixed(2)} today, ` +
        `${verdict.ratio.toFixed(2)}x the 7-day average of $${verdict.avg7dUSD.toFixed(2)}.`,
      severity: 'warn',
      context: { scope: 'user', userId, ...verdict },
    });
  } catch { /* alerting never throws — defensive */ }
  return verdict;
}

async function checkOrg({ orgId, memberIds, getRecords, alerting } = {}) {
  if (!orgId || !Array.isArray(memberIds) || memberIds.length === 0) return null;
  if (typeof getRecords !== 'function' || !alerting) return null;
  const set = new Set(memberIds.map((m) => String(m)));
  let records;
  try { records = getRecords(); } catch { return null; }
  const scoped = (Array.isArray(records) ? records : []).filter(
    (r) => r && set.has(String(r.userId)),
  );
  const summary = summarize(scoped);
  const verdict = evaluate(summary);
  if (!verdict) return null;
  try {
    await alerting.sendAlert({
      title: `ai_cost_runaway_org:${orgId}`,
      message: `Org ${orgId} spent $${verdict.todayUSD.toFixed(2)} today, ` +
        `${verdict.ratio.toFixed(2)}x the 7-day average of $${verdict.avg7dUSD.toFixed(2)}.`,
      severity: 'warn',
      context: { scope: 'org', orgId, memberCount: set.size, ...verdict },
    });
  } catch { /* alerting never throws — defensive */ }
  return verdict;
}

/**
 * Sum month-to-date USD spend across a set of member ids from the
 * tracker's in-memory records. Month is computed in UTC.
 *
 * @param {Array<{ts:string, userId:string, costUSD:number}>} records
 * @param {Set<string>} memberSet
 * @param {number} [nowMs]
 */
function _sumMonthToDate(records, memberSet, nowMs = Date.now()) {
  if (!Array.isArray(records) || records.length === 0) return 0;
  const now = new Date(nowMs);
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  let total = 0;
  for (const r of records) {
    if (!r) continue;
    if (!memberSet.has(String(r.userId))) continue;
    const t = new Date(r.ts).getTime();
    if (!Number.isFinite(t) || t < monthStart) continue;
    const cost = Number(r.costUSD) || 0;
    if (cost > 0) total += cost;
  }
  return _round6(total);
}

/**
 * Normalise an org budget object (typically read from `Organization.settings.budget`).
 * Returns `null` when no usable cap is configured.
 *
 * Shape: { monthlyCapUSD: number, warnThresholdPct?: number }
 */
function normalizeBudget(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const cap = Number(raw.monthlyCapUSD);
  if (!Number.isFinite(cap) || cap <= 0) return null;
  let pct = Number(raw.warnThresholdPct);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) pct = DEFAULT_WARN_THRESHOLD_PCT;
  return {
    monthlyCapUSD: _round6(cap),
    warnThresholdPct: pct,
    warnAtUSD: _round6(cap * (pct / 100)),
  };
}

/**
 * checkOrgBudget — month-to-date cap enforcement for an organization.
 * Fires a cycle-32 alert when MTD spend across `memberIds` crosses the
 * warn threshold (defaults to 80% of cap) and again when it exceeds the
 * full cap. Dedup is provided by the alerting layer via stable titles.
 *
 * @param {object} opts
 * @param {string}   opts.orgId
 * @param {string[]} opts.memberIds
 * @param {object}   opts.budget       `{ monthlyCapUSD, warnThresholdPct? }`
 * @param {Function} opts.getRecords   tracker snapshot getter
 * @param {object}   opts.alerting     cycle 32 alerting service
 * @param {number}   [opts.nowMs]      injected clock (tests)
 */
async function checkOrgBudget({ orgId, memberIds, budget, getRecords, alerting, nowMs } = {}) {
  if (!orgId || !Array.isArray(memberIds) || memberIds.length === 0) return null;
  if (typeof getRecords !== 'function' || !alerting) return null;
  const norm = normalizeBudget(budget);
  if (!norm) return null;
  let records;
  try { records = getRecords(); } catch { return null; }
  const memberSet = new Set(memberIds.map((m) => String(m)));
  const usedThisMonthUSD = _sumMonthToDate(
    Array.isArray(records) ? records : [],
    memberSet,
    nowMs,
  );
  if (usedThisMonthUSD < norm.warnAtUSD) {
    return {
      orgId,
      usedThisMonthUSD,
      ...norm,
      fired: false,
    };
  }
  const overCap = usedThisMonthUSD >= norm.monthlyCapUSD;
  const severity = overCap ? 'error' : 'warn';
  // Stable titles → alerting dedups within its window so a sampling-hook
  // can call this on every nth request without flooding the channel.
  const title = overCap
    ? `org_budget_exceeded:${orgId}`
    : `org_budget_warn:${orgId}`;
  const pctOfCap = norm.monthlyCapUSD > 0
    ? _round6(usedThisMonthUSD / norm.monthlyCapUSD)
    : 0;
  try {
    await alerting.sendAlert({
      title,
      message: `Org ${orgId} has used $${usedThisMonthUSD.toFixed(2)} of $${norm.monthlyCapUSD.toFixed(2)} ` +
        `month-to-date (${Math.round(pctOfCap * 100)}% of cap; warn at ${norm.warnThresholdPct}%).`,
      severity,
      context: {
        scope: 'org_budget',
        orgId,
        memberCount: memberSet.size,
        usedThisMonthUSD,
        monthlyCapUSD: norm.monthlyCapUSD,
        warnThresholdPct: norm.warnThresholdPct,
        warnAtUSD: norm.warnAtUSD,
        pctOfCap,
        overCap,
      },
    });
  } catch { /* alerting never throws — defensive */ }
  return {
    orgId,
    usedThisMonthUSD,
    ...norm,
    pctOfCap,
    overCap,
    fired: true,
    severity,
  };
}

/**
 * Combined entrypoint used by the cost-tracker sampling hook.
 * Always returns a plain object (never throws) describing what was
 * checked and which (if any) verdict tripped.
 *
 * @param {object} opts
 * @param {string}   [opts.userId]
 * @param {string}   [opts.orgId]
 * @param {string[]} [opts.memberIds]   required if orgId is set
 * @param {Function} opts.getRecords    returns the tracker's record snapshot
 * @param {object}   opts.alerting      cycle 32 alerting service
 * @param {object}   [opts.budget]      org budget config (triggers checkOrgBudget)
 */
async function maybeCheck(opts = {}) {
  const out = { user: null, org: null, orgBudget: null };
  try {
    if (opts.userId) out.user = await checkUser(opts);
    if (opts.orgId) out.org = await checkOrg(opts);
    if (opts.orgId && opts.budget) out.orgBudget = await checkOrgBudget(opts);
  } catch { /* never throw */ }
  return out;
}

module.exports = {
  maybeCheck,
  checkUser,
  checkOrg,
  checkOrgBudget,
  normalizeBudget,
  summarize,
  evaluate,
  COST_ALERT_DOLLAR_THRESHOLD,
  COST_ALERT_RATIO,
  DEFAULT_WARN_THRESHOLD_PCT,
  _sumMonthToDate,
};
