'use strict';

/**
 * 3H20 — next engine layer for AgentRunner /chat /code.
 *
 * On top of 3H19 (coercion/fence/score/blob/net/replay/hash/audit/dlq/path):
 *   1  fence heartbeat + stale steal so a crashed pid cannot pin forever
 *   2  per-tool timeout overrides
 *   3  DLQ replay with exponential backoff + jitter
 *   4  memory score+recency hybrid; pgvector retrieve fail-closed
 *   5  checkpoint blob gzip
 *   6/7 sandbox tmpfs size cap
 *   8  SSE replay-window metrics + event-hash TTL cleanup
 *   9  (hash TTL is the queue/event hygiene layer)
 *  10  credit audit vs ledger reconciliation + turn ceiling
 *  11  classified ES codes
 *  12  health probes for the new flags
 *
 * Pure helpers. Tests never need Redis, DeepSeek, or Fal.
 * Do not invent HMAC / MCP hosts / rotation / SANDBOX_NET_ALLOW secrets.
 */

const zlib = require('zlib');
const crypto = require('crypto');

const FENCE_TTL_SEC = 30;
const REDIS_PREFIX = 'sira:engine:';
const GZIP_MIN_BYTES = 512;
const HASH_TTL_MS = 5 * 60 * 1000;
const RECENCY_HALF_LIFE_MS = 6 * 3600 * 1000;
const SCORE_MIN = 0.15;
const TMPFS_DEFAULT_MB = 64;
const STDOUT_MAX_BPS = 256 * 1024;
const DLQ_BASE_MS = 250;
const DLQ_MAX_DELAY_MS = 10_000;
const CREDIT_CEILING_DEFAULT = 200_000;

const TOOL_TIMEOUTS_MS = Object.freeze({
  execute_bash: 30_000,
  bash: 30_000,
  write_file: 8_000,
  edit_file: 8_000,
  apply_patch: 8_000,
  read_file: 5_000,
  list_files: 5_000,
  glob: 5_000,
  grep: 5_000,
  retrieve_memory: 4_000,
  execute_python: 20_000,
  default: 15_000,
});

function fenceKey(sessionKey) {
  return `${REDIS_PREFIX}fence:${String(sessionKey || '')}`;
}
function fenceHbKey(sessionKey) {
  return `${fenceKey(sessionKey)}:hb`;
}

async function heartbeatFence(kv, sessionKey, token, { ttlSec = FENCE_TTL_SEC, now = Date.now() } = {}) {
  const sk = String(sessionKey || '').trim();
  if (!sk || !kv || !token) return { ok: false, code: 'fence_expired', token: null };
  const key = fenceKey(sk);
  const ttl = Math.max(5, Math.min(120, Number(ttlSec) || FENCE_TTL_SEC));
  try {
    const cur = await kv.get(key);
    if (!cur || String(cur) !== String(token)) {
      return { ok: false, code: 'fence_expired', token: null };
    }
    if (typeof kv.set === 'function') {
      await kv.set(key, token, 'EX', ttl);
      await kv.set(fenceHbKey(sk), String(now), 'EX', ttl);
    }
    return { ok: true, refreshed: true, at: now };
  } catch (_) {
    return { ok: false, code: 'fence_expired', token: null };
  }
}

async function stealStaleFence(kv, sessionKey, { ttlSec = FENCE_TTL_SEC, now = Date.now() } = {}) {
  const sk = String(sessionKey || '').trim();
  if (!sk || !kv) return { ok: false, code: 'fence_conflict' };
  const key = fenceKey(sk);
  const ttl = Math.max(5, Math.min(120, Number(ttlSec) || FENCE_TTL_SEC));
  try {
    const cur = await kv.get(key);
    if (!cur) return { ok: true, stolen: false, vacant: true };
    const hbRaw = await kv.get(fenceHbKey(sk));
    const last = Number(hbRaw) || 0;
    const staleMs = ttl * 1000;
    // Missing heartbeat cannot prove a crash (pre-3H20 fence or just-acquired).
    // Only steal when a heartbeat exists and is older than TTL.
    if (!last) return { ok: false, code: 'fence_conflict', stolen: false };
    if ((Number(now) - last) < staleMs) {
      return { ok: false, code: 'fence_conflict', stolen: false };
    }
    if (typeof kv.del === 'function') {
      await kv.del(key);
      await kv.del(fenceHbKey(sk));
    }
    return { ok: true, stolen: true, code: 'fence_expired' };
  } catch (_) {
    return { ok: false, code: 'fence_conflict', stolen: false };
  }
}

