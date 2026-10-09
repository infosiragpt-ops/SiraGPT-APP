'use strict';

/**
 * stream-resume — SSE resumption tokens for /api/ai/generate.
 *
 * MVP token-based resume layer that complements `stream-cache` (which
 * snapshots by chatId for reload). This module is keyed by an opaque
 * `streamId` (UUID) so a transient network drop can be recovered by
 * re-issuing the request with `Last-Event-ID: <streamId>:<position>`.
 *
 * Storage backends (in priority order):
 *  1. Injected redis client (ioredis-compatible — uses set/get/del with EX)
 *  2. process.env.REDIS_URL via lazy ioredis require
 *  3. In-process Map fallback (single-instance only — fine for MVP and tests)
 *
 * Redis V2 stores metadata + a byte/count bounded frame list; existing JSON
 * records are migrated lazily. basePosition/nextPosition are absolute frame
 * counts, so trimming cannot renumber a cursor or silently replay the wrong tail.
 * Explicit resume rejects an unavailable store or a cursor outside the retained
 * window. In-process fallback is single-replica only; Redis writes are best-effort.
 */

const configuredTtlSeconds = Number.parseInt(process.env.AI_STREAM_RESUME_TTL_SECONDS || '', 10);
// Long-running agent turns can spend hours thinking or executing tools without
// emitting content. Active owners renew this bounded lease independently of
// the browser socket (see touch()), so runtime is unbounded while terminal or
// abandoned records are reclaimed promptly.
const DEFAULT_TTL_SECONDS = Number.isFinite(configuredTtlSeconds) && configuredTtlSeconds >= 300
  ? configuredTtlSeconds
  : 10 * 60;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
const DEFAULT_MAX_CHUNKS = 4000;    // hard cap per-stream to bound memory
const KEY_PREFIX = 'sira:sse-resume:';
// Hard cap on distinct sessions held in the in-process fallback Map so an
// abandoned-stream leak (open → drop → never resumed) can't grow unbounded.
// Oldest-expiring entries are evicted first when over the cap.
const DEFAULT_MAX_MEMORY_ENTRIES = 5000;
const DEFAULT_MAX_MEMORY_BYTES = 64 * 1024 * 1024;
let _memoryBytes = 0;
const SWEEP_INTERVAL_MS = 60 * 1000; // proactive expiry sweep cadence

let _injectedRedis = null;
let _ioredisClient = null;
let _nowFn = () => Date.now();
const _memoryStore = new Map(); // streamId -> { record, expiresAt }

// ─── Per-streamId serialization ────────────────────────────────────────
// open(persist)/append/complete/fail/destroy each do a read-modify-write
// across an `await` (memory + best-effort Redis). The resume handler fires
// append() fire-and-forget per content frame, so many can be in flight at
// once on the same streamId, and complete()/fail() can race them. Without
// serialization, two concurrent ops read the same snapshot and the later
// write clobbers the earlier (lost chunk / resurrected `complete:false`),
// corrupting the replay tail a reconnecting client sees. We chain every
// mutating op per streamId onto a tail promise so they run strictly in the
// order they were invoked. The chain map is pruned when it drains.
const _opChains = new Map(); // streamId -> Promise (tail of the op queue)

function _runExclusive(streamId, fn) {
  const prev = _opChains.get(streamId) || Promise.resolve();
  // Never let a rejected predecessor break the chain — settle then run.
  const next = prev.then(() => fn(), () => fn());
  // Track the tail; prune when this op is the last one standing.
  _opChains.set(streamId, next);
  next.then(() => {
    if (_opChains.get(streamId) === next) _opChains.delete(streamId);
  }, () => { if (_opChains.get(streamId) === next) _opChains.delete(streamId); });
  return next;
}

let _sweepTimer = null;

function _memoryDelete(id) {
  const entry = _memoryStore.get(id);
  if (entry) _memoryBytes -= entry.bytes || 0;
  _memoryStore.delete(id);
}

function _sweepExpired() {
  const now = _now();
  for (const [id, entry] of _memoryStore) {
    if (entry.expiresAt < now) _memoryDelete(id);
  }
}

function _ensureSweeper() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(_sweepExpired, SWEEP_INTERVAL_MS);
  // Don't keep the event loop alive just for the sweep.
  if (_sweepTimer && typeof _sweepTimer.unref === 'function') _sweepTimer.unref();
}

function _now() { return _nowFn(); }

function _setInjectedRedis(client) {
  // Test seam — pass an ioredis-compatible fake.
  _injectedRedis = client;
}

