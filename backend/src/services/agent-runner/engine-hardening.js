'use strict';

/**
 * 3H18 — next engine layer for AgentRunner /chat /code.
 *
 * On top of 3H16 (repair/retry/cut) and 3H17 (durable ckpt/retrieve/heartbeat):
 *   2  tool schema fail-closed (required / types / additionalProperties)
 *   3  subagent isolation (own messages, sliced budget, tool allowlist)
 *   4  memory ACL by userId (tagged hits never leak across users)
 *   5  checkpoint TTL expiry + concurrent resume lock (SET NX)
 *   6  symlink / binary write reject
 *   7  sandbox CPU/mem limits with cgroup detect + ulimit fallback
 *   8  SSE Last-Event-ID gap fill
 *   9  idempotent gateway events + queue idempotencyKey
 *  10  credit/token ledger vs redis drift (never double-charge)
 *  11  classified ES codes for the new failures
 *  12  tool-exec latency samples (scripted, no paid Flash)
 *
 * Pure helpers. Tests never need Redis, DeepSeek, or Fal.
 */

const crypto = require('crypto');
const fs = require('fs');

const RESUME_LOCK_TTL_SEC = 60;
const REDIS_PREFIX = 'sira:engine:';
const DEFAULT_CPU_MS = 120_000;
const DEFAULT_MEM_MB = 512;

function resumeLockKey(threadId) {
  return `${REDIS_PREFIX}resume-lock:${String(threadId || '')}`;
}

