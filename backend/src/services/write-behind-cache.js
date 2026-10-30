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
 *   - Pure User.lastActiveAt writes use bounded, parameterized SQL batches.
 *     Other writes retain their per-entry updateMany/update semantics.
 *   - SIGTERM-safe: `shutdown()` waits for any active flush, drains bounded
 *     retries, and rejects if writes remain so the shutdown registry can
 *     report data-loss risk before exit.
 *
 * Lost-update protection:
 *   - For monotonic timestamp fields (lastActiveAt), we only persist if
 *     the queued value is newer than what's already in the row, checked
 *     atomically by the UPDATE. For counters we use Prisma's
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

const ACTIVITY_BATCH_SIZE = 100;

// Only the auth telemetry shape is eligible. In particular, do not widen
// compound filters or fold counters/settings into a raw SQL update. ISO text
// is accepted for entries restored from Redis; invalid dates stay on the
// existing Prisma validation/error path and cannot poison a valid SQL batch.
function activityTimestamp(entry) {
  if (entry.model !== 'user' || Object.keys(entry.where).length !== 1
      || typeof entry.where.id !== 'string' || !entry.where.id
      || Object.keys(entry.data).length !== 1 || !('lastActiveAt' in entry.data)) return null;
  const value = entry.data.lastActiveAt;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? date : null;
}

