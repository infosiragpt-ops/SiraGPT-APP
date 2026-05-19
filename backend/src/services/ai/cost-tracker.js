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

const state = {
  records: [],                 // bounded log
  monthly: new Map(),          // `${yyyy-mm}` → Map<userId, agg>
  onPersist: null,
  lastWarnAt: 0,
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
}

function _peekRecords() {
  return state.records.slice();
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
  _reset,
  _peekRecords,
};
