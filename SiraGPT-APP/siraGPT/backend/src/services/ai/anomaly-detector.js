'use strict';

/**
 * anomaly-detector — flag abnormally large AI requests per user.
 *
 * Maintains a rolling window of per-user daily token usage and
 * computes mean + stddev on demand. A new request is flagged if its
 * token total exceeds `mean + N * stddev` (N defaults to 3 — the
 * classic three-sigma rule).
 *
 * Modes:
 *   - default: flag only — caller decides what to do
 *   - block:   env `BLOCK_ANOMALOUS_USAGE=1` → check() returns
 *              `{ flagged: true, block: true }` so the caller can
 *              return 429 to the user.
 *
 * Storage is in-process (Map). For multi-instance deployments
 * promote to Redis with `setStore({ get, set })`; the math here is
 * storage-agnostic so the migration is mechanical.
 */

const DEFAULT_SIGMA_THRESHOLD = Number.parseFloat(process.env.ANOMALY_SIGMA_THRESHOLD || '3');
const DEFAULT_WINDOW_DAYS = Number.parseInt(process.env.ANOMALY_WINDOW_DAYS || '14', 10);
const DEFAULT_MIN_DATAPOINTS = 5;

function dayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function stats(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { mean: 0, stddev: 0, n: 0 };
  }
  const n = values.length;
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  let sse = 0;
  for (const v of values) {
    const d = v - mean;
    sse += d * d;
  }
  // Population stddev — we're describing the distribution we *have*,
  // not estimating the population. For N≥5 the difference vs sample
  // stddev (Bessel correction) is small and irrelevant for an outlier
  // alarm threshold.
  const stddev = Math.sqrt(sse / n);
  return { mean, stddev, n };
}

const state = {
  // Map<userId, Map<dayKey, totalTokens>>
  byUser: new Map(),
  windowDays: DEFAULT_WINDOW_DAYS,
  sigma: DEFAULT_SIGMA_THRESHOLD,
  minDatapoints: DEFAULT_MIN_DATAPOINTS,
  externalStore: null,
};

function trimWindow(daysMap) {
  if (daysMap.size <= state.windowDays * 2) return;
  // Keep only the most recent windowDays entries; iterate sorted desc.
  const sorted = [...daysMap.keys()].sort();
  const keep = new Set(sorted.slice(-state.windowDays));
  for (const k of daysMap.keys()) {
    if (!keep.has(k)) daysMap.delete(k);
  }
}

/**
 * record — add today's usage for a user. Idempotent for same day:
 * subsequent calls accumulate tokens.
 */
function record(userId, tokens, ts = new Date()) {
  if (userId == null) return;
  const uid = String(userId);
  const day = dayKey(ts);
  let daysMap = state.byUser.get(uid);
  if (!daysMap) {
    daysMap = new Map();
    state.byUser.set(uid, daysMap);
  }
  daysMap.set(day, (daysMap.get(day) || 0) + Math.max(0, Number(tokens) || 0));
  trimWindow(daysMap);
}

/**
 * check — should we flag (or block) this user's incoming request?
 *
 * `tokens` is the in-flight request's estimated token cost (or actual
 * cost when computed post-hoc). When `mean + sigma * stddev` is
 * exceeded the result is `{ flagged: true, ... }`. With < minDatapoints
 * historical days we never flag — too noisy.
 *
 * Returns `{ flagged, block, mean, stddev, threshold, datapoints }`.
 */
function check(userId, tokens, opts = {}) {
  const uid = String(userId);
  const sigma = Number.isFinite(opts.sigma) ? opts.sigma : state.sigma;
  const minPts = Number.isFinite(opts.minDatapoints) ? opts.minDatapoints : state.minDatapoints;

  const daysMap = state.byUser.get(uid);
  const values = daysMap ? [...daysMap.values()] : [];
  // Use the historical distribution (excluding the in-flight request)
  // so a single huge call doesn't dampen its own outlier signal.
  const { mean, stddev, n } = stats(values);
  const threshold = mean + sigma * stddev;
  const reqTokens = Math.max(0, Number(tokens) || 0);

  if (n < minPts) {
    return { flagged: false, block: false, mean, stddev, threshold, datapoints: n, reason: 'insufficient-history' };
  }
  if (reqTokens <= threshold) {
    return { flagged: false, block: false, mean, stddev, threshold, datapoints: n };
  }

  const shouldBlock = process.env.BLOCK_ANOMALOUS_USAGE === '1'
    || process.env.BLOCK_ANOMALOUS_USAGE === 'true';

  // High-priority warning — surfaces in logs even when LOG_LEVEL filters info.
  // eslint-disable-next-line no-console
  console.warn('[anomaly-detector] FLAGGED user=%s tokens=%d threshold=%d mean=%d stddev=%d',
    uid, reqTokens, Math.round(threshold), Math.round(mean), Math.round(stddev));

  return {
    flagged: true,
    block: shouldBlock,
    mean,
    stddev,
    threshold,
    datapoints: n,
    excess: reqTokens - threshold,
  };
}

function configure({ windowDays, sigma, minDatapoints } = {}) {
  if (Number.isFinite(windowDays) && windowDays > 0) state.windowDays = Math.floor(windowDays);
  if (Number.isFinite(sigma) && sigma >= 0) state.sigma = sigma;
  if (Number.isFinite(minDatapoints) && minDatapoints >= 1) state.minDatapoints = Math.floor(minDatapoints);
}

function _reset() {
  state.byUser.clear();
  state.windowDays = DEFAULT_WINDOW_DAYS;
  state.sigma = DEFAULT_SIGMA_THRESHOLD;
  state.minDatapoints = DEFAULT_MIN_DATAPOINTS;
}

function _peek(userId) {
  const daysMap = state.byUser.get(String(userId));
  return daysMap ? Object.fromEntries(daysMap) : {};
}

module.exports = {
  record,
  check,
  configure,
  stats,
  dayKey,
  _reset,
  _peek,
};
