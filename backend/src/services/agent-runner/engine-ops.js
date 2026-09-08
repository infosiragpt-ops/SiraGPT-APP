'use strict';

/**
 * 3H21 — engine ops layer for AgentRunner /chat /code.
 *
 * On top of 3H20 (heartbeat/steal, per-tool timeout, DLQ jitter, gzip, tmpfs cap):
 *   1  DLQ replay hard max-attempts cap + poison
 *   2  fence steal metrics (stolen/refused/vacant)
 *   3  per-tool timeout defaults table (health)
 *   4  credit ceiling ENFORCEMENT stops generate
 *   5  SSE replay metrics accumulator (health)
 *   6  tmpfs cleanup on cancel
 *   7  gzip checkpoint versioning
 *   8  hash TTL sweep interval
 *   9  retrieve_memory tool throw fail-closed
 *  10  health probes for the new flags
 *
 * Pure helpers. Tests never need Redis, DeepSeek, or Fal.
 * Do not invent HMAC / MCP hosts / rotation / SANDBOX_NET_ALLOW secrets.
 */

const fs = require('fs');

const DLQ_MAX_ATTEMPTS = 3;
const HASH_SWEEP_INTERVAL_MS = 60_000;
const GZIP_VERSION = 1;
const TOOL_TIMEOUT_REQUIRED = Object.freeze([
  'execute_bash',
  'bash',
  'write_file',
  'edit_file',
  'apply_patch',
  'read_file',
  'list_files',
  'glob',
  'grep',
  'retrieve_memory',
  'execute_python',
  'default',
]);

const stealMetricsState = { stolen: 0, refused: 0, vacant: 0 };
const replayMetricsState = { dropped: 0, truncated: 0, kept: 0, windows: 0 };

function capDlqReplayAttempts(entry, { maxAttempts = DLQ_MAX_ATTEMPTS, attempt = null } = {}) {
  const n = Math.max(0, attempt != null ? Number(attempt) : (Number(entry && entry.retries) || 0));
  const cap = Math.max(1, Math.min(20, Number(maxAttempts) || DLQ_MAX_ATTEMPTS));
  if (entry && (entry.exhausted === true || String(entry.error || entry.code || '') === 'dlq_exhausted')) {
    return { ok: false, code: 'dlq_exhausted', delayMs: 0, retryAt: null, attempt: n, maxAttempts: cap };
  }
  if (n >= cap) {
    return { ok: false, code: 'dlq_poison', delayMs: 0, retryAt: null, attempt: n, maxAttempts: cap };
  }
  return { ok: true, attempt: n, remaining: cap - n, maxAttempts: cap };
}

function scheduleDlqReplayCapped(entry, opts = {}) {
  const gate = capDlqReplayAttempts(entry, opts);
  if (!gate.ok) return gate;
  let plan;
  try {
    plan = require('./engine-layer').scheduleDlqReplay(entry, opts);
  } catch (_) {
    return { ok: false, code: 'dlq_exhausted', delayMs: 0, retryAt: null };
  }
  if (!plan || !plan.ok) return plan || gate;
  const cap = gate.maxAttempts;
  if (Number(plan.attempt) > cap) {
    return { ok: false, code: 'dlq_poison', delayMs: 0, retryAt: null, attempt: plan.attempt, maxAttempts: cap };
  }
  return { ...plan, maxAttempts: cap, remaining: cap - Number(plan.attempt) };
}

function resetFenceStealMetrics() {
  stealMetricsState.stolen = 0;
  stealMetricsState.refused = 0;
  stealMetricsState.vacant = 0;
  return fenceStealMetrics();
}

function fenceStealMetrics() {
  return {
    stolen: stealMetricsState.stolen,
    refused: stealMetricsState.refused,
    vacant: stealMetricsState.vacant,
  };
}

function recordFenceSteal(result) {
  if (result && result.stolen) stealMetricsState.stolen += 1;
  else if (result && result.vacant) stealMetricsState.vacant += 1;
  else stealMetricsState.refused += 1;
  return { ...(result || {}), metrics: fenceStealMetrics() };
}

