'use strict';

/**
 * 3H22 engine parity layer — Claude Code / Cowork remaining gaps after 3H21.
 * Rewrite of ideas only. No OpenRouter. No OpenClaw/Hermes source.
 */

const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');

const TURN_DEADLINE_DEFAULT_MS = 180_000;
const TOOL_RESULT_MAX_BYTES = 32 * 1024;
const PIN_LRU_MAX = 12;
const STDERR_MAX_BPS = 256 * 1024;
const QUEUE_LEASE_MS = 120_000;
const ERROR_BUDGET_DEFAULT = 8;
const CIRCUIT_THRESHOLD_DEFAULT = 8;
const ROLLBACK_STACK_MAX = 8;
const SSE_BACKPRESSURE_MAX = 200;
const TOKEN_CHARS = 4;

const TOOL_ALIASES = Object.freeze({
  bash: 'execute_bash',
  shell: 'execute_bash',
  run: 'execute_bash',
  cmd: 'execute_bash',
  sh: 'execute_bash',
  read: 'read_file',
  cat: 'read_file',
  write: 'write_file',
  save: 'write_file',
  memory: 'retrieve_memory',
  recall: 'retrieve_memory',
});

const firstByte = { n: 0, sum: 0, last: 0 };

function assertTurnWallClock(startedAt, now, deadlineMs) {
  if (deadlineMs == null || deadlineMs === false) {
    return { ok: true, stop: false, remainingMs: Infinity, code: null };
  }
  const start = Number(startedAt) || 0;
  const t = Number(now) || 0;
  const deadline = Number(deadlineMs);
  if (!Number.isFinite(deadline) || deadline < 0) {
    return { ok: true, stop: false, remainingMs: Infinity, code: null };
  }
  const remaining = deadline - (t - start);
  if (remaining <= 0) {
    return { ok: false, stop: true, remainingMs: 0, code: 'turn_deadline', elapsedMs: t - start };
  }
  return { ok: true, stop: false, remainingMs: remaining, code: null, elapsedMs: t - start };
}

function mapToolAlias(name, { executors = null } = {}) {
  const raw = String(name || '').trim();
  if (!raw) return { ok: false, code: 'unknown_tool', name: raw, mapped: null, aliased: false };
  const key = raw.toLowerCase();
  const mapped = TOOL_ALIASES[key] || raw;
  if (executors && typeof executors === 'object') {
    const hasMapped = typeof executors[mapped] === 'function' || Object.prototype.hasOwnProperty.call(executors, mapped);
    const hasRaw = typeof executors[raw] === 'function' || Object.prototype.hasOwnProperty.call(executors, raw);
    if (!hasMapped && !hasRaw && !TOOL_ALIASES[key]) {
      return { ok: false, code: 'unknown_tool', name: raw, mapped, aliased: false };
    }
  }
  return { ok: true, name: mapped, mapped, aliased: Boolean(TOOL_ALIASES[key]), code: null };
}

function capToolResult(text, maxBytes = TOOL_RESULT_MAX_BYTES) {
  const s = text == null ? '' : String(text);
  const buf = Buffer.from(s, 'utf8');
  const cap = Math.max(64, Number(maxBytes) || TOOL_RESULT_MAX_BYTES);
  if (buf.length <= cap) return { ok: true, text: s, truncated: false, bytes: buf.length, code: null };
  const cut = buf.subarray(0, cap).toString('utf8');
  return {
    ok: false,
    text: `${cut}\n…[tool_result_capped ${buf.length}->${cap}]`,
    truncated: true,
    bytes: buf.length,
    cappedBytes: cap,
    code: 'tool_result_capped',
  };
}

async function isolateParallelTools(preparedAll, executePrepared) {
  const jobs = Array.isArray(preparedAll) ? preparedAll : [];
  const exec = typeof executePrepared === 'function' ? executePrepared : async () => ({ result: 'ERROR: missing executor' });
  const settled = await Promise.allSettled(jobs.map((p) => Promise.resolve().then(() => exec(p))));
  return settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    const msg = s.reason && (s.reason.message || s.reason.code) ? String(s.reason.message || s.reason.code) : 'isolated';
    return {
      prepared: jobs[i],
      result: `ERROR: tool_isolated: ${msg}`,
      f7Image: null,
      isolated: true,
      code: 'tool_isolated',
    };
  });
}

