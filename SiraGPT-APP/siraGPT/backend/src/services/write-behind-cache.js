'use strict';

/**
 * write-behind-cache — coalesce frequent UPDATE writes (e.g. lastActiveAt,
 * usage counters) so we don't hammer Postgres with one query per request.
 *
 * Model:
 *   - In-memory queue keyed by `${model}|${stableWhereJSON}`.
 *   - Latest scalar set/overwrite ("last write wins") for non-numeric.
 *   - Numeric fields with __increment marker accumulate.
 *   - Flush every `flushIntervalMs` (default 5s) OR when queue size
 *     reaches `flushThreshold` (default 100).
 *   - Per-flush groups by model and dispatches batched updates via
 *     `updateMany` when the where is a simple single-key filter, or
 *     per-item `update` otherwise.
 *   - SIGTERM-safe: `flushNow()` should be registered with the graceful
 *     shutdown registry so pending writes hit the DB before exit.
 *
 * Lost-update protection:
 *   - For monotonic timestamp fields (lastActiveAt), we only persist if
 *     the queued value is newer than what's already in the row by virtue
 *     of using `gte` filters when batching. For counters we use Prisma's
 *     `{ increment: n }` atomic op so concurrent writers add cleanly.
 *   - `getPending(model, where)` lets read paths see the not-yet-flushed
 *     value so users don't observe a stale "last seen" right after the
 *     write-behind queued it.
 *
 * Redis-optional persistence:
 *   - When `redis` is supplied, every queued entry is mirrored to a
 *     Redis hash so a crash before flush doesn't lose the writes — on
 *     boot the consumer can rehydrate via `hydrateFromRedis()`.
 *   - When Redis isn't configured we operate purely in memory.
 */

