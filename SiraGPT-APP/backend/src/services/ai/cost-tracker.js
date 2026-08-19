'use strict';

/**
 * cost-tracker — per-request AI cost accounting.
 *
 * Wraps the existing observability/llm-cost.calculateCost() pricing
 * calculator with a fire-and-forget aggregator that:
 *   - logs a structured record for every generation
 *   - aggregates monthly cost per user (in-memory; persist with `onPersist`)
 *   - exposes `report({ from, to, userId? })` for admin dashboards
 *
 * Designed for fire-and-forget use:
 *   - track() never throws
 *   - track() returns a tiny envelope, but its return value can be ignored
 *   - all errors are swallowed and warn-logged at most once per minute
 *
 * Per-row schema:
 *   { ts, userId, model, provider, inputTokens, outputTokens,
 *     costUSD, latencyMs }
 *
 * Aggregation buckets:
 *   yyyy-mm  →  { userId  →  { totalCostUSD, totalTokens, requests } }
 *
 * In-memory store is bounded by MAX_RECORDS (default 50k); when full
 * we drop the oldest 10% so high-volume tenants don't OOM the server.
 * For long-term storage register an `onPersist(record)` callback once
 * at boot; the harness will call it for every tracked record.
 */

const path = require('path');
const fs = require('fs');

let pricingTable = null;
function loadPricing() {
  if (pricingTable) return pricingTable;
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'pricing.json'), 'utf8');
    pricingTable = JSON.parse(raw);
  } catch (err) {
    pricingTable = { models: {}, _fallback: { input: 1, output: 1 } };
  }
  return pricingTable;
}

function normalizeModelKey(modelKey) {
  if (!modelKey || typeof modelKey !== 'string') return '';
  return modelKey.trim().toLowerCase();
}

function getModelPricing(modelKey) {
  const t = loadPricing();
  const key = normalizeModelKey(modelKey);
  if (!key) return null;
  if (t.models && t.models[key]) return t.models[key];
  const stripped = key.replace(/^[a-z0-9_-]+\//, '');
  if (stripped !== key && t.models && t.models[stripped]) return t.models[stripped];
  return null;
}

function round6(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1_000_000) / 1_000_000;
}

function computeCostUSD({ model, inputTokens, outputTokens }) {
  const t = loadPricing();
  const safeIn = Math.max(0, Number(inputTokens) || 0);
  const safeOut = Math.max(0, Number(outputTokens) || 0);
  if (safeIn === 0 && safeOut === 0) return 0;
  const pricing = getModelPricing(model) || t._fallback || { input: 1, output: 1 };
  const cost = (safeIn / 1_000_000) * pricing.input + (safeOut / 1_000_000) * pricing.output;
  return round6(cost);
}

const MAX_RECORDS = Number.parseInt(process.env.AI_COST_TRACKER_MAX_RECORDS || '50000', 10);
const COST_ALERT_SAMPLE_EVERY = Math.max(
  1,
  Number.parseInt(process.env.AI_COST_ALERT_SAMPLE_EVERY || '100', 10),
);

const state = {
  records: [],                 // bounded log
  monthly: new Map(),          // `${yyyy-mm}` → Map<userId, agg>
  onPersist: null,
  lastWarnAt: 0,
  sampleCounter: 0,            // round-robin counter for cost-alert sampling
  lastFlushTs: 0,              // high-water mark for flushDaily()
};

function monthKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function aggregate(record) {
  const mk = monthKey(record.ts);
  let bucket = state.monthly.get(mk);
  if (!bucket) {
    bucket = new Map();
    state.monthly.set(mk, bucket);
  }
  const uid = String(record.userId || 'anonymous');
  let agg = bucket.get(uid);
  if (!agg) {
    agg = { userId: uid, totalCostUSD: 0, totalInputTokens: 0, totalOutputTokens: 0, requests: 0 };
    bucket.set(uid, agg);
  }
  agg.totalCostUSD = round6(agg.totalCostUSD + record.costUSD);
  agg.totalInputTokens += record.inputTokens;
  agg.totalOutputTokens += record.outputTokens;
  agg.requests += 1;
}