function casPutCheckpoint(store, rec) {
  const st = store && typeof store === 'object' ? store : new Map();
  const id = String((rec && rec.checkpointId) || rec && rec.id || 'ckpt');
  const expected = rec && rec.expectedVersion != null ? Number(rec.expectedVersion) : null;
  const cur = st.get ? st.get(id) : st[id];
  const curVer = cur && cur.version != null ? Number(cur.version) : 0;
  if (expected != null && expected !== curVer) {
    return { ok: false, code: 'ckpt_cas', version: curVer, expected };
  }
  const next = {
    id,
    version: curVer + 1,
    state: rec && rec.state ? rec.state : null,
    at: Date.now(),
  };
  if (st.set) st.set(id, next);
  else st[id] = next;
  return { ok: true, code: null, version: next.version, id };
}

function casGetCheckpoint(store, id) {
  const st = store && typeof store === 'object' ? store : new Map();
  const rec = st.get ? st.get(String(id)) : st[String(id)];
  if (!rec) return { ok: false, code: 'checkpoint_missing', state: null, version: 0 };
  return { ok: true, code: null, state: rec.state, version: rec.version, id: rec.id };
}

function evictPinsLru(pins, max = PIN_LRU_MAX) {
  const list = Array.isArray(pins) ? pins.slice() : [];
  const cap = Math.max(1, Number(max) || PIN_LRU_MAX);
  if (list.length <= cap) return { pins: list, evicted: 0, code: null };
  const evicted = list.length - cap;
  return { pins: list.slice(-cap), evicted, code: 'pin_evicted' };
}

function createProcessGroup({ kill = null } = {}) {
  const pids = new Set();
  const killer = typeof kill === 'function' ? kill : (pid) => {
    try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); return true; } catch (_) { return false; }
  };
  return {
    register(pid) {
      const n = Number(pid);
      if (!Number.isFinite(n) || n <= 0) return { ok: false, code: 'pg_invalid' };
      pids.add(n);
      return { ok: true, size: pids.size };
    },
    size() { return pids.size; },
    killOnCancel() {
      let killed = 0;
      const errors = [];
      for (const pid of pids) {
        try {
          if (killer(pid)) killed += 1;
        } catch (err) {
          errors.push({ pid, error: String(err && err.message || err) });
        }
      }
      pids.clear();
      return { ok: true, killed, leftover: pids.size, code: 'pg_killed', errors };
    },
  };
}

function watermarkLastEventId(store, sessionKey, id, { now = Date.now() } = {}) {
  const st = store && typeof store === 'object' ? store : new Map();
  const key = String(sessionKey || '');
  const seq = Number(id) || 0;
  if (!key) return { ok: false, code: 'watermark_missing', seq: 0 };
  const rec = { seq, at: now };
  if (st.set) st.set(key, rec);
  else st[key] = rec;
  return { ok: true, seq, code: null };
}

function readWatermark(store, sessionKey) {
  const st = store && typeof store === 'object' ? store : new Map();
  const key = String(sessionKey || '');
  const rec = st.get ? st.get(key) : st[key];
  if (!rec) return { ok: true, seq: 0, missing: true };
  return { ok: true, seq: Number(rec.seq) || 0, at: rec.at, missing: false };
}

function cancelQueuedJob(pending, jobId) {
  const list = Array.isArray(pending) ? pending : [];
  const id = String(jobId || '');
  const idx = list.findIndex((j) => String(j && (j.id || j.jobId)) === id);
  if (idx < 0) return { ok: false, code: 'queue_cancel', cancelled: false, reason: 'not_found' };
  const job = list[idx];
  if (job.running) return { ok: false, code: 'queue_cancel', cancelled: false, reason: 'running' };
  job.cancelled = true;
  list.splice(idx, 1);
  return { ok: true, code: 'queue_cancel', cancelled: true, job };
}

function createCreditHold({ ceiling = 0 } = {}) {
  let reserved = 0;
  let settled = 0;
  let released = 0;
  const cap = Number(ceiling) || 0;
  return {
    reserve(tokens) {
      const n = Math.max(0, Number(tokens) || 0);
      if (cap > 0 && reserved + n > cap) {
        return { ok: false, code: 'credit_hold', reserved, remaining: Math.max(0, cap - reserved) };
      }
      reserved += n;
      return { ok: true, reserved, remaining: cap > 0 ? cap - reserved : Infinity, code: null };
    },
    settle(used) {
      const n = Math.max(0, Number(used) || 0);
      settled += n;
      const leftover = Math.max(0, reserved - n);
      reserved = Math.max(0, reserved - n);
      return { ok: true, settled, leftover, reserved, code: 'credit_settle' };
    },
    release() {
      const n = reserved;
      released += n;
      reserved = 0;
      return { ok: true, released: n, totalReleased: released, remaining: cap, code: 'credit_release' };
    },
    snapshot() { return { reserved, settled, released, ceiling: cap }; },
  };
}