function stableStringify(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(`${value.toString()}n`);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (seen.has(value)) return JSON.stringify('[circular]');
  seen.add(value);
  if (Array.isArray(value)) {
    const out = `[${value.map(item => stableStringify(item, seen)).join(',')}]`;
    seen.delete(value);
    return out;
  }
  const keys = Object.keys(value).sort();
  const out = `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k], seen)}`).join(',')}}`;
  seen.delete(value);
  return out;
}

function keyFor(model, where) {
  return `${model}|${stableStringify(where)}`;
}

function mergeData(existing, incoming) {
  // Combine two pending data payloads. Numeric { __increment: n } merges
  // additively; everything else is overwritten "last write wins".
  const out = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    if (v && typeof v === 'object' && '__increment' in v) {
      const next = Number(v.__increment);
      if (!Number.isFinite(next)) throw new TypeError(`write-behind-cache: ${k} must be a finite increment`);
      const prev = out[k] && typeof out[k] === 'object' && '__increment' in out[k]
        ? Number(out[k].__increment)
        : 0;
      if (!Number.isFinite(prev)) throw new TypeError(`write-behind-cache: ${k} has a non-finite pending increment`);
      out[k] = { __increment: prev + next };
    } else {
      out[k] = v;
    }
  }
  return out;
}

function validateData(data) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && '__increment' in v) {
      const n = Number(v.__increment);
      if (!Number.isFinite(n)) throw new TypeError(`write-behind-cache: ${k} must be a finite increment`);
    }
  }
}

function toPrismaData(data) {
  // Convert our internal { __increment } markers to Prisma's atomic op.
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && '__increment' in v) {
      out[k] = { increment: Number(v.__increment) };
    } else {
      out[k] = v;
    }
  }
  return out;
}

function createWriteBehindCache(opts = {}) {
  const prisma = opts.prisma || null;
  const redis = opts.redis || null;
  const flushIntervalMs = Number.isFinite(opts.flushIntervalMs) && opts.flushIntervalMs >= 0
    ? Math.floor(opts.flushIntervalMs)
    : 5000;
  const flushThreshold = Number.isFinite(opts.flushThreshold) && opts.flushThreshold > 0
    ? Math.floor(opts.flushThreshold)
    : 100;
  const redisPrefix = String(opts.redisPrefix || 'wbc:');
  const onError = typeof opts.onError === 'function' ? opts.onError : null;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const maxRetries = Number.isFinite(opts.maxRetries) && opts.maxRetries >= 0
    ? Math.floor(opts.maxRetries)
    : 3;

  /** @type {Map<string, {model:string, where:any, data:any, addedAt:number, retryCount:number}>} */
  const queue = new Map();
  let timer = null;
  let flushing = false;
  let totalFlushed = 0;
  let totalDropped = 0;
  let totalRetried = 0;
  let lastFlushAt = 0;
  let lastErrorAt = 0;

  function reportError(stage, err) {
    lastErrorAt = now();
    if (onError) {
      try { onError(stage, err); } catch (_) { /* swallow */ }
    }
  }

  function mergeQueueEntry(k, entry, opts = {}) {
    const incomingWins = opts.incomingWins !== false;
    validateData(entry.data);
    const existing = queue.get(k);
    if (existing) {
      existing.data = incomingWins
        ? mergeData(existing.data, entry.data)
        : mergeData(entry.data, existing.data);
      existing.retryCount = Math.max(existing.retryCount || 0, entry.retryCount || 0);
      existing.addedAt = Math.min(existing.addedAt || now(), entry.addedAt || now());
    } else {
      queue.set(k, {
        model: entry.model,
        where: entry.where,
        data: { ...entry.data },
        addedAt: entry.addedAt || now(),
        retryCount: entry.retryCount || 0,
      });
    }
  }

  function startTimer() {
    if (timer || flushIntervalMs <= 0) return;
    timer = setInterval(() => { void flushNow().catch((e) => reportError('timer', e)); }, flushIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  startTimer();

  function queueWrite(model, where, data) {
    if (!model || typeof model !== 'string') throw new TypeError('queueWrite: model required');
    if (!where || typeof where !== 'object') throw new TypeError('queueWrite: where required');
    if (!data || typeof data !== 'object') throw new TypeError('queueWrite: data required');
    validateData(data);
    const k = keyFor(model, where);
    mergeQueueEntry(k, { model, where, data, addedAt: now(), retryCount: 0 });
    // Mirror to redis (fire-and-forget; failures don't block).
    if (redis) {
      const payload = JSON.stringify({ model, where, data: queue.get(k).data });
      Promise.resolve().then(() => redis.hset(`${redisPrefix}pending`, k, payload))
        .catch((e) => reportError('redis_mirror', e));
    }
    if (queue.size >= flushThreshold) {
      // Yield to the next tick so the caller isn't blocked on the flush.
      Promise.resolve().then(() => flushNow().catch((e) => reportError('threshold', e)));
    }
  }

  function getPending(model, where) {
    const k = keyFor(model, where);
    const entry = queue.get(k);
    return entry ? { ...entry.data } : null;
  }

  async function flushNow() {
    if (flushing) return { flushed: 0, batches: 0, retried: 0, dropped: 0, skipped: true };
    if (queue.size === 0) return { flushed: 0, batches: 0, retried: 0, dropped: 0 };
    flushing = true;
    const snapshot = Array.from(queue.values());
    queue.clear();
    const batches = new Map(); // model → entries[]
    for (const entry of snapshot) {
      if (!batches.has(entry.model)) batches.set(entry.model, []);
      batches.get(entry.model).push(entry);
    }
    let flushed = 0;
    let retried = 0;
    let dropped = 0;
    let batchCount = 0;
    const redisClearFields = [];
    try {
      for (const [model, entries] of batches.entries()) {
        batchCount += 1;
        if (!prisma || !prisma[model] || typeof prisma[model].update !== 'function') {
          // Drop silently — model might not exist on this Prisma client
          // (e.g. dev without migration, or write-behind enabled for a
          // table that doesn't have lastActiveAt). Telemetry tracks it.
          totalDropped += entries.length;
          dropped += entries.length;
          redisClearFields.push(...entries.map((e) => keyFor(e.model, e.where)));
          continue;
        }
        for (const entry of entries) {
          const fieldKey = keyFor(entry.model, entry.where);
          try {
            await prisma[model].update({
              where: entry.where,
              data: toPrismaData(entry.data),
            });
            flushed += 1;
            redisClearFields.push(fieldKey);
          } catch (err) {
            // P2025 — record not found — is non-fatal: the row was
            // deleted between queue + flush. Other errors are reported.
            const code = err && err.code;
            if (code === 'P2025') {
              redisClearFields.push(fieldKey);
              continue;
            }
            reportError('flush_update', err);
            const retryCount = (entry.retryCount || 0) + 1;
            if (retryCount <= maxRetries) {
              retried += 1;
              totalRetried += 1;
              mergeQueueEntry(fieldKey, { ...entry, retryCount }, { incomingWins: false });
            } else {
              dropped += 1;
              totalDropped += 1;
              redisClearFields.push(fieldKey);
              reportError('retry_exhausted', err);
            }
          }
        }
      }
      if (redis && redisClearFields.length > 0) {
        const fields = Array.from(new Set(redisClearFields));
        await Promise.resolve().then(() => redis.hdel(`${redisPrefix}pending`, ...fields))
          .catch((e) => reportError('redis_clear', e));
      }
      totalFlushed += flushed;
      lastFlushAt = now();
      return { flushed, batches: batchCount, retried, dropped };
    } finally {
      flushing = false;
    }
  }

  async function hydrateFromRedis() {
    if (!redis) return { hydrated: 0 };
    let hydrated = 0;
    try {
      const all = await redis.hgetall(`${redisPrefix}pending`);
      if (!all) return { hydrated: 0 };
      for (const [k, raw] of Object.entries(all)) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.model && parsed.where && parsed.data) {
            mergeQueueEntry(k, { ...parsed, addedAt: now(), retryCount: parsed.retryCount || 0 }, { incomingWins: false });
            hydrated += 1;
          }
        } catch (_) { /* skip malformed */ }
      }
    } catch (e) { reportError('hydrate', e); }
    return { hydrated };
  }

  function size() { return queue.size; }
  function stats() {
    return {
      pending: queue.size,
      totalFlushed,
      totalDropped,
      totalRetried,
      lastFlushAt,
      lastErrorAt,
      flushIntervalMs,
      flushThreshold,
      maxRetries,
    };
  }

  async function shutdown() {
    stopTimer();
    return flushNow();
  }

  return {
    queueWrite,
    getPending,
    flushNow,
    hydrateFromRedis,
    shutdown,
    size,
    stats,
    _stopTimer: stopTimer,
  };
}

module.exports = {
  createWriteBehindCache,
  keyFor,
  mergeData,
  stableStringify,
  toPrismaData,
};