function trimIfNeeded() {
  if (state.records.length <= MAX_RECORDS) return;
  // Drop oldest 10% — cheap and avoids O(n) eviction on every track().
  const drop = Math.floor(MAX_RECORDS * 0.1);
  state.records.splice(0, drop);
}

function maybeWarn(err) {
  const now = Date.now();
  if (now - state.lastWarnAt < 60_000) return;
  state.lastWarnAt = now;
  // eslint-disable-next-line no-console
  console.warn('[cost-tracker] error:', err && err.message ? err.message : err);
}

/**
 * track — fire-and-forget cost record.
 *
 * Returns the structured record (synchronously) so callers can chain
 * onto it for logging if they want; the return value is also safe to
 * ignore. Never throws.
 */
function track(opts) {
  try {
    if (opts === null || (opts !== undefined && typeof opts !== 'object')) opts = {};
    const {
      userId = null,
      model = null,
      provider = null,
      inputTokens = 0,
      outputTokens = 0,
      latencyMs = 0,
      ts = null,
      costUSD = null,
      error = false,
    } = opts || {};
    const timestamp = ts instanceof Date ? ts : new Date(ts || Date.now());
    const safeIn = Math.max(0, Number(inputTokens) || 0);
    const safeOut = Math.max(0, Number(outputTokens) || 0);
    const computedCost = costUSD != null
      ? round6(Number(costUSD) || 0)
      : computeCostUSD({ model, inputTokens: safeIn, outputTokens: safeOut });
    const record = {
      ts: timestamp.toISOString(),
      userId: userId == null ? null : String(userId),
      model: model || null,
      provider: provider || null,
      inputTokens: safeIn,
      outputTokens: safeOut,
      costUSD: computedCost,
      latencyMs: Math.max(0, Number(latencyMs) || 0),
      error: !!error,
    };
    state.records.push(record);
    trimIfNeeded();
    aggregate(record);
    if (typeof state.onPersist === 'function') {
      // Caller hook — wrap in try so persistence failures never propagate.
      try { state.onPersist(record); } catch (persistErr) { maybeWarn(persistErr); }
    }
    // Sample-based cost-alert check: every Nth record we ask the
    // cost-alert detector to look at this user's spend. Lazy-require
    // avoids a circular dependency at module-load time.
    state.sampleCounter += 1;
    if (state.sampleCounter >= COST_ALERT_SAMPLE_EVERY) {
      state.sampleCounter = 0;
      if (record.userId) {
        try {
          const costAlert = require('./cost-alert');
          const alerting = require('../alerting');
          // Fire-and-forget — never await, never throw.
          Promise.resolve()
            .then(() => costAlert.maybeCheck({
              userId: record.userId,
              getRecords: _peekRecords,
              alerting,
            }))
            .catch(() => {});
        } catch (alertErr) { maybeWarn(alertErr); }
      }
    }
    return record;
  } catch (err) {
    maybeWarn(err);
    return null;
  }
}

/**
 * report — filter records by date range and (optional) userId.
 * Returns:
 *   {
 *     totals: { records, costUSD, inputTokens, outputTokens },
 *     perUser: [{ userId, costUSD, inputTokens, outputTokens, requests }],
 *     perModel: [{ model, costUSD, requests }],
 *     records: [...]    // raw, capped at 1000 entries for safety
 *   }
 */