function _setNowForTests(nowFn) {
  _nowFn = typeof nowFn === 'function' ? nowFn : () => Date.now();
}

function _resetForTests() {
  _injectedRedis = null;
  _ioredisClient = null;
  _memoryStore.clear();
  _memoryBytes = 0;
  _opChains.clear();
  _nowFn = () => Date.now();
  if (_sweepTimer) {
    clearInterval(_sweepTimer);
    _sweepTimer = null;
  }
}

function _getRedis() {
  if (_injectedRedis) return _injectedRedis;
  if (_ioredisClient) return _ioredisClient;
  if (!process.env.REDIS_URL) return null;
  try {
    const IORedis = require('ioredis');
    _ioredisClient = new IORedis(process.env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      connectTimeout: 2000,
    });
    _ioredisClient.on('error', () => { /* swallowed — best effort */ });
    return _ioredisClient;
  } catch {
    return null;
  }
}

function _memoryGet(streamId) {
  const entry = _memoryStore.get(streamId);
  if (!entry) return null;
  if (entry.expiresAt < _now()) {
    _memoryDelete(streamId);
    return null;
  }
  return entry.record;
}

function _memorySet(streamId, record, ttlSeconds) {
  _ensureSweeper();
  _memoryDelete(streamId);
  const bytes = record.totalBytes || 0;
  _memoryBytes += bytes;
  _memoryStore.set(streamId, {
    record, bytes,
    expiresAt: _now() + (ttlSeconds * 1000),
  });
  // Bound the fallback store. Drop already-expired entries first; if still
  // over the cap, evict the soonest-to-expire sessions. The live stream's
  // record was just (re)inserted so it is the freshest and never evicted
  // for a single overflowing insert.
  if ((_memoryStore.size > DEFAULT_MAX_MEMORY_ENTRIES || _memoryBytes > DEFAULT_MAX_MEMORY_BYTES)) {
    _sweepExpired();
    if ((_memoryStore.size > DEFAULT_MAX_MEMORY_ENTRIES || _memoryBytes > DEFAULT_MAX_MEMORY_BYTES)) {
      const victims = [];
      for (const [id, entry] of _memoryStore) {
        if (id === streamId) continue;
        victims.push([id, entry.expiresAt]);
      }
      victims.sort((a, b) => a[1] - b[1]);
      for (const [id] of victims) {
        if (_memoryStore.size <= DEFAULT_MAX_MEMORY_ENTRIES && _memoryBytes <= DEFAULT_MAX_MEMORY_BYTES) break;
        _memoryDelete(id);
      }
    }
  }
}

