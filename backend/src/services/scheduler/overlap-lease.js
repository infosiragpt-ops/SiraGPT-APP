'use strict';

/**
 * overlap-lease — per-job distributed overlap guard.
 *
 * Native SiraGPT rewrite of OpenClaw's in-process active-job set /
 * "already-running" skip. OpenClaw keeps a process-local Set (and a
 * runningAtMs marker) so one gateway does not double-fire the same
 * cron tick. That does not coordinate workers.
 *
 * This module uses Redis SET NX + PX (token compare-and-del / PEXPIRE)
 * so two backend replicas cannot run the same job at once. It is not a
 * dump of OpenClaw cron sources.
 *
 * Honesty:
 *   - Redis up  → acquire/renew/release are distributed (SET NX).
 *   - Redis down or unset → in-process Map fallback. Same worker still
 *     skips overlap; other workers are NOT coordinated. Callers see
 *     `distributed:false` and `fallback:'redis_unavailable'`.
 *   - A held lease fails closed (does not run) with a Spanish reason
 *     and stable code `overlap_skipped`.
 *
 * A later lease operation probes the same client again after a failure;
 * Redis-down is not a permanent process-lifetime decision. This never
 * replays an agent invocation. Local holders stay local until release/expiry.
 * No new env vars. Uses the existing REDIS_URL only when a client is
 * injected or lazily attached outside NODE_ENV=test.
 */

const { randomBytes } = require('node:crypto');

const KEY_PREFIX = 'sira:job-overlap:';
const DEFAULT_TTL_MS = 120_000;
const MIN_TTL_MS = 50;
const MAX_TTL_MS = 600_000;
const OVERLAP_HELD_REASON_ES =
  'Este trabajo ya se está ejecutando. Se omitió el solapamiento para no duplicarlo.';

const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`.trim();

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`.trim();

function clampTtl(ttlMs) {
  const n = Number(ttlMs);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_MS;
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, Math.floor(n)));
}

function sanitizePart(value, fallback = '_') {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return fallback;
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || fallback;
}

function leaseKey({ jobId, ownerId } = {}) {
  const job = sanitizePart(jobId, '');
  if (!job) {
    const err = new TypeError('overlap-lease: jobId required');
    err.code = 'E_PARAMS';
    throw err;
  }
  return `${KEY_PREFIX}${sanitizePart(ownerId)}:${job}`;
}

function newToken() {
  return randomBytes(16).toString('hex');
}

function heldResult({ jobId = null, distributed = true, fallback = null } = {}) {
  const out = {
    ok: false,
    code: 'overlap_skipped',
    error: 'overlap_skipped',
    reason: OVERLAP_HELD_REASON_ES,
    jobId: jobId == null ? null : String(jobId),
    distributed: Boolean(distributed),
    fallback,
  };
  try {
    require('../agents/session-isolation').attachAuditLine(out, {
      kind: 'lease',
      code: 'overlap_skipped',
      jobId,
      label: OVERLAP_HELD_REASON_ES,
    });
  } catch { /* audit is best-effort */ }
  return out;
}

function parseSetFlags(args) {
  let nx = false;
  let px = null;
  for (let i = 0; i < args.length; i += 1) {
    const item = args[i];
    if (item && typeof item === 'object') {
      if (item.NX || item.nx) nx = true;
      if (item.PX != null) px = Number(item.PX);
      if (item.px != null) px = Number(item.px);
      continue;
    }
    const flag = String(item || '').toUpperCase();
    if (flag === 'NX') nx = true;
    if (flag === 'PX' && i + 1 < args.length) {
      px = Number(args[i + 1]);
      i += 1;
    }
  }
  return { nx, px };
}

function isRedisUnavailable(err) {
  if (!err) return true;
  const code = String(err.code || '').toUpperCase();
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'ENOTCONN'].includes(code)) {
    return true;
  }
  const msg = String(err.message || err).toLowerCase();
  return /redis_down|connection is closed|connection lost|econnrefused|etimedout|enotfound|stream isn'?t writeable|max retries|readonly|loading/.test(msg);
}

function createLocalStore(now) {
  const leases = new Map();

  function gc(t) {
    for (const [key, row] of leases) {
      if (!row || row.expiresAt <= t) leases.delete(key);
    }
  }

  function peek(key, t) {
    const row = leases.get(key);
    if (!row) return null;
    if (row.expiresAt <= t) {
      leases.delete(key);
      return null;
    }
    return row;
  }

  return {
    peek,
    tryAcquire(key, token, ttlMs, t) {
      gc(t);
      if (peek(key, t)) return null;
      const row = { token, expiresAt: t + ttlMs, ttlMs, acquiredAt: t, mode: 'local' };
      leases.set(key, row);
      return row;
    },
    renew(key, token, ttlMs, t) {
      const row = peek(key, t);
      if (!row) return { ok: false, reason: 'no_lease' };
      if (row.token !== token) return { ok: false, reason: 'wrong_token' };
      row.expiresAt = t + ttlMs;
      row.ttlMs = ttlMs;
      return { ok: true, expiresAt: row.expiresAt };
    },
    release(key, token, t) {
      const row = peek(key, t);
      if (!row) return false;
      if (row.token !== token) return false;
      leases.delete(key);
      return true;
    },
    write(key, token, ttlMs, t) {
      leases.set(key, { token, expiresAt: t + ttlMs, ttlMs, acquiredAt: t, mode: 'redis' });
    },
    size(t) {
      gc(t);
      return leases.size;
    },
  };
}