function report({ from = null, to = null, userId = null, includeRecords = true } = {}) {
  const fromMs = from ? new Date(from).getTime() : 0;
  const toMs = to ? new Date(to).getTime() : Number.MAX_SAFE_INTEGER;
  const wantUid = userId == null ? null : String(userId);

  const filtered = state.records.filter((r) => {
    const t = new Date(r.ts).getTime();
    if (t < fromMs || t > toMs) return false;
    if (wantUid != null && r.userId !== wantUid) return false;
    return true;
  });

  const totals = { records: filtered.length, costUSD: 0, inputTokens: 0, outputTokens: 0 };
  const perUser = new Map();
  const perModel = new Map();

  for (const r of filtered) {
    totals.costUSD = round6(totals.costUSD + r.costUSD);
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    const uid = r.userId || 'anonymous';
    let u = perUser.get(uid);
    if (!u) {
      u = { userId: uid, costUSD: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
      perUser.set(uid, u);
    }
    u.costUSD = round6(u.costUSD + r.costUSD);
    u.inputTokens += r.inputTokens;
    u.outputTokens += r.outputTokens;
    u.requests += 1;
    const mk = r.model || 'unknown';
    let mm = perModel.get(mk);
    if (!mm) {
      mm = { model: mk, costUSD: 0, requests: 0 };
      perModel.set(mk, mm);
    }
    mm.costUSD = round6(mm.costUSD + r.costUSD);
    mm.requests += 1;
  }

  return {
    totals,
    perUser: [...perUser.values()].sort((a, b) => b.costUSD - a.costUSD),
    perModel: [...perModel.values()].sort((a, b) => b.costUSD - a.costUSD),
    records: includeRecords ? filtered.slice(-1000) : [],
  };
}

/**
 * topModels — per-model aggregation suitable for admin dashboards.
 * Returns rows sorted by request count desc:
 *   [{ model, provider, requests, totalTokens, totalCostUSD,
 *      avgLatencyMs, errorRate }]
 * `errorRate` is the fraction (0..1) of records that recorded an error.
 * When no records track the optional `error` flag the rate is 0.
 */
function topModels({ from = null, to = null, limit = 10 } = {}) {
  const fromMs = from ? new Date(from).getTime() : 0;
  const toMs = to ? new Date(to).getTime() : Number.MAX_SAFE_INTEGER;
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 10));
  const perModel = new Map();
  for (const r of state.records) {
    const t = new Date(r.ts).getTime();
    if (t < fromMs || t > toMs) continue;
    const key = `${r.model || 'unknown'}::${r.provider || 'unknown'}`;
    let row = perModel.get(key);
    if (!row) {
      row = {
        model: r.model || 'unknown',
        provider: r.provider || 'unknown',
        requests: 0,
        totalTokens: 0,
        totalCostUSD: 0,
        _latencySum: 0,
        _errors: 0,
      };
      perModel.set(key, row);
    }
    row.requests += 1;
    row.totalTokens += (r.inputTokens || 0) + (r.outputTokens || 0);
    row.totalCostUSD = round6(row.totalCostUSD + (r.costUSD || 0));
    row._latencySum += r.latencyMs || 0;
    if (r.error) row._errors += 1;
  }
  const rows = [...perModel.values()]
    .map((row) => ({
      model: row.model,
      provider: row.provider,
      requests: row.requests,
      totalTokens: row.totalTokens,
      totalCostUSD: row.totalCostUSD,
      avgLatencyMs: row.requests > 0 ? Math.round(row._latencySum / row.requests) : 0,
      errorRate: row.requests > 0 ? Math.round((row._errors / row.requests) * 10000) / 10000 : 0,
    }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, safeLimit);
  return rows;
}

/** monthlyCostForUser — quick lookup used by quota / anomaly detector. */
function monthlyCostForUser(userId, date = new Date()) {
  const mk = monthKey(date);
  const bucket = state.monthly.get(mk);
  if (!bucket) return { userId: String(userId), totalCostUSD: 0, requests: 0 };
  const agg = bucket.get(String(userId));
  return agg
    ? { ...agg }
    : { userId: String(userId), totalCostUSD: 0, totalInputTokens: 0, totalOutputTokens: 0, requests: 0 };
}

function setPersistHook(fn) {
  state.onPersist = typeof fn === 'function' ? fn : null;
}

/** _reset — test-only. Clears all state. */
function _reset() {
  state.records = [];
  state.monthly.clear();
  state.onPersist = null;
  state.lastWarnAt = 0;
  state.sampleCounter = 0;
  state.lastFlushTs = 0;
}

function _peekRecords() {
  return state.records.slice();
}