async function stealStaleFenceMetered(kv, sessionKey, opts) {
  const layer = require('./engine-layer');
  const out = await layer.stealStaleFence(kv, sessionKey, opts);
  return recordFenceSteal(out);
}

function toolTimeoutDefaultsTable() {
  let table = {};
  try {
    table = { ...require('./engine-layer').TOOL_TIMEOUTS_MS };
  } catch (_) {
    table = {};
  }
  const missing = TOOL_TIMEOUT_REQUIRED.filter((k) => table[k] == null || !Number.isFinite(Number(table[k])));
  const positive = Object.values(table).every((v) => Number(v) > 0 && Number(v) <= 120_000);
  return {
    table,
    ok: missing.length === 0 && positive,
    missing,
    code: missing.length || !positive ? 'timeout_table' : null,
  };
}

function enforceCreditCeiling(usage, ceiling) {
  const layer = require('./engine-layer');
  const out = layer.assertCreditCeiling(usage, ceiling);
  if (!out.ok) return { ...out, stop: true, code: 'credit_ceiling' };
  return { ...out, stop: false };
}

function resetReplayMetrics() {
  replayMetricsState.dropped = 0;
  replayMetricsState.truncated = 0;
  replayMetricsState.kept = 0;
  replayMetricsState.windows = 0;
  return replayMetricsSnapshot();
}

function replayMetricsSnapshot() {
  return {
    dropped: replayMetricsState.dropped,
    truncated: replayMetricsState.truncated,
    kept: replayMetricsState.kept,
    windows: replayMetricsState.windows,
  };
}

function recordReplayMetrics(capped) {
  let m;
  try {
    m = require('./engine-layer').replayWindowMetrics(capped);
  } catch (_) {
    m = {
      kept: Array.isArray(capped && capped.frames) ? capped.frames.length : 0,
      dropped: Number(capped && capped.dropped) || 0,
      truncated: Boolean(capped && capped.truncated),
      code: Number(capped && capped.dropped) > 0 ? 'replay_window' : null,
    };
  }
  replayMetricsState.dropped += Number(m.dropped) || 0;
  replayMetricsState.kept += Number(m.kept) || 0;
  replayMetricsState.windows += 1;
  if (m.truncated) replayMetricsState.truncated += 1;
  return {
    ...m,
    totalDropped: replayMetricsState.dropped,
    totalWindows: replayMetricsState.windows,
    totalTruncated: replayMetricsState.truncated,
  };
}

function isUnsafeTmpfsPath(p) {
  const s = String(p || '');
  if (!s || s.includes('\0')) return true;
  if (s.includes('..')) return true;
  return false;
}

