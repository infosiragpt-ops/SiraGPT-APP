'use strict';

/**
 * 3H26 engine runtime — leftover holes in caps 7/8/9 after 3H25.
 *
 * 3H25 wired Codex /code to engine-control. Caps 7 sandbox / 8 SSE / 9 queue
 * were unchanged. This module is first-party (no vendor copy) and is wired
 * into the LIVE sandbox.exec, sse-writer, and per-session queue.
 *
 * Interpreter stays `local` (gVisor runsc is the agent-runner docker driver).
 * Do not invent HMAC / MCP hosts / rotation / SANDBOX_NET_ALLOW.
 */

const crypto = require('crypto');

const REAP_GRACE_MS = 1_500;
const DRAIN_TIMEOUT_MS = 2_000;
const HEARTBEAT_MIN_GAP_MS = 5_000;
const QUEUE_LEASE_MS = 120_000;
const SSE_RING_MAX = 200;
const CHUNK_MAX_BYTES = 64 * 1024;
const STDOUT_MAX_BPS = 256 * 1024;
const ENV_ALLOW = Object.freeze([
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'USER', 'LOGNAME',
]);

const firstByte = { n: 0, sum: 0, last: 0, samples: [] };

function emitStreamChunk(onChunk, chunk, stream, state = {}) {
  if (typeof onChunk !== 'function') {
    return { emitted: false, bytes: 0, truncated: false, code: null };
  }
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk == null ? '' : chunk), 'utf8');
  const cap = Math.max(64, Number(state.maxBytes) || CHUNK_MAX_BYTES);
  const seen = Math.max(0, Number(state.seen) || 0);
  const startedAt = Number(state.startedAt) || Date.now();
  const elapsedMs = Math.max(1, Date.now() - startedAt);
  const bpsCap = Math.max(1024, Number(state.maxBps) || STDOUT_MAX_BPS);
  if (seen >= cap) {
    return { emitted: false, bytes: 0, truncated: true, code: 'sandbox_stream', seen };
  }
  const take = buf.subarray(0, Math.max(0, cap - seen));
  const nextSeen = seen + take.length;
  const rate = (nextSeen / elapsedMs) * 1000;
  if (rate > bpsCap) {
    state.seen = nextSeen;
    return { emitted: false, bytes: take.length, truncated: true, code: 'stdout_rate', rate, seen: nextSeen };
  }
  try {
    onChunk(take.toString('utf8'), stream === 'stderr' ? 'stderr' : 'stdout');
  } catch (_) { /* producer must never die on a UI callback */ }
  state.seen = nextSeen;
  return {
    emitted: true,
    bytes: take.length,
    truncated: take.length < buf.length,
    code: take.length < buf.length ? 'sandbox_stream' : null,
    seen: nextSeen,
  };
}

function killProcessTree(pid, { kill = null, platform = process.platform } = {}) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, killed: false, code: 'pg_invalid' };
  const killer = typeof kill === 'function' ? kill : (id, sig) => {
    try { process.kill(id, sig || 'SIGKILL'); return true; } catch (_) { return false; }
  };
  let killed = false;
  if (platform !== 'win32') {
    killed = Boolean(killer(-n, 'SIGKILL')) || Boolean(killer(n, 'SIGKILL'));
  } else {
    killed = Boolean(killer(n, 'SIGKILL'));
  }
  return { ok: true, killed, pid: n, code: killed ? 'pg_killed' : 'sandbox_reap' };
}

function shouldForceSettle({ killedAt = 0, now = Date.now(), graceMs = REAP_GRACE_MS, closed = false } = {}) {
  if (closed) return { settle: false, code: null, reason: 'already_closed' };
  const at = Number(killedAt) || 0;
  if (!at) return { settle: false, code: null, reason: 'not_killed' };
  const grace = Math.max(50, Number(graceMs) || REAP_GRACE_MS);
  if ((Number(now) - at) >= grace) {
    return { settle: true, code: 'sandbox_reap', ageMs: Number(now) - at };
  }
  return { settle: false, code: null, remainingMs: grace - (Number(now) - at) };
}