function rankMemoryByScoreRecency(hits, {
  now = Date.now(),
  halfLifeMs = RECENCY_HALF_LIFE_MS,
  minScore = SCORE_MIN,
  scoreWeight = 0.7,
  recencyWeight = 0.3,
} = {}) {
  const list = Array.isArray(hits) ? hits : [];
  const hl = Math.max(1000, Number(halfLifeMs) || RECENCY_HALF_LIFE_MS);
  const floor = Number.isFinite(Number(minScore)) ? Number(minScore) : SCORE_MIN;
  const sw = Number.isFinite(Number(scoreWeight)) ? Number(scoreWeight) : 0.7;
  const rw = Number.isFinite(Number(recencyWeight)) ? Number(recencyWeight) : 0.3;
  const ranked = [];
  for (const h of list) {
    if (h == null) continue;
    if (typeof h !== 'object') {
      ranked.push({ text: String(h), hybrid: 0.5, recency: 1, score: null });
      continue;
    }
    const rawScore = h.score != null ? h.score : h.similarity;
    const hasScore = rawScore != null && rawScore !== '';
    const score = hasScore ? Number(rawScore) : null;
    if (hasScore && Number.isFinite(score) && score < floor) continue;
    const at = Number(h.at || h.ts || h.createdAt || h.updatedAt) || now;
    const age = Math.max(0, Number(now) - at);
    const recency = Math.pow(0.5, age / hl);
    const s = Number.isFinite(score) ? score : 0.5;
    const hybrid = s * sw + recency * rw;
    ranked.push({ ...h, hybrid, recency, score: Number.isFinite(score) ? score : undefined });
  }
  ranked.sort((a, b) => Number(b.hybrid) - Number(a.hybrid));
  return ranked;
}

function isPgvectorError(err) {
  if (!err) return false;
  const code = String(err.code || '').toLowerCase();
  if (code === 'pgvector_failed' || code === 'pgvector' || code === '22p02') return true;
  const msg = String(err.message || '');
  return /pgvector|vector\s*(search|store|index)|embedding.*(fail|error)|hnsw/i.test(msg);
}

async function retrieveMemoryFailClosed({ query, userId, chatId = null, store = null, recall = null } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: true, hits: [], failClosed: false };
  const run = async (fn) => {
    try {
      const hits = await fn();
      const list = Array.isArray(hits) ? hits : [];
      return { ok: true, hits: list, failClosed: false };
    } catch (err) {
      if (isPgvectorError(err)) {
        return { ok: false, hits: [], failClosed: true, code: 'pgvector_failed', error: 'pgvector' };
      }
      return { ok: true, hits: [], failClosed: false, recovered: true };
    }
  };
  if (typeof recall === 'function') {
    return run(() => recall({ userId, chatId, query: q, store }));
  }
  if (store && typeof store.recall === 'function') {
    return run(() => store.recall({ userId, chatId, query: q, k: 5 }));
  }
  return { ok: true, hits: [], failClosed: false };
}

function gzipCheckpointBlob(state, { minBytes = GZIP_MIN_BYTES } = {}) {
  if (state && typeof state === 'object' && state.__gzip) {
    return { packed: state, gzip: true, already: true, bytes: 0 };
  }
  let json;
  try { json = JSON.stringify(state == null ? {} : state); } catch (_) {
    return { packed: state && typeof state === 'object' ? state : {}, gzip: false, bytes: 0 };
  }
  const rawBytes = Buffer.byteLength(json, 'utf8');
  const floor = Math.max(64, Number(minBytes) || GZIP_MIN_BYTES);
  if (rawBytes < floor) return { packed: state, gzip: false, bytes: rawBytes, rawBytes };
  try {
    const gz = zlib.gzipSync(Buffer.from(json, 'utf8'));
    return {
      packed: { __gzip: true, b64: gz.toString('base64'), rawBytes },
      gzip: true,
      bytes: gz.length,
      rawBytes,
    };
  } catch (_) {
    return { packed: state, gzip: false, bytes: rawBytes, rawBytes };
  }
}

function gunzipCheckpointBlob(state) {
  if (!state || typeof state !== 'object' || !state.__gzip) return state;
  try {
    const buf = Buffer.from(String(state.b64 || ''), 'base64');
    const json = zlib.gunzipSync(buf).toString('utf8');
    return JSON.parse(json);
  } catch (_) {
    return state;
  }
}