// V2 stores only the new frame per append; metadata and list mutations are
// atomic in Redis. Hash-tagged keys remain co-located on Redis Cluster.
function redisKeys(id) {
  const tagged = Buffer.from(String(id)).toString('base64url');
  return [`${KEY_PREFIX}v2:{${tagged}}:meta`, `${KEY_PREFIX}v2:{${tagged}}:chunks`];
}
function normalizeRecord(value = {}) {
  const chunks = Array.isArray(value.chunks) ? value.chunks.filter(v => typeof v === 'string') : [];
  const basePosition = Number.isSafeInteger(Number(value.basePosition)) ? Number(value.basePosition) : 0;
  const nextPosition = Number.isSafeInteger(Number(value.nextPosition)) ? Number(value.nextPosition) : basePosition + chunks.length;
  const record = { ...value, chunks: chunks.slice(), basePosition, nextPosition,
    totalBytes: chunks.reduce((n, v) => n + Buffer.byteLength(v), 0), complete: value.complete === true };
  trimRecord(record);
  return record;
}
function trimRecord(record) {
  while (record.chunks.length > DEFAULT_MAX_CHUNKS || record.totalBytes > DEFAULT_MAX_BYTES) {
    record.totalBytes -= Buffer.byteLength(record.chunks.shift());
    record.basePosition += 1;
  }
  return record;
}
function replayAfter(record, position, { inclusive = false } = {}) {
  const normalized = normalizeRecord(record);
  const cursor = Number(position);
  if (!Number.isSafeInteger(cursor) || cursor < normalized.basePosition || cursor > normalized.nextPosition) {
    return { resyncRequired: true, chunks: [], startPosition: normalized.basePosition, nextPosition: normalized.nextPosition };
  }
  const start = Math.max(normalized.basePosition, inclusive && cursor > 0 ? cursor - 1 : cursor);
  return { resyncRequired: false, chunks: normalized.chunks.slice(start - normalized.basePosition),
    startPosition: start, nextPosition: normalized.nextPosition };
}
const REDIS_MUTATE = `
local m=KEYS[1]; local q=KEYS[2]; local op=ARGV[1]; local ttl=tonumber(ARGV[2])
local exists=redis.call('EXISTS',m)==1
if op=='seed' then
  if not exists then
    local r=cjson.decode(ARGV[3]); redis.call('DEL',q)
    redis.call('HSET',m,'base',r.basePosition,'next',r.nextPosition,'bytes',r.totalBytes,'complete',r.complete and '1' or '0','error',type(r.error)=='string' and r.error or '')
    for _,chunk in ipairs(r.chunks) do redis.call('RPUSH',q,chunk) end
  end
elseif op=='append' then
  local pos=tonumber(ARGV[3]); local chunk=ARGV[4]
  if exists and redis.call('HGET',m,'complete')=='1' then return tonumber(redis.call('HGET',m,'next')) end
  local prior=tonumber(redis.call('HGET',m,'next') or '0')
  if not exists or prior~=pos-1 then
    redis.call('DEL',q); redis.call('HSET',m,'base',pos-1,'next',pos-1,'bytes',0,'complete','0','error','')
  end
  local bytes=tonumber(redis.call('HGET',m,'bytes') or '0')
  if string.len(chunk)>tonumber(ARGV[7]) then
    redis.call('DEL',q); redis.call('HSET',m,'base',pos,'next',pos,'bytes',0)
  else
    redis.call('RPUSH',q,chunk); bytes=bytes+string.len(chunk)
    local base=tonumber(redis.call('HGET',m,'base') or '0')
    while redis.call('LLEN',q)>tonumber(ARGV[5]) or bytes>tonumber(ARGV[6]) do
      local removed=redis.call('LPOP',q); if not removed then break end
      bytes=bytes-string.len(removed); base=base+1
    end
    redis.call('HSET',m,'base',base,'next',pos,'bytes',bytes)
  end
elseif op=='complete' then if exists then redis.call('HSET',m,'complete','1') end
elseif op=='fail' then if exists then redis.call('HSET',m,'error',ARGV[3]) end
end
if redis.call('EXISTS',m)==1 then redis.call('EXPIRE',m,ttl) end
if redis.call('EXISTS',q)==1 then redis.call('EXPIRE',q,ttl) end
return 1
`;
const REDIS_READ = `
return {redis.call('HGETALL',KEYS[1]),redis.call('LRANGE',KEYS[2],0,-1)}
`;
function incrementalRedis(redis) { return redis && typeof redis.eval === 'function' && typeof redis.hgetall === 'function' && typeof redis.lrange === 'function'; }
async function _redisLookup(streamId) {
  const redis = _getRedis();
  if (!redis) return { record: null, storeError: false };
  try {
    if (incrementalRedis(redis)) {
      const [metaKey, chunksKey] = redisKeys(streamId);
      // Read offsets and frames in one Redis operation. Separate reads race an
      // append/trim and can attach old offsets to a new list.
      const [fields, chunks] = await redis.eval(REDIS_READ, 2, metaKey, chunksKey);
      const meta = {};
      for (let i = 0; i < fields.length; i += 2) meta[fields[i]] = fields[i + 1];
      if (Object.keys(meta).length) {
        const record = normalizeRecord({ chunks, basePosition: Number(meta.base), nextPosition: Number(meta.next),
          complete: meta.complete === '1', error: meta.error || null, storageVersion: 2 });
        // An expired/missing list must not masquerade as a complete replay.
        if (record.nextPosition - record.basePosition !== chunks.length) record.basePosition = record.nextPosition - chunks.length;
        return { record, storeError: false };
      }
    }
    const raw = await redis.get(`${KEY_PREFIX}${streamId}`);
    return { record: raw ? normalizeRecord({ ...JSON.parse(raw), storageVersion: 1 }) : null, storeError: false };
  } catch { return { record: null, storeError: true }; }
}
async function _redisGet(id) { return (await _redisLookup(id)).record; }
async function _redisSet(streamId, record, ttlSeconds, operation = 'seed', chunk = '') {
  const redis = _getRedis();
  if (!redis) return false;
  try {
    if (incrementalRedis(redis)) {
      const args = operation === 'seed' ? [JSON.stringify(record)]
        : operation === 'append' ? [record.nextPosition, chunk, DEFAULT_MAX_CHUNKS, DEFAULT_MAX_BYTES, DEFAULT_MAX_FRAME_BYTES]
          : operation === 'fail' ? [record.error || 'stream_failed'] : [];
      await redis.eval(REDIS_MUTATE, 2, ...redisKeys(streamId), operation, ttlSeconds, ...args);
      record.storageVersion = 2;
      // Prevent an expiredV2 from falling back to a stale pre-migration JSON
      // tail when a shorter lease was requested. Delete only after V2 exists.
      if (operation === 'seed') await redis.del(`${KEY_PREFIX}${streamId}`);
    } else {
      // Legacy adapter/test compatibility. Production ioredis takes V2 above.
      await redis.set(`${KEY_PREFIX}${streamId}`, JSON.stringify(record), 'EX', ttlSeconds);
    }
    return true;
  } catch { return false; }
}
async function _redisDel(streamId) {
  const redis = _getRedis();
  if (!redis) return false;
  try { await redis.del(`${KEY_PREFIX}${streamId}`, ...redisKeys(streamId)); return true; } catch { return false; }
}