function activityWhere(entry, timestamp) {
  return {
    ...entry.where,
    deletedAt: null,
    OR: [{ lastActiveAt: null }, { lastActiveAt: { lt: timestamp } }],
  };
}

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
  const shutdownMaxDrainAttempts = Number.isFinite(opts.shutdownMaxDrainAttempts)
    && opts.shutdownMaxDrainAttempts > 0
    ? Math.floor(opts.shutdownMaxDrainAttempts)
    : Math.max(1, maxRetries);

  /** @type {Map<string, {model:string, where:any, data:any, addedAt:number, retryCount:number}>} */
  const queue = new Map();
  let timer = null;
  let flushing = false;
  let activeFlushPromise = null;
  let shuttingDown = false;
  let shutdownPromise = null;
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
      const previousActivity = activityTimestamp(existing);
      const incomingActivity = activityTimestamp(entry);
      existing.data = previousActivity && incomingActivity
        ? { lastActiveAt: new Date(Math.max(previousActivity.getTime(), incomingActivity.getTime())) }
        : incomingWins
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

  function mirrorEntry(k) {
    if (!redis) return;
    const { model, where, data } = queue.get(k);
    const payload = JSON.stringify({ model, where, data });
    Promise.resolve().then(() => redis.hset(`${redisPrefix}pending`, k, payload))
      .catch((e) => reportError('redis_mirror', e));
  }

  function queueWrite(model, where, data) {
    if (shuttingDown) {
      const error = new Error('write-behind-cache is shutting down');
      error.code = 'WRITE_BEHIND_SHUTTING_DOWN';
      throw error;
    }
    if (!model || typeof model !== 'string') throw new TypeError('queueWrite: model required');
    if (!where || typeof where !== 'object') throw new TypeError('queueWrite: where required');
    if (!data || typeof data !== 'object') throw new TypeError('queueWrite: data required');
    validateData(data);
    const k = keyFor(model, where);
    mergeQueueEntry(k, { model, where, data, addedAt: now(), retryCount: 0 });
    // Mirror to redis (fire-and-forget; failures don't block).
    mirrorEntry(k);
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

  async function runFlush() {
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

    function handleWriteError(entry, err) {
      const fieldKey = keyFor(entry.model, entry.where);
      if (err && err.code === 'P2025') {
        redisClearFields.push(fieldKey);
        return;
      }
      reportError('flush_update', err);
      const retryCount = (entry.retryCount || 0) + 1;
      // Shutdown must report residual writes rather than discard them.
      if (retryCount <= maxRetries || shuttingDown) {
        retried += 1;
        totalRetried += 1;
        mergeQueueEntry(fieldKey, { ...entry, retryCount }, { incomingWins: false });
        // A later-arriving, older event may already have replaced the mirror
        // while SQL was in flight. Persist the merged maximum before retry.
        if (activityTimestamp(queue.get(fieldKey))) mirrorEntry(fieldKey);
      } else {
        dropped += 1;
        totalDropped += 1;
        redisClearFields.push(fieldKey);
        reportError('retry_exhausted', err);
      }
    }

    async function flushActivityBatch(entries) {
      // All identifiers are fixed SQL and all values are bound parameters.
      // Preserve Prisma's @updatedAt behavior only for rows actually updated.
      const values = [new Date(now())];
      const tuples = entries.map((entry, index) => {
        values.push(entry.where.id, activityTimestamp(entry));
        return `($${index * 2 + 2}::text, $${index * 2 + 3}::timestamp)`;
      });
      const sql = `
        UPDATE "users" AS target
        SET "lastActiveAt" = activity."lastActiveAt", "updatedAt" = $1::timestamp
        FROM (VALUES ${tuples.join(', ')}) AS activity("id", "lastActiveAt")
        WHERE target."id" = activity."id"
          AND target."deletedAt" IS NULL
          AND (target."lastActiveAt" IS NULL OR target."lastActiveAt" < activity."lastActiveAt")
        RETURNING target."id" AS "id"
      `;
      const rows = await prisma.$queryRawUnsafe(sql, ...values);
      const expected = new Set(entries.map(entry => entry.where.id));
      if (!Array.isArray(rows) || rows.some(row => !expected.has(row?.id))
          || new Set(rows.map(row => row.id)).size !== rows.length) {
        const error = new Error('Invalid activity batch result');
        error.code = 'WRITE_BEHIND_INVALID_BATCH_RESULT';
        throw error;
      }
      // Missing, deleted, equal or newer rows are terminal no-ops, just like
      // updateMany(count=0). Count only the IDs actually returned by Postgres.
      flushed += rows.length;
      redisClearFields.push(...entries.map(entry => keyFor(entry.model, entry.where)));
    }

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
        for (let index = 0; index < entries.length;) {
          const entry = entries[index];
          const timestamp = activityTimestamp(entry);
          if (timestamp && typeof prisma.$queryRawUnsafe === 'function') {
            const activityBatch = [];
            // Keep ordering relative to other update shapes for the same user.
            while (index < entries.length && activityBatch.length < ACTIVITY_BATCH_SIZE
                && activityTimestamp(entries[index])) activityBatch.push(entries[index++]);
            try { await flushActivityBatch(activityBatch); }
            catch (err) { for (const failed of activityBatch) handleWriteError(failed, err); }
            continue;
          }
          index += 1;
          const fieldKey = keyFor(entry.model, entry.where);
          try {
            const delegate = prisma[model];
            // updateMany is intentionally preferred for telemetry writes. It
            // returns count=0 when an account was deleted between queue and
            // flush, avoiding Prisma's noisy P2025 error event while keeping
            // the same non-fatal semantics. Test doubles and older delegates
            // without updateMany retain the prior update() fallback.
            const usedUpdateMany = typeof delegate.updateMany === 'function';
            const where = timestamp ? activityWhere(entry, timestamp) : entry.where;
            const result = usedUpdateMany
              ? await delegate.updateMany({ where, data: toPrismaData(entry.data) })
              : await delegate.update({ where, data: toPrismaData(entry.data) });
            if (usedUpdateMany && Number(result?.count) === 0) {
              redisClearFields.push(fieldKey);
              continue;
            }
            flushed += 1;
            redisClearFields.push(fieldKey);
          } catch (err) {
            handleWriteError(entry, err);
          }
        }
      }
      if (redis && redisClearFields.length > 0) {
        // A newer write may have arrived while the database batch was in
        // flight. Do not erase its durable mirror. Issue hdel synchronously
        // before yielding so later queueWrite/hset calls keep command order.
        const fields = Array.from(new Set(redisClearFields)).filter(key => !queue.has(key));
        if (fields.length) {
          try { await redis.hdel(`${redisPrefix}pending`, ...fields); }
          catch (error) { reportError('redis_clear', error); }
        }
      }
      totalFlushed += flushed;
      lastFlushAt = now();
      return { flushed, batches: batchCount, retried, dropped };
    } finally {
      flushing = false;
    }
  }

  function flushNow() {
    if (activeFlushPromise || flushing) {
      return Promise.resolve({
        flushed: 0,
        batches: 0,
        retried: 0,
        dropped: 0,
        skipped: true,
      });
    }
    if (queue.size === 0) {
      return Promise.resolve({ flushed: 0, batches: 0, retried: 0, dropped: 0 });
    }

    let tracked;
    tracked = Promise.resolve()
      .then(() => runFlush())
      .finally(() => {
        if (activeFlushPromise === tracked) activeFlushPromise = null;
      });
    activeFlushPromise = tracked;
    return tracked;
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
      shutdownMaxDrainAttempts,
      shuttingDown,
    };
  }

  function addFlushResult(total, result) {
    if (!result || result.skipped) return total;
    total.flushed += Number(result.flushed) || 0;
    total.batches += Number(result.batches) || 0;
    total.retried += Number(result.retried) || 0;
    total.dropped += Number(result.dropped) || 0;
    return total;
  }

  async function drainForShutdown() {
    const total = { flushed: 0, batches: 0, retried: 0, dropped: 0 };
    const inFlight = activeFlushPromise;
    if (inFlight) addFlushResult(total, await inFlight);

    let attempts = 0;
    while (queue.size > 0 && attempts < shutdownMaxDrainAttempts) {
      attempts += 1;
      // eslint-disable-next-line no-await-in-loop
      addFlushResult(total, await flushNow());
    }

    if (queue.size > 0) {
      const error = new Error(
        `write-behind-cache shutdown incomplete: ${queue.size} pending entr${queue.size === 1 ? 'y' : 'ies'}`,
      );
      error.code = 'WRITE_BEHIND_SHUTDOWN_INCOMPLETE';
      error.pending = queue.size;
      error.attempts = attempts;
      reportError('shutdown_incomplete', error);
      throw error;
    }
    return total;
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    stopTimer();
    shutdownPromise = drainForShutdown();
    return shutdownPromise;
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
  ACTIVITY_BATCH_SIZE,
  createWriteBehindCache,
  keyFor,
  mergeData,
  stableStringify,
  toPrismaData,
};