function replayWindowMetrics(capped) {
  const frames = capped && Array.isArray(capped.frames) ? capped.frames : [];
  const dropped = Number(capped && capped.dropped) || 0;
  const truncated = Boolean(capped && capped.truncated);
  let oldestAt = null;
  let newestAt = null;
  for (const f of frames) {
    const at = Number(f && f.at);
    if (!Number.isFinite(at)) continue;
    if (oldestAt == null || at < oldestAt) oldestAt = at;
    if (newestAt == null || at > newestAt) newestAt = at;
  }
  return {
    kept: frames.length,
    dropped,
    truncated,
    oldestAt,
    newestAt,
    code: dropped > 0 ? 'replay_window' : null,
  };
}

function pruneHashTtl(store, { now = Date.now(), ttlMs = HASH_TTL_MS } = {}) {
  const ttl = Math.max(1000, Number(ttlMs) || HASH_TTL_MS);
  const cut = Number(now) - ttl;
  let pruned = 0;
  if (!store) return { pruned: 0, remaining: 0 };
  if (store instanceof Map) {
    for (const [hash, at] of store) {
      if (Number(at) < cut) {
        store.delete(hash);
        pruned += 1;
      }
    }
    return { pruned, remaining: store.size };
  }
  if (typeof store.forEach === 'function' && typeof store.delete === 'function') {
    const gone = [];
    store.forEach((at, hash) => {
      if (Number(at) < cut) gone.push(hash);
    });
    for (const h of gone) {
      store.delete(h);
      pruned += 1;
    }
    return { pruned, remaining: typeof store.size === 'number' ? store.size : 0 };
  }
  return { pruned: 0, remaining: 0 };
}

function rememberHashTtl(store, hash, { now = Date.now() } = {}) {
  if (!store || !hash) return { duplicate: false, hash: '' };
  pruneHashTtl(store, { now });
  if (store.has(hash)) return { duplicate: true, hash, code: 'duplicate_event' };
  store.set(hash, Number(now));
  return { duplicate: false, hash };
}

function reconcileAuditVsLedger(auditEntries, ledger, { toleranceTokens = 0 } = {}) {
  const list = Array.isArray(auditEntries) ? auditEntries : [];
  let auditPrompt = 0;
  let auditCompletion = 0;
  for (const e of list) {
    auditPrompt += Number(e && e.promptTokens) || 0;
    auditCompletion += Number(e && e.completionTokens) || 0;
  }
  const lp = Number(ledger && ledger.promptTokens) || 0;
  const lc = Number(ledger && ledger.completionTokens) || 0;
  const auditTotal = auditPrompt + auditCompletion;
  const ledgerTotal = lp + lc;
  const delta = auditTotal - ledgerTotal;
  const tol = Math.max(0, Number(toleranceTokens) || 0);
  if (Math.abs(delta) <= tol) {
    return { ok: true, action: 'ok', delta: 0, auditTotal, ledgerTotal };
  }
  if (delta > tol) {
    return {
      ok: false,
      code: 'credit_mismatch',
      action: 'ledger_behind',
      delta,
      auditTotal,
      ledgerTotal,
    };
  }
  return {
    ok: true,
    action: 'no_double_charge',
    delta,
    auditTotal,
    ledgerTotal,
  };
}

function assertCreditCeiling(usage, ceiling = CREDIT_CEILING_DEFAULT) {
  const cap = ceiling == null ? null : Number(ceiling);
  const prompt = Number(usage && usage.promptTokens) || 0;
  const completion = Number(usage && usage.completionTokens) || 0;
  const total = prompt + completion;
  if (cap == null || !Number.isFinite(cap)) return { ok: true, remaining: null, total };
  if (total > cap) return { ok: false, code: 'credit_ceiling', total, remaining: 0, cap };
  return { ok: true, remaining: cap - total, total, cap };
}

function toolTimeoutMs(name, overrides = {}) {
  const n = String(name || '');
  if (overrides && overrides[n] != null) {
    const v = Number(overrides[n]);
    if (Number.isFinite(v) && v > 0) return Math.max(1, Math.min(120_000, v));
  }
  if (TOOL_TIMEOUTS_MS[n] != null) return TOOL_TIMEOUTS_MS[n];
  return TOOL_TIMEOUTS_MS.default;
}

async function withToolTimeout(fn, ms, signal) {
  if (signal && signal.aborted) {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  }
  const cap = Math.max(1, Number(ms) || TOOL_TIMEOUTS_MS.default);
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('tool_timeout');
      err.code = 'tool_timeout';
      reject(err);
    }, cap);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => fn(signal)),
      timeoutPromise,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sandboxTmpfsCap({ env = process.env, maxMb = null } = {}) {
  const raw = maxMb != null ? maxMb : (env && env.SIRAGPT_SANDBOX_TMPFS_MB);
  const n = Number(raw);
  const mb = Number.isFinite(n) && n > 0 ? Math.max(8, Math.min(512, Math.floor(n))) : TMPFS_DEFAULT_MB;
  return { maxMb: mb, maxBytes: mb * 1024 * 1024 };
}