/**
 * Parse a `Last-Event-ID` header into { streamId, position }.
 * Accepts either `<streamId>` (position=0) or `<streamId>:<position>`.
 * Returns null on malformed input.
 */
function parseLastEventId(header) {
  if (typeof header !== 'string') return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  const colonIdx = trimmed.lastIndexOf(':');
  if (colonIdx === -1) {
    return { streamId: trimmed, position: 0 };
  }
  const streamId = trimmed.slice(0, colonIdx);
  const posStr = trimmed.slice(colonIdx + 1);
  const position = Number(posStr);
  if (!streamId || !/^\d+$/.test(posStr) || !Number.isSafeInteger(position) || position < 0) return null;
  return { streamId, position };
}

/**
 * Generate a fresh streamId. Uses crypto.randomUUID() when available.
 */
function generateStreamId() {
  try {
    return require('crypto').randomUUID();
  } catch {
    return `sse-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * Create or open a resumable session.
 * - If `streamId` is given and a record exists, returns the existing record so
 *   the caller can replay chunks from `position` and continue appending.
 * - Otherwise creates an empty record under a fresh id.
 *
 * @returns {Promise<{ streamId, record, isResume }>}
 */
async function open({ streamId = null, ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  if (streamId) {
    const fromMem = _memoryGet(streamId);
    if (fromMem) return { streamId, record: fromMem, isResume: true };
    const fromRedis = await _redisGet(streamId);
    if (fromRedis) return { streamId, record: fromRedis, isResume: true };
  }
  const id = streamId || generateStreamId();
  const record = normalizeRecord({ chunks: [], complete: false, error: null, ttlSeconds });
  // Persist initial empty record so a fast reconnect finds it
  _memorySet(id, record, ttlSeconds);
  await _redisSet(id, record, ttlSeconds);
  return { streamId: id, record, isResume: false };
}

/**
 * Look up an existing session without creating one.
 *
 * Memory is checked first because the active owner updates it synchronously
 * before its best-effort Redis write settles. A Redis read is only a fallback
 * for another process; its failure is surfaced to explicit resume callers so
 * they cannot accidentally fall through into a new generation.
 *
 * @returns {Promise<{streamId, record: object|null, found: boolean, storeError: boolean}>}
 */
async function openExisting({ streamId } = {}) {
  if (!streamId) return { streamId: null, record: null, found: false, storeError: false, isResume: true };
  const fromMem = _memoryGet(streamId);
  if (fromMem) {
    return { streamId, record: fromMem, found: true, storeError: false, isResume: true };
  }
  const fromRedis = await _redisLookup(streamId);
  if (fromRedis.record) {
    return { streamId, record: fromRedis.record, found: true, storeError: false, isResume: true };
  }
  return { streamId, record: null, found: false, storeError: fromRedis.storeError, isResume: true };
}

/**
 * Append one frame. Returns its absolute position, even after older frames
 * are trimmed. Oversized frames create an explicit replay gap, not truncation.
 */
async function _appendImpl(streamId, chunk, ttlSeconds) {
  let record = _memoryGet(streamId) || await _redisGet(streamId);
  if (!record) {
    record = normalizeRecord({ chunks: [], complete: false, error: null, ttlSeconds });
  }
  if (record.complete) return record.nextPosition;
  if (typeof chunk !== 'string' || chunk.length === 0) return record.nextPosition;
  if (record.storageVersion === 1) await _redisSet(streamId, record, ttlSeconds);
  record.nextPosition += 1;
  if (Buffer.byteLength(chunk) > DEFAULT_MAX_FRAME_BYTES) {
    record.chunks = []; record.totalBytes = 0; record.basePosition = record.nextPosition;
  } else {
    record.chunks.push(chunk); record.totalBytes += Buffer.byteLength(chunk); trimRecord(record);
  }
  _memorySet(streamId, record, ttlSeconds);
  // Best-effort persistence — serialized per streamId so the read-modify-write
  // above can't be clobbered by a concurrent append/complete/fail.
  await _redisSet(streamId, record, ttlSeconds, 'append', chunk);
  return record.nextPosition;
}

async function append(streamId, chunk, { ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  if (!streamId) return 0;
  return _runExclusive(streamId, () => _appendImpl(streamId, chunk, ttlSeconds));
}

/**
 * Renew an active stream's resumability lease without adding a content frame.
 * This is deliberately independent of res.write: a detached browser socket
 * must not make a still-running owner lose its Last-Event-ID record.
 */
async function _touchImpl(streamId, ttlSeconds) {
  const record = _memoryGet(streamId) || await _redisGet(streamId);
  if (!record) return false;
  const effectiveTtl = Number.isFinite(ttlSeconds) && ttlSeconds > 0
    ? ttlSeconds
    : (Number.isFinite(record.ttlSeconds) && record.ttlSeconds > 0
      ? record.ttlSeconds
      : DEFAULT_TTL_SECONDS);
  record.ttlSeconds = effectiveTtl;
  _memorySet(streamId, record, effectiveTtl);
  if (record.storageVersion === 1) await _redisSet(streamId, record, effectiveTtl);
  await _redisSet(streamId, record, effectiveTtl, 'touch');
  return true;
}

async function touch(streamId, options = {}) {
  if (!streamId) return false;
  return _runExclusive(streamId, () => _touchImpl(streamId, options.ttlSeconds));
}

/**
 * Mark the session complete (graceful end of stream). Caller may also
 * delete the record afterwards to release storage early.
 */
async function _completeImpl(streamId, ttlSeconds) {
  let record = _memoryGet(streamId) || await _redisGet(streamId);
  if (!record) return;
  if (record.storageVersion === 1) await _redisSet(streamId, record, ttlSeconds);
  record.complete = true;
  _memorySet(streamId, record, ttlSeconds);
  await _redisSet(streamId, record, ttlSeconds, 'complete');
}

async function complete(streamId, { ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  if (!streamId) return;
  // Serialized after any in-flight appends so it can't read a pre-append
  // snapshot and a late append can't resurrect complete:false on Redis.
  return _runExclusive(streamId, () => _completeImpl(streamId, ttlSeconds));
}

/**
 * Record a fatal stream error. Resumes that hit this will see it and
 * surface to the client.
 */
async function _failImpl(streamId, message, ttlSeconds) {
  let record = _memoryGet(streamId) || await _redisGet(streamId);
  if (!record) {
    record = normalizeRecord({ chunks: [], complete: false, error: null, ttlSeconds });
  }
  if (record.storageVersion === 1) await _redisSet(streamId, record, ttlSeconds);
  record.error = String(message || 'stream_failed');
  _memorySet(streamId, record, ttlSeconds);
  await _redisSet(streamId, record, ttlSeconds, 'fail');
}

async function fail(streamId, message, { ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  if (!streamId) return;
  return _runExclusive(streamId, () => _failImpl(streamId, message, ttlSeconds));
}

async function destroy(streamId) {
  if (!streamId) return;
  // Serialize the delete behind any in-flight appends so a late append's
  // write can't re-create the record after destroy.
  return _runExclusive(streamId, async () => {
    _memoryDelete(streamId);
    await _redisDel(streamId);
  });
}

/**
 * Load a record without mutating it. Used by the resume handler to
 * replay chunks before re-attaching upstream.
 */
async function load(streamId) {
  if (!streamId) return null;
  return _memoryGet(streamId) || await _redisGet(streamId);
}

module.exports = {
  open,
  openExisting,
  append,
  touch,
  complete,
  fail,
  destroy,
  load,
  parseLastEventId,
  generateStreamId,
  DEFAULT_TTL_SECONDS,
  DEFAULT_MAX_CHUNKS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_MEMORY_BYTES,
  replayAfter,
  redisKeys,
  // Test seams
  _setInjectedRedis,
  _setNowForTests,
  _resetForTests,
};
