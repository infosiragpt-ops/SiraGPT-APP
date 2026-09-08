'use strict';

/**
 * 3H19 — next engine layer for AgentRunner /chat /code.
 *
 * On top of 3H18 (schema fail-closed / resume lock / ACL / gap fill):
 *   2  tool-call argument coercion + bounds (maxLength / maxItems / min / max)
 *   3  dead-letter after N retries of the same tool
 *   1/5 session fence SET NX across two backend processes
 *   4  memory retrieve score threshold
 *   5  checkpoint blob compaction
 *   6  path traversal reject
 *   7  sandbox network deny-by-default if allowlist missing
 *   8  SSE replay window cap + event content hash drop-dup
 *   9  gateway event-hash duplicate
 *  10  credit audit log (append-only, never double-charge)
 *  11  classified ES codes
 *  12  health probes for the new flags
 *
 * Pure helpers. Tests never need Redis, DeepSeek, or Fal.
 * Do not invent HMAC / MCP hosts / rotation secrets.
 */

const crypto = require('crypto');

const MAX_STRING_CHARS = 32 * 1024;
const MAX_ARRAY_ITEMS = 256;
const MAX_OBJECT_KEYS = 64;
const MAX_DEPTH = 8;
const DLQ_MAX_RETRIES = 3;
const FENCE_TTL_SEC = 30;
const SCORE_MIN = 0.15;
const BLOB_MAX_CHARS = 8 * 1024;
const REPLAY_WINDOW_MAX = 100;
const REPLAY_WINDOW_MS = 5 * 60 * 1000;
const REDIS_PREFIX = 'sira:engine:';
const NUMERIC_ABS_MAX = 1e15;

function fenceKey(sessionKey) {
  return `${REDIS_PREFIX}fence:${String(sessionKey || '')}`;
}