function createErrorBudget({ max = ERROR_BUDGET_DEFAULT } = {}) {
  const cap = Math.max(1, Number(max) || ERROR_BUDGET_DEFAULT);
  let used = 0;
  return {
    cap,
    used() { return used; },
    remaining() { return Math.max(0, cap - used); },
    record(ok) {
      if (ok) return { ok: true, stop: false, used, remaining: cap - used, code: null };
      used += 1;
      if (used >= cap) return { ok: false, stop: true, used, remaining: 0, code: 'error_budget' };
      return { ok: true, stop: false, used, remaining: cap - used, code: null };
    },
  };
}

function atomicWriteFile(targetPath, content, { rename = fs.renameSync, writeFile = fs.writeFileSync, unlink = fs.unlinkSync, tmpDir = os.tmpdir() } = {}) {
  const dest = String(targetPath || '');
  if (!dest || dest.includes('..')) return { ok: false, code: 'path_traversal' };
  const tmp = path.join(tmpDir, `sira-aw-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  const body = content == null ? '' : String(content);
  writeFile(tmp, body, { encoding: 'utf8' });
  try {
    rename(tmp, dest);
  } catch (err) {
    try { unlink(tmp); } catch (_) { /* leftover tmp is the caller's problem only if rename failed */ }
    return { ok: false, code: 'atomic_write', error: String(err && err.message || err) };
  }
  return { ok: true, path: dest, tmp, bytes: Buffer.byteLength(body), code: null };
}

function waitSubtaskDag(tasks, doneIds) {
  const list = Array.isArray(tasks) ? tasks : [];
  const done = new Set((doneIds || []).map(String));
  const ready = [];
  const blocked = [];
  for (const t of list) {
    const id = String(t && (t.id || t.name) || '');
    const deps = Array.isArray(t && t.deps) ? t.deps.map(String) : [];
    if (done.has(id)) continue;
    if (deps.every((d) => done.has(d))) ready.push(id);
    else blocked.push({ id, waitingOn: deps.filter((d) => !done.has(d)) });
  }
  return { ok: blocked.length === 0 || ready.length > 0, ready, blocked, code: blocked.length && !ready.length ? 'dag_blocked' : null };
}

function createToolCircuit({ threshold = CIRCUIT_THRESHOLD_DEFAULT } = {}) {
  const cap = Math.max(1, Number(threshold) || CIRCUIT_THRESHOLD_DEFAULT);
  const fails = new Map();
  const open = new Set();
  return {
    record(name, ok) {
      const key = String(name || '');
      if (ok) {
        fails.delete(key);
        open.delete(key);
        return { ok: true, open: false, code: null };
      }
      const n = (fails.get(key) || 0) + 1;
      fails.set(key, n);
      if (n >= cap) {
        open.add(key);
        return { ok: false, open: true, count: n, code: 'circuit_open' };
      }
      return { ok: true, open: false, count: n, code: null };
    },
    isOpen(name) { return open.has(String(name || '')); },
    snapshot() { return { open: [...open], threshold: cap }; },
  };
}

function estimateTokens(text) {
  const s = text == null ? '' : String(text);
  return Math.ceil(Buffer.byteLength(s, 'utf8') / TOKEN_CHARS);
}

function compactByTokenBudget(messages, { maxTokens = 4000 } = {}) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const cap = Math.max(64, Number(maxTokens) || 4000);
  const tokensOf = (m) => estimateTokens(m && (m.content || ''));
  let total = list.reduce((a, m) => a + tokensOf(m), 0);
  if (total <= cap) return { messages: list, removed: 0, beforeTokens: total, afterTokens: total, code: null };
  const keep = [];
  const head = list.filter((m) => m && m.role === 'system').slice(0, 2);
  const rest = list.filter((m) => !(m && m.role === 'system' && head.includes(m)));
  keep.push(...head);
  let used = keep.reduce((a, m) => a + tokensOf(m), 0);
  const tail = [];
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const t = tokensOf(rest[i]);
    if (used + t > cap && tail.length) break;
    if (used + t > cap) continue;
    tail.push(rest[i]);
    used += t;
  }
  tail.reverse();
  const out = keep.concat(tail);
  const after = out.reduce((a, m) => a + tokensOf(m), 0);
  return { messages: out, removed: list.length - out.length, beforeTokens: total, afterTokens: after, code: 'token_compact' };
}

function reapZombies(pids, { exists = null } = {}) {
  const list = Array.isArray(pids) ? pids : [...(pids || [])];
  const alive = [];
  const reaped = [];
  const probe = typeof exists === 'function' ? exists : (pid) => {
    try { process.kill(pid, 0); return true; } catch (err) { return err && err.code === 'EPERM'; }
  };
  for (const pid of list) {
    const n = Number(pid);
    if (!Number.isFinite(n) || n <= 0) { reaped.push(pid); continue; }
    if (probe(n)) alive.push(n);
    else reaped.push(n);
  }
  return { ok: true, alive, reaped, code: reaped.length ? 'zombie_reaped' : null };
}

function drainSseThenClose(frames, { emit = () => {}, close = () => {} } = {}) {
  const list = Array.isArray(frames) ? frames : [];
  let emitted = 0;
  for (const f of list) {
    try { emit(f); emitted += 1; } catch (_) { /* drain must continue */ }
  }
  let closed = false;
  try { close(); closed = true; } catch (_) { closed = false; }
  return { ok: closed, emitted, leftover: 0, code: 'sse_drain' };
}

function expireQueueLease(enqueuedAt, now, ttlMs = QUEUE_LEASE_MS) {
  const at = Number(enqueuedAt) || 0;
  const t = Number(now) || 0;
  const ttl = Math.max(1, Number(ttlMs) || QUEUE_LEASE_MS);
  if (t - at > ttl) return { ok: false, expired: true, code: 'queue_lease', ageMs: t - at };
  return { ok: true, expired: false, code: null, ageMs: t - at, remainingMs: ttl - (t - at) };
}

function createRollbackStack({ max = ROLLBACK_STACK_MAX } = {}) {
  const cap = Math.max(1, Number(max) || ROLLBACK_STACK_MAX);
  const stack = [];
  return {
    push(snap) {
      stack.push(snap);
      while (stack.length > cap) stack.shift();
      return { ok: true, depth: stack.length };
    },
    rollback(n = 1) {
      const k = Math.max(1, Number(n) || 1);
      if (!stack.length) return { ok: false, code: 'checkpoint_missing', state: null };
      let last = null;
      for (let i = 0; i < k && stack.length; i += 1) last = stack.pop();
      return { ok: true, state: last, depth: stack.length, code: 'checkpoint_rollback' };
    },
    depth() { return stack.length; },
  };
}

function retryAfterMs(code) {
  const c = String(code || '');
  const table = {
    tool_timeout: 750,
    provider_unavailable: 1200,
    rate_limited: 2000,
    fence_expired: 400,
    dlq_replay: 250,
    pgvector_failed: 500,
    retrieve_memory_failed: 500,
    sandbox_killed: 800,
    turn_deadline: 0,
    error_budget: 0,
    circuit_open: 0,
  };
  if (!Object.prototype.hasOwnProperty.call(table, c)) return { ok: true, ms: 0, retryable: false, code: c };
  const ms = table[c];
  return { ok: true, ms, retryable: ms > 0, code: c };
}

function observeFirstByte(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return firstByte;
  firstByte.n += 1;
  firstByte.sum += n;
  firstByte.last = n;
  return snapshotFirstByte();
}

function snapshotFirstByte() {
  return {
    count: firstByte.n,
    last: firstByte.last,
    mean: firstByte.n ? firstByte.sum / firstByte.n : 0,
  };
}

function resetFirstByte() {
  firstByte.n = 0;
  firstByte.sum = 0;
  firstByte.last = 0;
  return snapshotFirstByte();
}

function detectEncoding(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''), 'utf8');
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { encoding: 'utf8', bom: true };
  if (b.includes(0)) return { encoding: 'binary', bom: false, code: 'encoding_binary' };
  return { encoding: 'utf8', bom: false };
}

function dedupMemoryHits(hits) {
  const list = Array.isArray(hits) ? hits : [];
  const seen = new Set();
  const out = [];
  let dropped = 0;
  for (const h of list) {
    const key = String((h && (h.id || h.key || h.text || h.content)) || JSON.stringify(h));
    if (seen.has(key)) { dropped += 1; continue; }
    seen.add(key);
    out.push(h);
  }
  return { hits: out, dropped, code: dropped ? 'memory_dedup' : null };
}

function dropOldestSse(frames, max = SSE_BACKPRESSURE_MAX) {
  const list = Array.isArray(frames) ? frames.slice() : [];
  const cap = Math.max(1, Number(max) || SSE_BACKPRESSURE_MAX);
  if (list.length <= cap) return { frames: list, dropped: 0, truncated: false, code: null };
  const dropped = list.length - cap;
  return { frames: list.slice(dropped), dropped, truncated: true, code: 'sse_backpressure' };
}

function pickFairSession(sessions, last) {
  const list = Array.isArray(sessions) ? sessions.map(String).filter(Boolean) : [];
  if (!list.length) return { ok: false, session: null, code: 'fairness_empty' };
  if (!last) return { ok: true, session: list[0], index: 0, code: null };
  const i = list.indexOf(String(last));
  const next = list[(i + 1) % list.length];
  return { ok: true, session: next, index: (i + 1) % list.length, code: null };
}

function capStderrRate({ bytes, elapsedMs, maxBytesPerSec = STDERR_MAX_BPS } = {}) {
  const b = Math.max(0, Number(bytes) || 0);
  const ms = Math.max(1, Number(elapsedMs) || 1);
  const bps = (b / ms) * 1000;
  const cap = Math.max(1024, Number(maxBytesPerSec) || STDERR_MAX_BPS);
  if (bps > cap) return { ok: false, code: 'stderr_rate', bps, cap };
  return { ok: true, code: null, bps, cap };
}

function revisePlanOnFailure(plan, failedStep) {
  const steps = Array.isArray(plan) ? plan.map((s) => ({ ...s })) : [];
  const id = String(failedStep || '');
  const idx = steps.findIndex((s) => String(s.id || s.name) === id);
  if (idx < 0) return { plan: steps, revised: false, code: null };
  steps[idx] = { ...steps[idx], status: 'failed', retry: true };
  const retryStep = { id: `${id}#retry`, name: steps[idx].name || id, deps: steps[idx].deps || [], status: 'pending', reason: 'revise_on_failure' };
  steps.splice(idx + 1, 0, retryStep);
  return { plan: steps, revised: true, code: 'plan_revised' };
}

function resumeFromLastTool(steps) {
  const list = Array.isArray(steps) ? steps : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i] && list[i].ok) {
      return { ok: true, step: list[i], index: i, code: null };
    }
  }
  return { ok: false, step: null, index: -1, code: 'resume_no_tool' };
}