function defaultUnlink(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function cleanupTmpfsOnCancel(paths, { unlink = defaultUnlink } = {}) {
  const list = Array.isArray(paths) ? paths : [];
  let cleaned = 0;
  const errors = [];
  for (const raw of list) {
    const s = String(raw || '');
    if (!s) continue;
    if (isUnsafeTmpfsPath(s)) {
      errors.push({ path: s, code: 'path_traversal' });
      continue;
    }
    try {
      unlink(s);
      cleaned += 1;
    } catch (_) {
      errors.push({ path: s, code: 'unlink_failed' });
    }
  }
  return {
    ok: true,
    cleaned,
    skipped: errors.length,
    code: 'tmpfs_cleanup',
    errors,
  };
}

function gzipCheckpointBlobVersioned(state, opts) {
  const layer = require('./engine-layer');
  const out = layer.gzipCheckpointBlob(state, opts);
  if (out && out.gzip && out.packed && typeof out.packed === 'object') {
    out.packed.__gzipVersion = GZIP_VERSION;
    out.version = GZIP_VERSION;
  } else if (out) {
    out.version = out.gzip ? GZIP_VERSION : 0;
  }
  return out;
}

function gunzipCheckpointBlobVersioned(state) {
  if (!state || typeof state !== 'object' || !state.__gzip) {
    return { ok: true, state, gzip: false, version: 0 };
  }
  if (state.__gzipVersion != null && state.__gzipVersion !== '') {
    const v = Number(state.__gzipVersion);
    if (!Number.isFinite(v) || v !== GZIP_VERSION) {
      return { ok: false, code: 'gzip_version', state: null, gzip: true, version: v };
    }
  }
  try {
    const inflated = require('./engine-layer').gunzipCheckpointBlob(state);
    if (inflated === state) {
      return { ok: false, code: 'gzip_corrupt', state: null, gzip: true, version: GZIP_VERSION };
    }
    return { ok: true, state: inflated, gzip: true, version: Number(state.__gzipVersion) || GZIP_VERSION };
  } catch (_) {
    return { ok: false, code: 'gzip_corrupt', state: null, gzip: true, version: GZIP_VERSION };
  }
}

function hashSweepDue(lastSweepAt, { now = Date.now(), intervalMs = HASH_SWEEP_INTERVAL_MS } = {}) {
  const last = Number(lastSweepAt) || 0;
  const iv = Math.max(1000, Number(intervalMs) || HASH_SWEEP_INTERVAL_MS);
  if (!last || (Number(now) - last) >= iv) {
    return { due: true, intervalMs: iv, waitedMs: last ? Number(now) - last : iv, code: 'hash_sweep' };
  }
  return { due: false, intervalMs: iv, waitedMs: Number(now) - last, code: null };
}

function sweepHashTtl(store, sweepState, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const check = hashSweepDue(sweepState && sweepState.lastSweepAt, {
    now,
    intervalMs: opts.intervalMs,
  });
  if (!check.due) return { swept: false, pruned: 0, remaining: store && store.size != null ? store.size : 0, ...check };
  let out = { pruned: 0, remaining: 0 };
  try {
    out = require('./engine-layer').pruneHashTtl(store, { now, ttlMs: opts.ttlMs });
  } catch (_) { /* optional */ }
  if (sweepState && typeof sweepState === 'object') sweepState.lastSweepAt = now;
  return {
    swept: true,
    pruned: Number(out.pruned) || 0,
    remaining: Number(out.remaining) || 0,
    lastSweepAt: now,
    code: (Number(out.pruned) || 0) > 0 ? 'hash_expired' : 'hash_sweep',
    intervalMs: check.intervalMs,
  };
}

async function retrieveMemoryToolFailClosed({ query, userId, chatId = null, store = null, recall = null } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: true, hits: [], failClosed: false };
  const run = async () => {
    if (typeof recall === 'function') return recall({ userId, chatId, query: q, store });
    if (store && typeof store.recall === 'function') return store.recall({ userId, chatId, query: q, k: 5 });
    return [];
  };
  try {
    const hits = await run();
    const list = Array.isArray(hits) ? hits : [];
    return { ok: true, hits: list, failClosed: false };
  } catch (err) {
    let pg = false;
    try { pg = require('./engine-layer').isPgvectorError(err); } catch (_) { pg = false; }
    if (pg) return { ok: false, hits: [], failClosed: true, code: 'pgvector_failed' };
    return { ok: false, hits: [], failClosed: true, code: 'retrieve_memory_failed' };
  }
}

function opsSnapshot() {
  return {
    dlqMaxAttempts: true,
    fenceStealMetrics: true,
    toolTimeoutTable: true,
    creditCeilingEnforce: true,
    sseReplayHealth: true,
    tmpfsCleanupCancel: true,
    gzipVersion: true,
    hashSweepInterval: true,
    retrieveMemoryFailClosed: true,
  };
}

module.exports = {
  DLQ_MAX_ATTEMPTS,
  HASH_SWEEP_INTERVAL_MS,
  GZIP_VERSION,
  TOOL_TIMEOUT_REQUIRED,
  capDlqReplayAttempts,
  scheduleDlqReplayCapped,
  resetFenceStealMetrics,
  fenceStealMetrics,
  recordFenceSteal,
  stealStaleFenceMetered,
  toolTimeoutDefaultsTable,
  enforceCreditCeiling,
  resetReplayMetrics,
  replayMetricsSnapshot,
  recordReplayMetrics,
  isUnsafeTmpfsPath,
  cleanupTmpfsOnCancel,
  gzipCheckpointBlobVersioned,
  gunzipCheckpointBlobVersioned,
  hashSweepDue,
  sweepHashTtl,
  retrieveMemoryToolFailClosed,
  opsSnapshot,
};