function reapAfterKill(pids, { exists = null, now = Date.now() } = {}) {
  const list = Array.isArray(pids) ? pids : [...(pids || [])];
  const probe = typeof exists === 'function' ? exists : (pid) => {
    try { process.kill(pid, 0); return true; } catch (err) { return err && err.code === 'EPERM'; }
  };
  const alive = [];
  const reaped = [];
  for (const pid of list) {
    const n = Number(pid);
    if (!Number.isFinite(n) || n <= 0) { reaped.push(pid); continue; }
    if (probe(n)) alive.push(n);
    else reaped.push(n);
  }
  return {
    ok: alive.length === 0,
    alive,
    reaped,
    at: now,
    code: alive.length ? 'sandbox_reap' : (reaped.length ? 'zombie_reaped' : null),
  };
}

function scrubSandboxEnv(env, extraAllow = []) {
  const src = env && typeof env === 'object' ? env : {};
  const allow = new Set(ENV_ALLOW.concat(Array.isArray(extraAllow) ? extraAllow : []));
  const out = {};
  for (const key of allow) {
    if (src[key] != null && src[key] !== '') out[key] = String(src[key]);
  }
  if (!out.PATH) out.PATH = '/usr/local/bin:/usr/bin:/bin';
  if (!out.LANG) out.LANG = 'C.UTF-8';
  out.NODE_OPTIONS = '';
  // Never copy secrets even if extraAllow tries.
  for (const k of Object.keys(out)) {
    if (/key|secret|token|password|credential|openai|openrouter|deepseek/i.test(k)) delete out[k];
  }
  return out;
}

async function guaranteedDestroy(sandbox, { timeoutMs = 8_000, now = Date.now() } = {}) {
  if (!sandbox || typeof sandbox.destroy !== 'function') {
    return { ok: true, skipped: true, code: 'sandbox_cleanup' };
  }
  const cap = Math.max(200, Number(timeoutMs) || 8_000);
  let timer = null;
  try {
    await Promise.race([
      Promise.resolve().then(() => sandbox.destroy()),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error('sandbox_cleanup');
          err.code = 'sandbox_cleanup';
          reject(err);
        }, cap);
      }),
    ]);
    return { ok: true, code: 'sandbox_cleanup', ms: Date.now() - now };
  } catch (err) {
    return {
      ok: false,
      code: 'sandbox_cleanup',
      error: String(err && err.code || err && err.message || err),
      ms: Date.now() - now,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function waitDrainWithTimeout({
  writeOk = true,
  onDrain = null,
  timeoutMs = DRAIN_TIMEOUT_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (writeOk) return Promise.resolve({ ok: true, drained: true, timedOut: false, code: null });
  const cap = Math.max(50, Number(timeoutMs) || DRAIN_TIMEOUT_MS);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { if (timer) clearTimeoutFn(timer); } catch (_) { /* ignore */ }
      resolve(result);
    };
    const timer = setTimeoutFn(() => {
      finish({ ok: false, drained: false, timedOut: true, code: 'sse_drain_timeout' });
    }, cap);
    try {
      if (typeof onDrain === 'function') {
        onDrain(() => finish({ ok: true, drained: true, timedOut: false, code: null }));
      } else {
        finish({ ok: false, drained: false, timedOut: true, code: 'sse_drain_timeout' });
      }
    } catch (_) {
      finish({ ok: false, drained: false, timedOut: true, code: 'sse_drain_timeout' });
    }
  });
}