function newLockToken() {
  try { return crypto.randomBytes(12).toString('hex'); } catch (_) {
    return `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

function createResumeLock(kv, { ttlSec = RESUME_LOCK_TTL_SEC } = {}) {
  const ttl = Math.max(5, Math.min(300, Number(ttlSec) || RESUME_LOCK_TTL_SEC));
  return {
    ttlSec: ttl,
    async acquire(threadId) {
      const tid = String(threadId || '').trim();
      if (!tid || !kv) return { ok: false, code: 'resume_conflict', token: null };
      const key = resumeLockKey(tid);
      const token = newLockToken();
      try {
        if (typeof kv.setNx === 'function') {
          const set = await kv.setNx(key, token, ttl);
          if (set) return { ok: true, token, key };
          return { ok: false, code: 'resume_conflict', token: null };
        }
        const existing = await kv.get(key);
        if (existing) return { ok: false, code: 'resume_conflict', token: null };
        if (typeof kv.set === 'function') {
          await kv.set(key, token, 'EX', ttl);
        }
        return { ok: true, token, key };
      } catch (_) {
        return { ok: false, code: 'resume_conflict', token: null };
      }
    },
    async release(threadId, token) {
      const tid = String(threadId || '').trim();
      if (!tid || !kv || !token) return false;
      const key = resumeLockKey(tid);
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

async function assertResumeSafe({ lock, threadId } = {}) {
  if (!lock || typeof lock.acquire !== 'function') {
    return { ok: true, token: null, skipped: true };
  }
  const got = await lock.acquire(threadId);
  if (!got.ok) {
    const err = new Error('resume_conflict');
    err.code = 'resume_conflict';
    return { ok: false, code: 'resume_conflict', token: null, error: err };
  }
  return { ok: true, token: got.token, skipped: false };
}

function toolSchemaFor(tools, name) {
  const n = String(name || '');
  if (!n || !Array.isArray(tools)) return null;
  for (const t of tools) {
    const fn = t && t.function ? t.function : t;
    if (fn && String(fn.name || '') === n) {
      return fn.parameters || fn.schema || null;
    }
  }
  return null;
}

function typeOk(specType, value) {
  if (!specType) return true;
  const t = String(specType);
  if (t === 'string') return typeof value === 'string';
  if (t === 'integer') return Number.isInteger(Number(value)) && value !== true && value !== false && value !== '';
  if (t === 'number') return Number.isFinite(Number(value)) && value !== true && value !== false && value !== '';
  if (t === 'boolean') return typeof value === 'boolean';
  if (t === 'array') return Array.isArray(value);
  if (t === 'object') return value != null && typeof value === 'object' && !Array.isArray(value);
  return true;
}

function validateToolArgs(schema, args) {
  if (args && typeof args === 'object' && args.__parse_error) {
    return { ok: false, code: 'tool_args_invalid', error: 'parse_error' };
  }
  if (!schema || typeof schema !== 'object') {
    return { ok: true, value: args && typeof args === 'object' ? args : {}, skipped: true };
  }
  const value = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const allowAdditional = schema.additionalProperties === true;

  for (const key of required) {
    const v = value[key];
    if (v == null || (typeof v === 'string' && !v.trim())) {
      return { ok: false, code: 'schema_invalid', error: `missing:${key}` };
    }
  }
  for (const [key, v] of Object.entries(value)) {
    if (String(key).startsWith('__')) continue;
    const spec = props[key];
    if (!spec && !allowAdditional) {
      return { ok: false, code: 'schema_invalid', error: `unexpected:${key}` };
    }
    if (spec && spec.type && !typeOk(spec.type, v)) {
      return { ok: false, code: 'schema_invalid', error: `type:${key}` };
    }
  }
  return { ok: true, value };
}

function sliceSubagentBudget(parentRemaining, { max = 8, fraction = 0.25 } = {}) {
  const n = Math.max(0, Number(parentRemaining) || 0);
  const sliced = Math.floor(n * (Number(fraction) || 0.25));
  const cap = Math.max(1, Math.min(Number(max) || 8, 40));
  if (n <= 0) return 1;
  return Math.max(1, Math.min(cap, sliced || Math.min(cap, n)));
}

function createSubagentContext({
  parentMessages = [],
  parentBudgetRemaining = 40,
  pins = [],
  allowTools = null,
  subagentId = null,
} = {}) {
  const messages = Array.isArray(parentMessages)
    ? parentMessages.map((m) => (m && typeof m === 'object' ? { ...m } : m))
    : [];
  const allowed = new Set(
    Array.isArray(allowTools) && allowTools.length
      ? allowTools
      : ['read_file', 'list_files', 'glob', 'grep', 'retrieve_memory'],
  );
  const id = String(subagentId || `sub_${Date.now()}`);
  return {
    id,
    messages,
    pins: Array.isArray(pins) ? pins.slice() : [],
    budget: sliceSubagentBudget(parentBudgetRemaining),
    allowTools: allowed,
    abortParent: false,
    canUse(name) { return allowed.has(String(name || '')); },
    filterExecutors(executors) {
      const src = executors && typeof executors === 'object' ? executors : {};
      const out = {};
      for (const k of Object.keys(src)) {
        if (allowed.has(k)) out[k] = src[k];
      }
      return out;
    },
  };
}

function aclMemoryHits(hits, userId) {
  const uid = String(userId || '').trim();
  const list = Array.isArray(hits) ? hits : [];
  return list.filter((h) => {
    if (h == null) return false;
    if (typeof h !== 'object') return Boolean(uid);
    const owner = h.userId || h.user_id || h.ownerId || h.owner_id;
    if (!owner) return true;
    if (!uid) return false;
    return String(owner) === uid;
  });
}

function detectSseGaps(frames, lastId = 0) {
  const seqs = (Array.isArray(frames) ? frames : [])
    .map((f) => Number(f && (f.seq != null ? f.seq : f.id)))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  const gaps = [];
  let expect = (Number(lastId) || 0) + 1;
  for (const s of seqs) {
    if (s > expect) gaps.push({ from: expect, to: s - 1 });
    if (s >= expect) expect = s + 1;
  }
  return gaps;
}

function fillSseGaps(frames, lastId = 0) {
  const list = Array.isArray(frames) ? frames.slice() : [];
  const gaps = detectSseGaps(list, lastId);
  for (const g of gaps) {
    list.push({
      type: 'sse_gap',
      from: g.from,
      to: g.to,
      seq: g.from,
      label: 'Eventos perdidos; relleno de hueco',
    });
  }
  list.sort((a, b) => Number(a && a.seq || 0) - Number(b && b.seq || 0));
  return { frames: list, gaps };
}

function eventIdempotencyKey(sessionKey, frame) {
  const sk = String(sessionKey || '');
  if (!sk || !frame) return '';
  if (frame.eventId) return `${sk}:${frame.eventId}`;
  const seq = frame.seq != null ? Number(frame.seq) : '';
  const type = String(frame.type || '');
  return `${sk}:${seq}:${type}`;
}

function rememberIdempotent(seen, sessionKey, frame) {
  const key = eventIdempotencyKey(sessionKey, frame);
  if (!key) return { stored: false, duplicate: false };
  if (seen && seen.has && seen.has(key)) return { stored: false, duplicate: true, key };
  if (seen && seen.add) seen.add(key);
  return { stored: true, duplicate: false, key };
}

function compareUsageDrift(ledger, redis, { toleranceTokens = 0 } = {}) {
  const lp = Number(ledger && ledger.promptTokens) || 0;
  const lc = Number(ledger && ledger.completionTokens) || 0;
  const rp = Number(redis && redis.promptTokens) || 0;
  const rc = Number(redis && redis.completionTokens) || 0;
  const lt = lp + lc;
  const rt = rp + rc;
  const delta = rt - lt;
  const tol = Math.max(0, Number(toleranceTokens) || 0);
  let charge = 'ok';
  if (delta > tol) charge = 'skip_redis_ahead';
  else if (delta < -tol) charge = 'catchup_redis';
  return {
    ledgerTokens: lt,
    redisTokens: rt,
    delta,
    drifted: Math.abs(delta) > tol,
    charge,
  };
}

function mergeUsageMax(a, b) {
  return {
    promptTokens: Math.max(Number(a && a.promptTokens) || 0, Number(b && b.promptTokens) || 0),
    completionTokens: Math.max(Number(a && a.completionTokens) || 0, Number(b && b.completionTokens) || 0),
  };
}

function reconcileUsage(ledger, redis, { toleranceTokens = 0 } = {}) {
  const drift = compareUsageDrift(ledger, redis, { toleranceTokens });
  if (drift.charge === 'skip_redis_ahead') {
    return { usage: mergeUsageMax(ledger, redis), action: 'no_double_charge', drift };
  }
  if (drift.charge === 'catchup_redis') {
    return { usage: ledger || redis || { promptTokens: 0, completionTokens: 0 }, action: 'persist_redis', drift };
  }
  return {
    usage: ledger || redis || { promptTokens: 0, completionTokens: 0 },
    action: 'ok',
    drift,
  };
}

function detectCgroup({ existsSync = fs.existsSync } = {}) {
  try {
    if (existsSync('/sys/fs/cgroup/cgroup.controllers')) return { present: true, version: 2 };
    if (existsSync('/sys/fs/cgroup/memory') || existsSync('/sys/fs/cgroup/cpu')) {
      return { present: true, version: 1 };
    }
  } catch (_) { /* missing */ }
  return { present: false, version: 0 };
}

function sandboxResourceLimits({
  cpuMs = DEFAULT_CPU_MS,
  memMb = DEFAULT_MEM_MB,
  existsSync = fs.existsSync,
} = {}) {
  const cg = detectCgroup({ existsSync });
  return {
    cpuMs: Math.max(1000, Math.min(300_000, Number(cpuMs) || DEFAULT_CPU_MS)),
    memMb: Math.max(32, Math.min(4096, Number(memMb) || DEFAULT_MEM_MB)),
    mode: cg.present ? 'cgroup' : 'ulimit-fallback',
    cgroup: cg,
  };
}

function rejectSymlinkWrite(stat) {
  if (!stat) return { ok: true };
  try {
    if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) {
      return { ok: false, code: 'symlink_rejected' };
    }
  } catch (_) { /* ignore */ }
  if (stat.isSymlink || stat.isSymbolicLink === true) {
    return { ok: false, code: 'symlink_rejected' };
  }
  return { ok: true };
}

function rejectBinaryPatch(content) {
  if (content == null) return { ok: true };
  if (Buffer.isBuffer(content)) {
    if (content.includes(0)) return { ok: false, code: 'binary_rejected' };
    return { ok: true };
  }
  const s = String(content);
  if (s.indexOf('\0') !== -1) return { ok: false, code: 'binary_rejected' };
  return { ok: true };
}

const toolExecSamples = [];
function observeToolExec(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return 0;
  toolExecSamples.push(n);
  while (toolExecSamples.length > 64) toolExecSamples.shift();
  return toolExecSamples.length;
}
function toolExecSnapshot() {
  const vals = toolExecSamples.slice().sort((a, b) => a - b);
  const pct = (p) => {
    if (!vals.length) return null;
    const idx = Math.min(vals.length - 1, Math.max(0, Math.ceil(p * vals.length) - 1));
    return vals[idx];
  };
  return { p50: pct(0.5), p95: pct(0.95), count: vals.length };
}

function hardeningSnapshot() {
  return {
    schemaFailClosed: true,
    resumeLock: true,
    checkpointTtl: true,
    memoryAcl: true,
    subagentIsolation: true,
    sseGapFill: true,
    eventIdempotent: true,
    usageReconcile: true,
    sandboxLimits: true,
    toolExecMs: toolExecSnapshot(),
  };
}

module.exports = {
  RESUME_LOCK_TTL_SEC,
  REDIS_PREFIX,
  createResumeLock,
  assertResumeSafe,
  toolSchemaFor,
  validateToolArgs,
  sliceSubagentBudget,
  createSubagentContext,
  aclMemoryHits,
  detectSseGaps,
  fillSseGaps,
  eventIdempotencyKey,
  rememberIdempotent,
  compareUsageDrift,
  mergeUsageMax,
  reconcileUsage,
  detectCgroup,
  sandboxResourceLimits,
  rejectSymlinkWrite,
  rejectBinaryPatch,
  observeToolExec,
  toolExecSnapshot,
  hardeningSnapshot,
};