function assertTmpfsBudget(usedBytes, addBytes, cap) {
  const c = cap && cap.maxBytes != null ? cap : sandboxTmpfsCap();
  const used = Math.max(0, Number(usedBytes) || 0);
  const add = Math.max(0, Number(addBytes) || 0);
  const next = used + add;
  if (next > Number(c.maxBytes)) {
    return { ok: false, code: 'tmpfs_exceeded', used, add, remaining: 0, maxBytes: c.maxBytes };
  }
  return { ok: true, used, add, remaining: Number(c.maxBytes) - next, maxBytes: c.maxBytes };
}

function scheduleDlqReplay(entry, {
  attempt = null,
  now = Date.now(),
  baseMs = DLQ_BASE_MS,
  jitter = true,
  random = Math.random,
} = {}) {
  if (entry && (entry.exhausted === true || String(entry.error || entry.code || '') === 'dlq_exhausted')) {
    return { ok: false, code: 'dlq_exhausted', delayMs: 0, retryAt: null };
  }
  const n = Math.max(0, attempt != null ? Number(attempt) : (Number(entry && entry.retries) || 0));
  const base = Math.max(10, Number(baseMs) || DLQ_BASE_MS);
  const exp = Math.min(DLQ_MAX_DELAY_MS, base * (2 ** n));
  const j = jitter ? Math.floor((Number(random()) || 0) * (exp * 0.25)) : 0;
  const delayMs = exp + j;
  return {
    ok: true,
    code: 'dlq_replay',
    delayMs,
    retryAt: Number(now) + delayMs,
    attempt: n + 1,
  };
}

function capStdoutRate({ bytes, elapsedMs, maxBytesPerSec = STDOUT_MAX_BPS } = {}) {
  const b = Math.max(0, Number(bytes) || 0);
  const t = Math.max(0, Number(elapsedMs) || 0);
  const cap = Math.max(1024, Number(maxBytesPerSec) || STDOUT_MAX_BPS);
  const rate = t > 0 ? (b / t) * 1000 : b;
  if (rate > cap) {
    return { ok: false, code: 'stdout_rate', truncated: true, rate, maxBytesPerSec: cap };
  }
  return { ok: true, truncated: false, rate, maxBytesPerSec: cap };
}

function assertToolEnum(schema, args) {
  const spec = schema && typeof schema === 'object' ? schema : null;
  const value = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (!spec) return { ok: true, value };
  const props = spec.properties && typeof spec.properties === 'object' ? spec.properties : {};
  if (Array.isArray(spec.enum) && spec.enum.length && !spec.enum.includes(value)) {
    return { ok: false, code: 'coercion_rejected', error: 'enum' };
  }
  for (const [k, p] of Object.entries(props)) {
    if (!p || !Array.isArray(p.enum) || !p.enum.length) continue;
    if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
    if (!p.enum.includes(value[k])) {
      return { ok: false, code: 'coercion_rejected', error: `enum:${k}` };
    }
  }
  return { ok: true, value };
}

function layerSnapshot() {
  return {
    fenceHeartbeat: true,
    staleFenceSteal: true,
    scoreRecency: true,
    blobGzip: true,
    replayMetrics: true,
    hashTtl: true,
    auditLedger: true,
    toolTimeoutOverride: true,
    tmpfsCap: true,
    dlqReplay: true,
    pgvectorFailClosed: true,
    creditCeiling: true,
  };
}

module.exports = {
  FENCE_TTL_SEC,
  REDIS_PREFIX,
  GZIP_MIN_BYTES,
  HASH_TTL_MS,
  RECENCY_HALF_LIFE_MS,
  TMPFS_DEFAULT_MB,
  TOOL_TIMEOUTS_MS,
  CREDIT_CEILING_DEFAULT,
  heartbeatFence,
  stealStaleFence,
  rankMemoryByScoreRecency,
  isPgvectorError,
  retrieveMemoryFailClosed,
  gzipCheckpointBlob,
  gunzipCheckpointBlob,
  replayWindowMetrics,
  pruneHashTtl,
  rememberHashTtl,
  reconcileAuditVsLedger,
  assertCreditCeiling,
  toolTimeoutMs,
  withToolTimeout,
  sandboxTmpfsCap,
  assertTmpfsBudget,
  scheduleDlqReplay,
  capStdoutRate,
  assertToolEnum,
  layerSnapshot,
};