function newToken() {
  try { return crypto.randomBytes(12).toString('hex'); } catch (_) {
    return `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

function inferType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number' && Number.isInteger(value)) return 'integer';
  return t;
}

function coerceNode(spec, value, depth, b) {
  if (depth > b.maxDepth) {
    const err = new Error('depth');
    err.code = 'coercion_rejected';
    throw err;
  }
  const t = spec && spec.type;
  if (t === 'string' || (!t && typeof value === 'string')) {
    let s;
    if (typeof value === 'string') s = value;
    else if (typeof value === 'number' || typeof value === 'boolean') s = String(value);
    else {
      const err = new Error('type:string');
      err.code = 'coercion_rejected';
      throw err;
    }
    const cap = Number(spec && spec.maxLength) > 0 ? Number(spec.maxLength) : b.maxStr;
    if (s.length > cap) {
      const err = new Error(`maxLength:${s.length}`);
      err.code = 'coercion_rejected';
      throw err;
    }
    if (spec && Number(spec.minLength) > 0 && s.length < Number(spec.minLength)) {
      const err = new Error(`minLength:${s.length}`);
      err.code = 'coercion_rejected';
      throw err;
    }
    return s;
  }
  if (t === 'number' || t === 'integer') {
    let n;
    if (typeof value === 'number' && Number.isFinite(value)) n = value;
    else if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) n = Number(value);
    else {
      const err = new Error(`type:${t}`);
      err.code = 'coercion_rejected';
      throw err;
    }
    if (t === 'integer' && !Number.isInteger(n)) n = Math.trunc(n);
    if (!Number.isFinite(n) || Math.abs(n) > NUMERIC_ABS_MAX) {
      const err = new Error('numeric_bounds');
      err.code = 'coercion_rejected';
      throw err;
    }
    if (spec && spec.minimum != null && n < Number(spec.minimum)) {
      const err = new Error(`minimum:${n}`);
      err.code = 'coercion_rejected';
      throw err;
    }
    if (spec && spec.maximum != null && n > Number(spec.maximum)) {
      const err = new Error(`maximum:${n}`);
      err.code = 'coercion_rejected';
      throw err;
    }
    return n;
  }
  if (t === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 1) return true;
    if (value === 'false' || value === 0) return false;
    const err = new Error('type:boolean');
    err.code = 'coercion_rejected';
    throw err;
  }
  if (t === 'array' || (!t && Array.isArray(value))) {
    if (!Array.isArray(value)) {
      const err = new Error('type:array');
      err.code = 'coercion_rejected';
      throw err;
    }
    const cap = Number(spec && spec.maxItems) > 0 ? Number(spec.maxItems) : b.maxArr;
    if (value.length > cap) {
      const err = new Error(`maxItems:${value.length}`);
      err.code = 'coercion_rejected';
      throw err;
    }
    const itemSpec = (spec && spec.items) || {};
    return value.map((v) => coerceNode(itemSpec, v, depth + 1, b));
  }
  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value).filter((k) => !String(k).startsWith('__'));
    if (keys.length > b.maxKeys) {
      const err = new Error(`maxKeys:${keys.length}`);
      err.code = 'coercion_rejected';
      throw err;
    }
    const out = {};
    const props = (spec && spec.properties) || {};
    for (const k of keys) {
      const childSpec = props[k] || { type: inferType(value[k]) };
      out[k] = coerceNode(childSpec, value[k], depth + 1, b);
    }
    return out;
  }
  if (!t) return value;
  const err = new Error(`type:${t}`);
  err.code = 'coercion_rejected';
  throw err;
}

function coerceToolArgs(schema, args, bounds = {}) {
  if (args && typeof args === 'object' && args.__parse_error) {
    return { ok: false, code: 'tool_args_invalid', error: 'parse_error' };
  }
  const b = {
    maxStr: Math.max(16, Number(bounds.maxStringChars) || MAX_STRING_CHARS),
    maxArr: Math.max(1, Number(bounds.maxArrayItems) || MAX_ARRAY_ITEMS),
    maxKeys: Math.max(1, Number(bounds.maxObjectKeys) || MAX_OBJECT_KEYS),
    maxDepth: Math.max(1, Number(bounds.maxDepth) || MAX_DEPTH),
  };
  const value = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const spec = schema && typeof schema === 'object' ? schema : { type: 'object' };
  try {
    const coerced = coerceNode(spec, value, 0, b);
    return { ok: true, value: coerced, coerced: true };
  } catch (err) {
    return {
      ok: false,
      code: 'coercion_rejected',
      error: String((err && err.message) || 'bounds'),
    };
  }
}

function createRetryTracker({ maxRetries = DLQ_MAX_RETRIES } = {}) {
  const counts = new Map();
  const cap = Math.max(1, Math.min(20, Number(maxRetries) || DLQ_MAX_RETRIES));
  return {
    maxRetries: cap,
    fingerprint(tool) {
      return `tool:${String(tool || '')}`;
    },
    recordFailure(fp) {
      const key = String(fp || '');
      const n = (counts.get(key) || 0) + 1;
      counts.set(key, n);
      return { count: n, exhausted: n >= cap };
    },
    shouldDeadLetter(fp) {
      return (counts.get(String(fp || '')) || 0) >= cap;
    },
    count(fp) { return counts.get(String(fp || '')) || 0; },
    reset(fp) { counts.delete(String(fp || '')); },
  };
}

function createSessionFence(kv, { ttlSec = FENCE_TTL_SEC } = {}) {
  const ttl = Math.max(5, Math.min(120, Number(ttlSec) || FENCE_TTL_SEC));
  return {
    ttlSec: ttl,
    async acquire(sessionKey) {
      const sk = String(sessionKey || '').trim();
      if (!sk || !kv) return { ok: false, code: 'fence_conflict', token: null };
      const key = fenceKey(sk);
      const token = newToken();
      try {
        if (typeof kv.setNx === 'function') {
          const set = await kv.setNx(key, token, ttl);
          if (set) return { ok: true, token, key };
          return { ok: false, code: 'fence_conflict', token: null };
        }
        const existing = await kv.get(key);
        if (existing) return { ok: false, code: 'fence_conflict', token: null };
        if (typeof kv.set === 'function') await kv.set(key, token, 'EX', ttl);
        return { ok: true, token, key };
      } catch (_) {
        return { ok: false, code: 'fence_conflict', token: null };
      }
    },
    async release(sessionKey, token) {
      const sk = String(sessionKey || '').trim();
      if (!sk || !kv || !token) return false;
      const key = fenceKey(sk);
      try {
        const cur = await kv.get(key);
        if (cur && String(cur) === String(token)) {
          if (typeof kv.del === 'function') await kv.del(key);
          return true;
        }
      } catch (_) { /* ignore */ }
      return false;
    },
  };
}

async function assertFenceSafe({ fence, sessionKey } = {}) {
  if (!fence || typeof fence.acquire !== 'function') {
    return { ok: true, token: null, skipped: true };
  }
  const got = await fence.acquire(sessionKey);
  if (!got.ok) {
    const err = new Error('fence_conflict');
    err.code = 'fence_conflict';
    return { ok: false, code: 'fence_conflict', token: null, error: err };
  }
  return { ok: true, token: got.token, skipped: false };
}

function filterMemoryByScore(hits, { minScore = SCORE_MIN } = {}) {
  const min = Number(minScore);
  const floor = Number.isFinite(min) ? min : SCORE_MIN;
  const list = Array.isArray(hits) ? hits : [];
  return list.filter((h) => {
    if (h == null) return false;
    if (typeof h !== 'object') return true;
    const s = h.score != null ? h.score : h.similarity;
    if (s == null || s === '') return true;
    const n = Number(s);
    if (!Number.isFinite(n)) return true;
    return n >= floor;
  });
}

function compactCheckpointBlobs(state, { maxChars = BLOB_MAX_CHARS } = {}) {
  const cap = Math.max(256, Number(maxChars) || BLOB_MAX_CHARS);
  if (!state || typeof state !== 'object') return { state: {}, compacted: false, droppedBytes: 0 };
  const out = Array.isArray(state) ? state.slice() : { ...state };
  let droppedBytes = 0;
  let compacted = false;
  const msgs = Array.isArray(out.messages) ? out.messages : null;
  if (msgs) {
    out.messages = msgs.map((m) => {
      if (!m || typeof m !== 'object') return m;
      const copy = { ...m };
      if (typeof copy.content === 'string' && copy.content.length > cap) {
        droppedBytes += copy.content.length - cap;
        compacted = true;
        copy.content = `${copy.content.slice(0, cap)}\n[blob_compacted ${copy.content.length - cap} chars]`;
      }
      return copy;
    });
  }
  return { state: out, compacted, droppedBytes };
}

function sandboxNetworkPolicy({ allow = null, env = process.env } = {}) {
  const raw = allow != null ? allow : (env && env.SIRAGPT_SANDBOX_NET_ALLOW);
  const hosts = String(raw || '')
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!hosts.length) return { mode: 'deny-all', hosts: [], deniedDefault: true };
  return { mode: 'allowlist', hosts, deniedDefault: false };
}

function assertSandboxNetwork(host, policy) {
  const p = policy || sandboxNetworkPolicy();
  const h = String(host || '').trim().toLowerCase();
  if (!h) return { ok: false, code: 'network_denied', error: 'empty_host' };
  if (p.mode === 'deny-all') return { ok: false, code: 'network_denied', error: 'deny_default' };
  if (!p.hosts.includes(h)) return { ok: false, code: 'network_denied', error: `not_allowed:${h}` };
  return { ok: true, host: h };
}

function capSseReplayWindow(frames, { max = REPLAY_WINDOW_MAX, maxAgeMs = REPLAY_WINDOW_MS, now = Date.now() } = {}) {
  const list = Array.isArray(frames) ? frames.slice() : [];
  const cap = Math.max(1, Number(max) || REPLAY_WINDOW_MAX);
  const age = Math.max(1000, Number(maxAgeMs) || REPLAY_WINDOW_MS);
  const cut = Number(now) - age;
  const aged = list.filter((f) => Number(f && f.at != null ? f.at : now) >= cut);
  const kept = aged.length > cap ? aged.slice(-cap) : aged;
  return {
    frames: kept,
    truncated: kept.length !== list.length,
    dropped: list.length - kept.length,
  };
}

function stablePayload(frame) {
  if (!frame || typeof frame !== 'object') return String(frame || '');
  const skip = { seq: true, at: true, id: true };
  const keys = Object.keys(frame).filter((k) => !skip[k]).sort();
  const obj = {};
  for (const k of keys) obj[k] = frame[k];
  try { return JSON.stringify(obj); } catch (_) { return String(frame.type || ''); }
}

function eventContentHash(sessionKey, frame) {
  const sk = String(sessionKey || '');
  const seq = frame && frame.seq != null ? Number(frame.seq) : '';
  const type = String((frame && frame.type) || '');
  const raw = `${sk}|${seq}|${type}|${stablePayload(frame)}`;
  try { return crypto.createHash('sha256').update(raw).digest('hex'); } catch (_) {
    return `${sk}:${seq}:${type}`;
  }
}

function dropDuplicateByHash(seen, sessionKey, frame) {
  const hash = eventContentHash(sessionKey, frame);
  if (!hash) return { duplicate: false, hash: '' };
  if (seen && typeof seen.has === 'function' && seen.has(hash)) {
    return { duplicate: true, hash, code: 'duplicate_event' };
  }
  if (seen && typeof seen.add === 'function') seen.add(hash);
  return { duplicate: false, hash };
}

function createCreditAuditLog({ max = 200 } = {}) {
  const items = [];
  const seen = new Set();
  const cap = Math.max(10, Number(max) || 200);
  function keyOf(streamId, prompt, completion) {
    return `${streamId}:${prompt}:${completion}`;
  }
  return {
    append(entry) {
      const streamId = String((entry && entry.streamId) || '');
      const prompt = Number(entry && entry.promptTokens) || 0;
      const completion = Number(entry && entry.completionTokens) || 0;
      const k = keyOf(streamId, prompt, completion);
      if (streamId && seen.has(k)) {
        return { recorded: false, action: 'audit_skip', reason: 'duplicate_charge' };
      }
      const rec = {
        streamId,
        userId: entry && entry.userId ? String(entry.userId) : null,
        promptTokens: prompt,
        completionTokens: completion,
        action: String((entry && entry.action) || 'charge'),
        at: Number(entry && entry.at) || Date.now(),
      };
      if (streamId) seen.add(k);
      items.push(rec);
      while (items.length > cap) {
        const gone = items.shift();
        if (gone) seen.delete(keyOf(gone.streamId, gone.promptTokens, gone.completionTokens));
      }
      return { recorded: true, action: 'audit_append', rec };
    },
    list({ streamId, limit = 50 } = {}) {
      const capList = Math.max(1, Math.min(cap, Number(limit) || 50));
      let filtered = items.slice();
      if (streamId) filtered = filtered.filter((i) => i.streamId === String(streamId));
      return filtered.slice(-capList);
    },
    snapshot() { return { count: items.length }; },
    clear() { items.length = 0; seen.clear(); },
  };
}

const defaultAudit = createCreditAuditLog();
function auditUsage(entry) {
  return defaultAudit.append(entry);
}

function rejectPathTraversal(p) {
  const s = String(p == null ? '' : p);
  if (!s || s === '.' || s === './' || s === '/workspace' || s === '/workspace/') {
    return { ok: true };
  }
  if (s.indexOf('\0') !== -1) return { ok: false, code: 'path_traversal', error: 'nul' };
  if (s.split(/[\\/]/).includes('..') || s.includes('..')) {
    return { ok: false, code: 'path_traversal', error: 'dotdot' };
  }
  if (/^[a-zA-Z]:[\\/]/.test(s)) return { ok: false, code: 'path_traversal', error: 'windows_abs' };
  if (s.startsWith('/') && !s.startsWith('/workspace/') && s !== '/workspace') {
    return { ok: false, code: 'path_traversal', error: 'absolute' };
  }
  return { ok: true };
}

function nextLayerSnapshot() {
  return {
    coercionBounds: true,
    deadLetterRetry: true,
    sessionFence: true,
    scoreThreshold: true,
    blobCompact: true,
    networkDeny: true,
    replayWindow: true,
    creditAudit: true,
    eventHash: true,
    pathTraversal: true,
  };
}

module.exports = {
  MAX_STRING_CHARS,
  MAX_ARRAY_ITEMS,
  DLQ_MAX_RETRIES,
  FENCE_TTL_SEC,
  SCORE_MIN,
  BLOB_MAX_CHARS,
  REPLAY_WINDOW_MAX,
  REPLAY_WINDOW_MS,
  REDIS_PREFIX,
  coerceToolArgs,
  createRetryTracker,
  createSessionFence,
  assertFenceSafe,
  filterMemoryByScore,
  compactCheckpointBlobs,
  sandboxNetworkPolicy,
  assertSandboxNetwork,
  capSseReplayWindow,
  eventContentHash,
  dropDuplicateByHash,
  createCreditAuditLog,
  auditUsage,
  rejectPathTraversal,
  nextLayerSnapshot,
};