function createOrphanHub() {
  const producers = new Map();
  return {
    attach(sessionKey, abort) {
      const key = String(sessionKey || '');
      if (!key || typeof abort !== 'function') return { ok: false, code: 'sse_orphan' };
      producers.set(key, abort);
      return { ok: true, size: producers.size };
    },
    drain(sessionKey, { frames = [], emit = () => {}, close = () => {} } = {}) {
      const key = String(sessionKey || '');
      const abort = producers.get(key);
      const list = Array.isArray(frames) ? frames : [];
      let emitted = 0;
      for (const f of list) {
        try { emit(f); emitted += 1; } catch (_) { /* drain must continue */ }
      }
      producers.delete(key);
      let aborted = false;
      if (typeof abort === 'function') {
        try { abort(); aborted = true; } catch (_) { aborted = false; }
      }
      let closed = false;
      try { close(); closed = true; } catch (_) { closed = false; }
      return { ok: true, emitted, aborted, closed, leftover: 0, code: 'sse_orphan' };
    },
    size() { return producers.size; },
  };
}

function replayFromSeq(frames, lastId = 0) {
  const list = Array.isArray(frames) ? frames : [];
  const last = Math.max(0, Number(lastId) || 0);
  const replay = [];
  let maxSeq = last;
  for (const f of list) {
    const seq = Number(f && (f.seq != null ? f.seq : f.id)) || 0;
    if (seq > last) {
      replay.push(f);
      if (seq > maxSeq) maxSeq = seq;
    }
  }
  return {
    ok: true,
    frames: replay,
    count: replay.length,
    lastId: last,
    nextSeq: maxSeq,
    code: replay.length ? 'sse_resume' : null,
  };
}

function heartbeatDue({
  closed = false,
  writable = true,
  backpressured = false,
  lastWriteAt = 0,
  now = Date.now(),
  minGapMs = HEARTBEAT_MIN_GAP_MS,
} = {}) {
  if (closed || !writable || backpressured) {
    return { emit: false, code: closed ? 'sse_orphan' : 'sse_backpressure' };
  }
  const gap = Number(now) - (Number(lastWriteAt) || 0);
  const min = Math.max(250, Number(minGapMs) || HEARTBEAT_MIN_GAP_MS);
  if (gap < min) return { emit: false, code: null, remainingMs: min - gap };
  return { emit: true, code: 'sse_heartbeat', gapMs: gap };
}

function pushRing(frames, frame, max = SSE_RING_MAX) {
  const list = Array.isArray(frames) ? frames.slice() : [];
  if (frame != null) list.push(frame);
  const cap = Math.max(1, Number(max) || SSE_RING_MAX);
  if (list.length <= cap) return { frames: list, dropped: 0, truncated: false, code: null };
  const dropped = list.length - cap;
  return { frames: list.slice(dropped), dropped, truncated: true, code: 'sse_backpressure' };
}

function makeQueueJob({ sessionKey, idempotencyKey = '', enqueuedAt = Date.now(), id = null } = {}) {
  const key = String(sessionKey || '');
  if (!key) return { ok: false, code: 'queue_cancel', job: null };
  return {
    ok: true,
    job: {
      id: String(id || `q_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`),
      sessionKey: key,
      idempotencyKey: idempotencyKey ? String(idempotencyKey) : '',
      enqueuedAt: Number.isFinite(Number(enqueuedAt)) ? Number(enqueuedAt) : Date.now(),
      cancelled: false,
      running: false,
    },
  };
}

function jobMayRun(job, now = Date.now(), ttlMs = QUEUE_LEASE_MS) {
  if (!job) return { ok: false, run: false, code: 'queue_cancel' };
  if (job.cancelled) return { ok: false, run: false, code: 'queue_cancel' };
  const ttl = Math.max(1, Number(ttlMs) || QUEUE_LEASE_MS);
  const age = (Number(now) || 0) - (Number(job.enqueuedAt) || 0);
  if (age > ttl) return { ok: false, run: false, code: 'queue_lease', ageMs: age };
  return { ok: true, run: true, code: null, ageMs: age, remainingMs: ttl - age };
}