function createOverlapLease(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const tokenFactory = typeof opts.tokenFactory === 'function' ? opts.tokenFactory : newToken;
  const defaultTtlMs = clampTtl(opts.ttlMs);
  const local = createLocalStore(now);
  const acquiring = new Set();
  let redis = opts.redis || null;
  let redisDisabled = false;
  let fallbackCount = 0;
  let heldCount = 0;
  let acquireCount = 0;

  function markFallback() {
    redisDisabled = true;
    fallbackCount += 1;
  }

  async function redisSetNx(key, token, ttlMs) {
    if (!redis || typeof redis.set !== 'function') return null;
    const reply = await redis.set(key, token, 'PX', ttlMs, 'NX');
    return reply === 'OK' || reply === true;
  }

  async function redisEval(script, key, ...argv) {
    if (!redis || typeof redis.eval !== 'function') return 0;
    const reply = await redis.eval(script, 1, key, ...argv);
    return Number(reply) || 0;
  }

  function acquireLocal({ jobId, ownerId, ttlMs, holderId } = {}) {
    const key = leaseKey({ jobId, ownerId });
    const ttl = clampTtl(ttlMs ?? defaultTtlMs);
    const token = String(tokenFactory());
    const t = now();
    const row = local.tryAcquire(key, token, ttl, t);
    if (!row) {
      heldCount += 1;
      return heldResult({
        jobId,
        distributed: false,
        fallback: redis ? 'redis_unavailable' : 'local_only',
      });
    }
    acquireCount += 1;
    return {
      ok: true,
      token,
      key,
      jobId: String(jobId),
      ownerId: ownerId == null ? null : String(ownerId),
      holderId: holderId || null,
      expiresAt: row.expiresAt,
      ttlMs: ttl,
      distributed: false,
      fallback: redis ? 'redis_unavailable' : 'local_only',
      mode: 'local',
    };
  }

  function shadowLocal(key, token, ttlMs, t) {
    local.write(key, token, ttlMs, t);
  }

  async function acquire(spec = {}) {
    const { jobId, ownerId, ttlMs, holderId } = spec;
    const key = leaseKey({ jobId, ownerId });
    const ttl = clampTtl(ttlMs ?? defaultTtlMs);
    const token = String(tokenFactory());
    const t = now();

    const localHolder = local.peek(key, t)?.mode === 'local';
    // Recovery must not replace a task that started in local fallback. Reserve
    // the acquisition too: two pending SETs must not cross Redis/local modes.
    if (localHolder || acquiring.has(key)) {
      heldCount += 1;
      return heldResult({ jobId, distributed: false,
        fallback: localHolder ? (redis ? 'redis_unavailable' : 'local_only') : null });
    }
    acquiring.add(key);
    try {
      // One bounded Redis operation per new request, no background replay.
      // The production client retains its existing command/connect timeouts.
      if (redis) {
        try {
          const won = await redisSetNx(key, token, ttl);
          redisDisabled = false;
          if (won) {
            shadowLocal(key, token, ttl, t);
            acquireCount += 1;
            return {
              ok: true,
              token,
              key,
              jobId: String(jobId),
              ownerId: ownerId == null ? null : String(ownerId),
              holderId: holderId || null,
              expiresAt: t + ttl,
              ttlMs: ttl,
              distributed: true,
              fallback: null,
              mode: 'redis',
            };
          }
          heldCount += 1;
          return heldResult({ jobId, distributed: true, fallback: null });
        } catch (err) {
          if (!isRedisUnavailable(err)) {
            heldCount += 1;
            return heldResult({ jobId, distributed: true, fallback: null });
          }
          markFallback();
        }
      }
      return acquireLocal(spec);
    } finally {
      acquiring.delete(key);
    }
  }

  async function renew(claim, { ttlMs } = {}) {
    if (!claim || !claim.ok || !claim.token || !claim.key) {
      return { ok: false, code: 'LEASE_INVALID', reason: 'no_lease' };
    }
    const ttl = clampTtl(ttlMs ?? claim.ttlMs ?? defaultTtlMs);
    const t = now();

    if (claim.mode === 'redis') {
      // A local shadow is not proof that Redis renewed the distributed lease.
      if (!redis) return { ok: false, code: 'LEASE_INVALID', reason: 'redis_unavailable', fallback: 'redis_unavailable' };
      try {
        const updated = await redisEval(RENEW_SCRIPT, claim.key, claim.token, String(ttl));
        redisDisabled = false;
        if (updated) {
          shadowLocal(claim.key, claim.token, ttl, t);
          return { ok: true, expiresAt: t + ttl, mode: 'redis' };
        }
        return { ok: false, code: 'LEASE_INVALID', reason: 'wrong_token' };
      } catch (err) {
        if (!isRedisUnavailable(err)) {
          return { ok: false, code: 'LEASE_INVALID', reason: 'renew_failed' };
        }
        markFallback();
        return { ok: false, code: 'LEASE_INVALID', reason: 'redis_unavailable', fallback: 'redis_unavailable' };
      }
    }

    const localOut = local.renew(claim.key, claim.token, ttl, t);
    if (!localOut.ok) return { ok: false, code: 'LEASE_INVALID', reason: localOut.reason };
    return { ok: true, expiresAt: localOut.expiresAt, mode: 'local' };
  }

  async function release(claim) {
    if (!claim || !claim.token || !claim.key) return false;
    const t = now();
    let redisReleased = false;
    if (claim.mode === 'redis' && redis) {
      try {
        redisReleased = (await redisEval(RELEASE_SCRIPT, claim.key, claim.token)) > 0;
        redisDisabled = false;
      } catch (err) {
        if (isRedisUnavailable(err)) markFallback();
      }
    }
    const localReleased = local.release(claim.key, claim.token, t);
    return Boolean(redisReleased || localReleased);
  }

  function startRenew(claim, { intervalMs, onRenew } = {}) {
    const every = Number.isFinite(intervalMs) && intervalMs > 0
      ? Math.floor(intervalMs)
      : Math.max(25, Math.floor((claim && claim.ttlMs ? claim.ttlMs : defaultTtlMs) / 3));
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) return;
      Promise.resolve()
        .then(() => renew(claim))
        .then((result) => { if (typeof onRenew === 'function') onRenew(result); })
        .catch(() => { /* renew is best-effort; holder keeps running */ });
    }, every);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return function stopRenew() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    };
  }

  async function withLease(spec, fn) {
    const claim = await acquire(spec);
    if (!claim.ok) return claim;
    const stopRenew = startRenew(claim);
    try {
      return await fn(claim);
    } finally {
      stopRenew();
      await release(claim);
    }
  }

  function snapshot() {
    return {
      liveLocal: local.size(now()),
      pendingAcquires: acquiring.size,
      redisConfigured: Boolean(redis),
      redisAttached: Boolean(redis) && !redisDisabled,
      redisDisabled,
      acquireCount,
      heldCount,
      fallbackCount,
      distributed: Boolean(redis) && !redisDisabled,
    };
  }

  function attachRedis(next) {
    redis = next || null;
    redisDisabled = false;
  }

  return {
    acquire,
    acquireLocal,
    renew,
    release,
    startRenew,
    withLease,
    snapshot,
    attachRedis,
    leaseKey,
  };
}