function verifyWriteHash(content, expected) {
  const body = content == null ? '' : String(content);
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  if (expected == null) return { ok: true, hash, code: null };
  if (String(expected) !== hash) return { ok: false, hash, expected: String(expected), code: 'write_hash' };
  return { ok: true, hash, code: null };
}

function paritySnapshot() {
  return {
    turnWallClock: true,
    toolAlias: true,
    toolResultCap: true,
    parallelIsolate: true,
    ckptCas: true,
    pinLru: true,
    processGroupKill: true,
    sseWatermark: true,
    queueCancel: true,
    creditHold: true,
    errorBudget: true,
    atomicWrite: true,
    dagWait: true,
    toolCircuit: true,
    tokenCompact: true,
    zombieReap: true,
    sseDrain: true,
    queueLease: true,
    rollbackStack: true,
    retryAfter: true,
    firstByte: true,
    memoryDedup: true,
    sseBackpressure: true,
    fairnessRr: true,
    stderrRate: true,
    planRevise: true,
    writeHash: true,
  };
}

module.exports = {
  TURN_DEADLINE_DEFAULT_MS,
  TOOL_RESULT_MAX_BYTES,
  TOOL_ALIASES,
  assertTurnWallClock,
  mapToolAlias,
  capToolResult,
  isolateParallelTools,
  casPutCheckpoint,
  casGetCheckpoint,
  evictPinsLru,
  createProcessGroup,
  watermarkLastEventId,
  readWatermark,
  cancelQueuedJob,
  createCreditHold,
  createErrorBudget,
  atomicWriteFile,
  waitSubtaskDag,
  createToolCircuit,
  estimateTokens,
  compactByTokenBudget,
  reapZombies,
  drainSseThenClose,
  expireQueueLease,
  createRollbackStack,
  retryAfterMs,
  observeFirstByte,
  snapshotFirstByte,
  resetFirstByte,
  detectEncoding,
  dedupMemoryHits,
  dropOldestSse,
  pickFairSession,
  capStderrRate,
  revisePlanOnFailure,
  resumeFromLastTool,
  verifyWriteHash,
  paritySnapshot,
};