function cancelPendingJobs(jobs, { sessionKey = null, jobId = null, all = true } = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  const key = sessionKey != null ? String(sessionKey) : null;
  const id = jobId != null ? String(jobId) : null;
  let cancelled = 0;
  const kept = [];
  for (const j of list) {
    if (!j || j.running) { kept.push(j); continue; }
    const matchSession = key == null || String(j.sessionKey) === key;
    const matchId = id == null || String(j.id || j.jobId) === id;
    if (matchSession && matchId) {
      j.cancelled = true;
      cancelled += 1;
      if (!all && id) continue;
      continue;
    }
    kept.push(j);
  }
  return { ok: cancelled > 0, cancelled, remaining: kept, code: 'queue_cancel' };
}

function pickFairReady(sessionKeys, last) {
  const list = Array.isArray(sessionKeys) ? sessionKeys.map(String).filter(Boolean) : [];
  if (!list.length) return { ok: false, session: null, code: 'fairness_empty' };
  if (!last) return { ok: true, session: list[0], index: 0, code: 'queue_fairness' };
  const i = list.indexOf(String(last));
  const idx = i < 0 ? 0 : (i + 1) % list.length;
  return { ok: true, session: list[idx], index: idx, code: 'queue_fairness' };
}

function observeRuntimeFirstByte(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return snapshotRuntimeFirstByte();
  firstByte.n += 1;
  firstByte.sum += n;
  firstByte.last = n;
  firstByte.samples.push(n);
  while (firstByte.samples.length > 256) firstByte.samples.shift();
  try {
    const rel = require('./engine-reliability');
    if (typeof rel.observeFirstToken === 'function') rel.observeFirstToken(n);
  } catch (_) { /* optional */ }
  try {
    const parity = require('./engine-parity');
    if (typeof parity.observeFirstByte === 'function') parity.observeFirstByte(n);
  } catch (_) { /* optional */ }
  return snapshotRuntimeFirstByte();
}

function snapshotRuntimeFirstByte() {
  const vals = firstByte.samples.slice().sort((a, b) => a - b);
  const pct = (p) => {
    if (!vals.length) return null;
    const idx = Math.min(vals.length - 1, Math.max(0, Math.ceil(p * vals.length) - 1));
    return vals[idx];
  };
  return {
    count: firstByte.n,
    last: firstByte.last,
    mean: firstByte.n ? firstByte.sum / firstByte.n : 0,
    p50: pct(0.5),
    p95: pct(0.95),
  };
}

function resetRuntimeFirstByte() {
  firstByte.n = 0;
  firstByte.sum = 0;
  firstByte.last = 0;
  firstByte.samples.length = 0;
  return snapshotRuntimeFirstByte();
}

function runtimeSnapshot() {
  return {
    sandboxStream: true,
    sandboxReap: true,
    sandboxCleanup: true,
    sandboxEnvScrub: true,
    sseDrainTimeout: true,
    sseOrphanHub: true,
    sseResumeReplay: true,
    sseHeartbeatGap: true,
    queueJobLease: true,
    queueCancelAll: true,
    queueFairPick: true,
    firstByteFromSse: true,
    interpreter: 'local',
    openrouterGenerate: false,
    firstByte: snapshotRuntimeFirstByte(),
  };
}

module.exports = {
  REAP_GRACE_MS,
  DRAIN_TIMEOUT_MS,
  HEARTBEAT_MIN_GAP_MS,
  QUEUE_LEASE_MS,
  SSE_RING_MAX,
  CHUNK_MAX_BYTES,
  ENV_ALLOW,
  emitStreamChunk,
  killProcessTree,
  shouldForceSettle,
  reapAfterKill,
  scrubSandboxEnv,
  guaranteedDestroy,
  waitDrainWithTimeout,
  createOrphanHub,
  replayFromSeq,
  heartbeatDue,
  pushRing,
  makeQueueJob,
  jobMayRun,
  cancelPendingJobs,
  pickFairReady,
  observeRuntimeFirstByte,
  snapshotRuntimeFirstByte,
  resetRuntimeFirstByte,
  runtimeSnapshot,
};