let defaultLease = null;

function getDefaultOverlapLease() {
  if (!defaultLease) defaultLease = createOverlapLease();
  return defaultLease;
}

function setDefaultOverlapLease(lease) {
  defaultLease = lease || null;
  return defaultLease;
}

function resetDefaultOverlapLease() {
  defaultLease = createOverlapLease();
  return defaultLease;
}

function ensureDefaultRedisClient({ env = process.env, createClient } = {}) {
  if (env.NODE_ENV === 'test') return getDefaultOverlapLease();
  const lease = getDefaultOverlapLease();
  if (lease.snapshot().redisConfigured) return lease;
  const url = env.REDIS_URL;
  if (!url) return lease;
  try {
    const factory = typeof createClient === 'function'
      ? createClient
      : () => {
        // eslint-disable-next-line global-require
        const IORedis = require('ioredis');
        // eslint-disable-next-line global-require
        const { attachRedisListeners } = require('../agents/redis-resilience');
        const client = new IORedis(url, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableReadyCheck: false,
          enableOfflineQueue: false,
          connectTimeout: 250,
          commandTimeout: 250,
        });
        attachRedisListeners(client, { label: 'job-overlap-lease' });
        return client;
      };
    lease.attachRedis(factory());
  } catch {
    // Stay on the documented local fallback. Never log the URL.
  }
  return lease;
}

function acquireJobOverlap(spec) {
  const lease = getDefaultOverlapLease();
  if (!lease.snapshot().redisConfigured) return lease.acquireLocal(spec);
  return lease.acquire(spec);
}

function renewJobOverlap(claim, opts) {
  return getDefaultOverlapLease().renew(claim, opts);
}

function releaseJobOverlap(claim) {
  return getDefaultOverlapLease().release(claim);
}

function startJobOverlapRenew(claim, opts) {
  return getDefaultOverlapLease().startRenew(claim, opts);
}

module.exports = {
  KEY_PREFIX,
  DEFAULT_TTL_MS,
  MIN_TTL_MS,
  MAX_TTL_MS,
  OVERLAP_HELD_REASON_ES,
  RENEW_SCRIPT,
  RELEASE_SCRIPT,
  leaseKey,
  clampTtl,
  parseSetFlags,
  heldResult,
  createOverlapLease,
  getDefaultOverlapLease,
  setDefaultOverlapLease,
  resetDefaultOverlapLease,
  ensureDefaultRedisClient,
  acquireJobOverlap,
  renewJobOverlap,
  releaseJobOverlap,
  startJobOverlapRenew,
};