// ── Persistent daily aggregate (ratchet 45) ─────────────────────────────
//
// The in-memory log is bounded and lost on restart. `flushDaily()` rolls
// the recent records up into a per-(date, userId, model, provider,
// organizationId) row and upserts them into the `CostUsageDaily` Prisma
// table so historical cost reports survive restarts.
//
// The flush is **additive**: each call adds the current in-memory window
// to whatever is already persisted. To avoid double-counting we track the
// timestamp of the highest record we've already flushed in `state.lastFlushTs`
// and only consider records strictly newer than that on the next call.
// The cron in `system-cron.js` invokes this once a day at 05:00 UTC.
//
// Organization mapping is best-effort — if a `memberships` array is
// provided we look up the first org for each user; otherwise the row is
// persisted with organizationId = '' (anonymous bucket).

function _dayKey(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Aggregate the in-memory log into daily rows.
 *
 * Returns an array of plain objects shaped like the Prisma row:
 *   { date: Date, userId, organizationId, model, provider,
 *     inputTokens, outputTokens, costUSD, requests }
 *
 * Pure — no I/O. Exposed for unit tests + so the cron job can decide
 * how to persist (Prisma in prod, fake in tests).
 *
 * @param {object} opts
 * @param {Date|null} opts.since   only include records strictly newer than this ts (default state.lastFlushTs)
 * @param {Date|null} opts.until   only include records <= this ts (default now)
 * @param {Map|object} opts.userOrgIndex  optional userId → organizationId map
 */
function aggregateDaily({ since = null, until = null, userOrgIndex = null } = {}) {
  const sinceMs = since ? new Date(since).getTime() : state.lastFlushTs;
  const untilMs = until ? new Date(until).getTime() : Date.now();
  const lookup = userOrgIndex && typeof userOrgIndex.get === 'function'
    ? (uid) => userOrgIndex.get(uid)
    : (uid) => (userOrgIndex && userOrgIndex[uid]) || '';

  // key → row
  const buckets = new Map();
  for (const r of state.records) {
    const t = new Date(r.ts).getTime();
    if (!Number.isFinite(t)) continue;
    if (t <= sinceMs) continue;
    if (t > untilMs) continue;
    const dayKey = _dayKey(r.ts);
    if (!dayKey) continue;
    const userId = r.userId || '';
    const provider = r.provider || '';
    const model = r.model || 'unknown';
    const organizationId = lookup(userId) || '';
    const key = `${dayKey}|${userId}|${model}|${provider}|${organizationId}`;
    let row = buckets.get(key);
    if (!row) {
      row = {
        date: new Date(`${dayKey}T00:00:00.000Z`),
        userId,
        organizationId,
        model,
        provider,
        inputTokens: 0,
        outputTokens: 0,
        costUSD: 0,
        requests: 0,
      };
      buckets.set(key, row);
    }
    row.inputTokens += r.inputTokens || 0;
    row.outputTokens += r.outputTokens || 0;
    row.costUSD = round6(row.costUSD + (r.costUSD || 0));
    row.requests += 1;
  }
  return [...buckets.values()];
}

/**
 * Flush the in-memory log to the `CostUsageDaily` Prisma table.
 *
 * Resolves with `{ rows, persisted, skipped, errors }`. Never throws —
 * persistence errors are swallowed and warn-logged so a transient DB blip
 * cannot crash the cron host. The high-water mark `state.lastFlushTs` is
 * advanced only after a successful upsert pass so a partial failure can
 * be retried by the next cron tick.
 *
 * @param {object} opts
 * @param {object} opts.prisma         optional Prisma client (DI for tests)
 * @param {Date|null} opts.until       upper bound (default = now)
 * @param {Map|object} opts.userOrgIndex   optional userId → orgId lookup
 */
async function flushDaily(opts = {}) {
  const prisma = opts.prisma || (() => {
    try { return require('../../config/database'); } catch (_) { return null; }
  })();
  if (!prisma || !prisma.costUsageDaily || typeof prisma.costUsageDaily.upsert !== 'function') {
    maybeWarn(new Error('flushDaily: prisma.costUsageDaily.upsert not available'));
    return { rows: 0, persisted: 0, skipped: 0, errors: 1 };
  }
  const untilMs = opts.until ? new Date(opts.until).getTime() : Date.now();
  const rows = aggregateDaily({
    since: opts.since || null,
    until: new Date(untilMs),
    userOrgIndex: opts.userOrgIndex || null,
  });
  if (rows.length === 0) {
    state.lastFlushTs = untilMs;
    return { rows: 0, persisted: 0, skipped: 0, errors: 0 };
  }
  let persisted = 0;
  let errors = 0;
  for (const row of rows) {
    try {
      // Upsert is additive: on conflict we INCREMENT the existing row's
      // counters by the new delta. The unique key (date+userId+model+provider+
      // organizationId) is the same one we declared in schema.prisma.
      await prisma.costUsageDaily.upsert({
        where: {
          cost_usage_daily_unique: {
            date: row.date,
            userId: row.userId,
            model: row.model,
            provider: row.provider,
            organizationId: row.organizationId,
          },
        },
        create: {
          date: row.date,
          userId: row.userId,
          organizationId: row.organizationId,
          model: row.model,
          provider: row.provider,
          inputTokens: BigInt(row.inputTokens),
          outputTokens: BigInt(row.outputTokens),
          costUSD: row.costUSD,
          requests: row.requests,
        },
        update: {
          inputTokens: { increment: BigInt(row.inputTokens) },
          outputTokens: { increment: BigInt(row.outputTokens) },
          costUSD: { increment: row.costUSD },
          requests: { increment: row.requests },
        },
      });
      persisted += 1;
    } catch (err) {
      errors += 1;
      maybeWarn(err);
    }
  }
  // Only advance the high-water mark on a full clean pass so a partial
  // failure can be retried with the same window on the next tick.
  if (errors === 0) state.lastFlushTs = untilMs;
  return { rows: rows.length, persisted, skipped: 0, errors };
}

/**
 * Load aggregated daily rows from the persisted table.
 *
 * Used by the admin /cost-report endpoint when `from` is older than 24h.
 * Returns the same shape as `report()` so callers can splice persistent
 * + in-memory data side-by-side. Never throws — DB errors return an empty
 * envelope so the live report still works.
 */
async function loadDailyReport({
  from = null,
  to = null,
  userId = null,
  organizationId = null,
  prisma = null,
} = {}) {
  const empty = {
    totals: { records: 0, costUSD: 0, inputTokens: 0, outputTokens: 0 },
    perUser: [],
    perModel: [],
    records: [],
  };
  const client = prisma || (() => {
    try { return require('../../config/database'); } catch (_) { return null; }
  })();
  if (!client || !client.costUsageDaily || typeof client.costUsageDaily.findMany !== 'function') {
    return empty;
  }
  const where = {};
  if (from || to) {
    where.date = {};
    if (from) where.date.gte = new Date(from);
    if (to) where.date.lte = new Date(to);
  }
  if (userId != null) where.userId = String(userId);
  if (organizationId != null) where.organizationId = String(organizationId);
  let rows;
  try {
    rows = await client.costUsageDaily.findMany({ where });
  } catch (err) {
    maybeWarn(err);
    return empty;
  }
  const totals = { records: 0, costUSD: 0, inputTokens: 0, outputTokens: 0 };
  const perUser = new Map();
  const perModel = new Map();
  for (const r of rows) {
    const inT = Number(r.inputTokens) || 0;
    const outT = Number(r.outputTokens) || 0;
    const cost = Number(r.costUSD) || 0;
    const reqs = Number(r.requests) || 0;
    totals.records += reqs;
    totals.costUSD = round6(totals.costUSD + cost);
    totals.inputTokens += inT;
    totals.outputTokens += outT;
    const uid = r.userId || 'anonymous';
    let u = perUser.get(uid);
    if (!u) {
      u = { userId: uid, costUSD: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
      perUser.set(uid, u);
    }
    u.costUSD = round6(u.costUSD + cost);
    u.inputTokens += inT;
    u.outputTokens += outT;
    u.requests += reqs;
    const mk = r.model || 'unknown';
    let mm = perModel.get(mk);
    if (!mm) {
      mm = { model: mk, costUSD: 0, requests: 0 };
      perModel.set(mk, mm);
    }
    mm.costUSD = round6(mm.costUSD + cost);
    mm.requests += reqs;
  }
  return {
    totals,
    perUser: [...perUser.values()].sort((a, b) => b.costUSD - a.costUSD),
    perModel: [...perModel.values()].sort((a, b) => b.costUSD - a.costUSD),
    records: [],
  };
}

/**
 * Merge a persisted daily report with the in-memory recent report.
 * Sums totals/perUser/perModel; preserves in-memory records list.
 */
function mergeReports(persisted, recent) {
  const totals = {
    records: (persisted.totals.records || 0) + (recent.totals.records || 0),
    costUSD: round6((persisted.totals.costUSD || 0) + (recent.totals.costUSD || 0)),
    inputTokens: (persisted.totals.inputTokens || 0) + (recent.totals.inputTokens || 0),
    outputTokens: (persisted.totals.outputTokens || 0) + (recent.totals.outputTokens || 0),
  };
  const perUserMap = new Map();
  const mergeUser = (u) => {
    let acc = perUserMap.get(u.userId);
    if (!acc) {
      acc = { userId: u.userId, costUSD: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
      perUserMap.set(u.userId, acc);
    }
    acc.costUSD = round6(acc.costUSD + (u.costUSD || 0));
    acc.inputTokens += u.inputTokens || 0;
    acc.outputTokens += u.outputTokens || 0;
    acc.requests += u.requests || 0;
  };
  (persisted.perUser || []).forEach(mergeUser);
  (recent.perUser || []).forEach(mergeUser);
  const perModelMap = new Map();
  const mergeModel = (m) => {
    let acc = perModelMap.get(m.model);
    if (!acc) {
      acc = { model: m.model, costUSD: 0, requests: 0 };
      perModelMap.set(m.model, acc);
    }
    acc.costUSD = round6(acc.costUSD + (m.costUSD || 0));
    acc.requests += m.requests || 0;
  };
  (persisted.perModel || []).forEach(mergeModel);
  (recent.perModel || []).forEach(mergeModel);
  return {
    totals,
    perUser: [...perUserMap.values()].sort((a, b) => b.costUSD - a.costUSD),
    perModel: [...perModelMap.values()].sort((a, b) => b.costUSD - a.costUSD),
    records: recent.records || [],
  };
}

// ── 13-month retention archive (ratchet 45) ─────────────────────────────
//
// `CostUsageDaily` grows linearly with traffic. After 13 months the daily
// granularity is no longer useful for finance dashboards — they only ever
// query rolled-up totals. `archiveOldDaily()` collapses old rows into a
// per-(month, userId) JSON blob stored in `SystemSettings` under key
// `cost_archive:YYYY-MM-<userId>` and then deletes the daily rows.
//
// Archive payload shape:
//   {
//     month: 'YYYY-MM',
//     userId,
//     costUSD, inputTokens, outputTokens, requests,
//     perModel: [{ model, provider, costUSD, inputTokens, outputTokens, requests }],
//     archivedAt: ISO timestamp,
//   }
//
// The cron in `system-cron.js` invokes this once a day at 05:30 UTC (right
// after `flushDaily` at 05:00). The function is idempotent — if an archive
// row for a (month,userId) already exists we merge the new rows into it
// before deleting them.

const ARCHIVE_RETENTION_MONTHS = Number.parseInt(
  process.env.AI_COST_ARCHIVE_RETENTION_MONTHS || '13',
  10,
);
const ARCHIVE_KEY_PREFIX = 'cost_archive:';

function _archiveKey(monthKeyStr, userId) {
  return `${ARCHIVE_KEY_PREFIX}${monthKeyStr}-${userId || ''}`;
}

function _archiveCutoff(now = new Date(), months = ARCHIVE_RETENTION_MONTHS) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

function _safeParseArchive(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) { return null; }
}

function _mergeArchiveEntry(prev, row) {
  const base = prev || {
    month: null,
    userId: row.userId || '',
    costUSD: 0,
    inputTokens: 0,
    outputTokens: 0,
    requests: 0,
    perModel: [],
  };
  base.costUSD = round6((base.costUSD || 0) + (Number(row.costUSD) || 0));
  base.inputTokens = (Number(base.inputTokens) || 0) + Number(row.inputTokens || 0);
  base.outputTokens = (Number(base.outputTokens) || 0) + Number(row.outputTokens || 0);
  base.requests = (Number(base.requests) || 0) + (Number(row.requests) || 0);
  const modelKey = `${row.model || 'unknown'}::${row.provider || ''}`;
  const list = Array.isArray(base.perModel) ? base.perModel : [];
  let m = list.find((x) => `${x.model || 'unknown'}::${x.provider || ''}` === modelKey);
  if (!m) {
    m = {
      model: row.model || 'unknown',
      provider: row.provider || '',
      costUSD: 0,
      inputTokens: 0,
      outputTokens: 0,
      requests: 0,
    };
    list.push(m);
  }
  m.costUSD = round6((m.costUSD || 0) + (Number(row.costUSD) || 0));
  m.inputTokens = (Number(m.inputTokens) || 0) + Number(row.inputTokens || 0);
  m.outputTokens = (Number(m.outputTokens) || 0) + Number(row.outputTokens || 0);
  m.requests = (Number(m.requests) || 0) + (Number(row.requests) || 0);
  base.perModel = list;
  return base;
}

/**
 * Aggregate CostUsageDaily rows older than `retentionMonths` months into
 * SystemSettings `cost_archive:YYYY-MM-<userId>` entries and delete the
 * source rows. Returns `{ scanned, archivedKeys, deleted, errors }`.
 *
 * Never throws — DB errors are swallowed and warn-logged. Safe to call
 * repeatedly: existing archive entries are merged additively.
 */
async function archiveOldDaily(opts = {}) {
  const prisma = opts.prisma || (() => {
    try { return require('../../config/database'); } catch (_) { return null; }
  })();
  const empty = { scanned: 0, archivedKeys: 0, deleted: 0, errors: 0 };
  if (!prisma || !prisma.costUsageDaily || typeof prisma.costUsageDaily.findMany !== 'function'
      || !prisma.systemSettings || typeof prisma.systemSettings.upsert !== 'function'
      || typeof prisma.costUsageDaily.deleteMany !== 'function') {
    maybeWarn(new Error('archiveOldDaily: required prisma models unavailable'));
    return { ...empty, errors: 1 };
  }
  const months = Number.isFinite(opts.retentionMonths) && opts.retentionMonths > 0
    ? opts.retentionMonths
    : ARCHIVE_RETENTION_MONTHS;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const cutoff = _archiveCutoff(now, months);
  let rows;
  try {
    rows = await prisma.costUsageDaily.findMany({ where: { date: { lt: cutoff } } });
  } catch (err) {
    maybeWarn(err);
    return { ...empty, errors: 1 };
  }
  if (!rows.length) return empty;

  // Group rows by (month, userId).
  const byKey = new Map();
  for (const r of rows) {
    const mk = monthKey(r.date);
    const uid = r.userId || '';
    const k = _archiveKey(mk, uid);
    let entry = byKey.get(k);
    if (!entry) {
      entry = { key: k, month: mk, userId: uid, rows: [] };
      byKey.set(k, entry);
    }
    entry.rows.push(r);
  }

  let archivedKeys = 0;
  let errors = 0;
  for (const entry of byKey.values()) {
    try {
      let existing = null;
      try {
        const found = await prisma.systemSettings.findUnique({ where: { key: entry.key } });
        existing = _safeParseArchive(found && found.value);
      } catch (_) { /* findUnique optional — upsert handles create */ }
      let merged = existing || null;
      for (const r of entry.rows) {
        merged = _mergeArchiveEntry(merged, r);
      }
      merged.month = entry.month;
      merged.userId = entry.userId;
      merged.archivedAt = new Date().toISOString();
      const value = JSON.stringify(merged);
      await prisma.systemSettings.upsert({
        where: { key: entry.key },
        create: { key: entry.key, value },
        update: { value },
      });
      archivedKeys += 1;
    } catch (err) {
      errors += 1;
      maybeWarn(err);
    }
  }

  // Only delete the source rows after archive upserts succeeded. If any
  // upserts failed we leave all rows in place so the next cron tick retries.
  let deleted = 0;
  if (errors === 0) {
    try {
      const res = await prisma.costUsageDaily.deleteMany({ where: { date: { lt: cutoff } } });
      deleted = (res && typeof res.count === 'number') ? res.count : rows.length;
    } catch (err) {
      errors += 1;
      maybeWarn(err);
    }
  }
  return { scanned: rows.length, archivedKeys, deleted, errors };
}

/**
 * Load an aggregated report from the SystemSettings archive for ranges
 * older than the 13-month retention. Scans keys matching `cost_archive:*`
 * and folds matching months into the standard report envelope.
 *
 * Filters: `from` / `to` (Date|string) clip to whole months; `userId`
 * restricts to a single user's archive entries.
 *
 * Never throws — DB errors return an empty envelope.
 */
async function loadArchivedReport({
  from = null,
  to = null,
  userId = null,
  prisma = null,
} = {}) {
  const empty = {
    totals: { records: 0, costUSD: 0, inputTokens: 0, outputTokens: 0 },
    perUser: [],
    perModel: [],
    records: [],
  };
  const client = prisma || (() => {
    try { return require('../../config/database'); } catch (_) { return null; }
  })();
  if (!client || !client.systemSettings || typeof client.systemSettings.findMany !== 'function') {
    return empty;
  }
  const fromMonth = from ? monthKey(new Date(from)) : null;
  const toMonth = to ? monthKey(new Date(to)) : null;
  const wantUid = userId == null ? null : String(userId);

  let rows;
  try {
    rows = await client.systemSettings.findMany({
      where: { key: { startsWith: ARCHIVE_KEY_PREFIX } },
    });
  } catch (err) {
    maybeWarn(err);
    return empty;
  }
  const totals = { records: 0, costUSD: 0, inputTokens: 0, outputTokens: 0 };
  const perUser = new Map();
  const perModel = new Map();
  for (const row of rows || []) {
    const parsed = _safeParseArchive(row.value);
    if (!parsed || !parsed.month) continue;
    if (fromMonth && parsed.month < fromMonth) continue;
    if (toMonth && parsed.month > toMonth) continue;
    if (wantUid != null && String(parsed.userId || '') !== wantUid) continue;
    const inT = Number(parsed.inputTokens) || 0;
    const outT = Number(parsed.outputTokens) || 0;
    const cost = Number(parsed.costUSD) || 0;
    const reqs = Number(parsed.requests) || 0;
    totals.records += reqs;
    totals.costUSD = round6(totals.costUSD + cost);
    totals.inputTokens += inT;
    totals.outputTokens += outT;
    const uid = parsed.userId || 'anonymous';
    let u = perUser.get(uid);
    if (!u) {
      u = { userId: uid, costUSD: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
      perUser.set(uid, u);
    }
    u.costUSD = round6(u.costUSD + cost);
    u.inputTokens += inT;
    u.outputTokens += outT;
    u.requests += reqs;
    for (const m of Array.isArray(parsed.perModel) ? parsed.perModel : []) {
      const mk = m.model || 'unknown';
      let mm = perModel.get(mk);
      if (!mm) {
        mm = { model: mk, costUSD: 0, requests: 0 };
        perModel.set(mk, mm);
      }
      mm.costUSD = round6(mm.costUSD + (Number(m.costUSD) || 0));
      mm.requests += Number(m.requests) || 0;
    }
  }
  return {
    totals,
    perUser: [...perUser.values()].sort((a, b) => b.costUSD - a.costUSD),
    perModel: [...perModel.values()].sort((a, b) => b.costUSD - a.costUSD),
    records: [],
  };
}

module.exports = {
  track,
  report,
  topModels,
  monthlyCostForUser,
  setPersistHook,
  computeCostUSD,
  getModelPricing,
  loadPricing,
  aggregateDaily,
  flushDaily,
  loadDailyReport,
  loadArchivedReport,
  archiveOldDaily,
  mergeReports,
  ARCHIVE_KEY_PREFIX,
  ARCHIVE_RETENTION_MONTHS,
  _reset,
  _peekRecords,
};
