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
 * Every record is JSON: { chunks: string[], complete: boolean, error?: string }
 * The position is the **count of frames already sent** (i.e. chunks.length
 * at the time of the last successful flush). On resume the client sends
 * `Last-Event-ID: <streamId>:<position>` and the handler replays
 * `chunks.slice(position)` before continuing.
 *
 * Failure policy: every Redis call is best-effort. A storage error
 * downgrades to "no resume available" — the request path is never broken.
 */

const DEFAULT_TTL_SECONDS = 5 * 60; // 5 minutes
const DEFAULT_MAX_CHUNKS = 4000;    // hard cap per-stream to bound memory
const KEY_PREFIX = 'sira:sse-resume:';

let _injectedRedis = null;
let _ioredisClient = null;
const _memoryStore = new Map(); // streamId -> { record, expiresAt }

function _now() { return Date.now(); }

function _setInjectedRedis(client) {
  // Test seam — pass an ioredis-compatible fake.
  _injectedRedis = client;
}

function _resetForTests() {
  _injectedRedis = null;
  _ioredisClient = null;
  _memoryStore.clear();
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
    _memoryStore.delete(streamId);
    return null;
  }
  return entry.record;
}

function _memorySet(streamId, record, ttlSeconds) {
  _memoryStore.set(streamId, {
    record,
    expiresAt: _now() + (ttlSeconds * 1000),
  });
}

async function _redisGet(streamId) {
  const redis = _getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(`${KEY_PREFIX}${streamId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function _redisSet(streamId, record, ttlSeconds) {
  const redis = _getRedis();
  if (!redis) return false;
  try {
    await redis.set(`${KEY_PREFIX}${streamId}`, JSON.stringify(record), 'EX', ttlSeconds);
    return true;
  } catch {
    return false;
  }
}

async function _redisDel(streamId) {
  const redis = _getRedis();
  if (!redis) return false;
  try {
    await redis.del(`${KEY_PREFIX}${streamId}`);
    return true;
  } catch {
    return false;
  }
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
  const position = Number.parseInt(posStr, 10);
  if (!streamId || !Number.isFinite(position) || position < 0) return null;
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
    const fromRedis = await _redisGet(streamId);
    if (fromRedis) return { streamId, record: fromRedis, isResume: true };
    const fromMem = _memoryGet(streamId);
    if (fromMem) return { streamId, record: fromMem, isResume: true };
  }
  const id = streamId || generateStreamId();
  const record = { chunks: [], complete: false, error: null, ttlSeconds };
  // Persist initial empty record so a fast reconnect finds it
  _memorySet(id, record, ttlSeconds);
  await _redisSet(id, record, ttlSeconds);
  return { streamId: id, record, isResume: false };
}

/**
 * Append a chunk to the session. Returns the new position (1-based length).
 * Chunks beyond DEFAULT_MAX_CHUNKS are dropped silently — keeps memory bounded.
 */
async function append(streamId, chunk, { ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  if (!streamId) return 0;
  let record = _memoryGet(streamId) || await _redisGet(streamId);
  if (!record) {
    record = { chunks: [], complete: false, error: null, ttlSeconds };
  }
  if (record.complete) return record.chunks.length;
  if (record.chunks.length < DEFAULT_MAX_CHUNKS && typeof chunk === 'string' && chunk.length > 0) {
    record.chunks.push(chunk);
  }
  _memorySet(streamId, record, ttlSeconds);
  // Fire-and-forget redis write (best-effort persistence)
  await _redisSet(streamId, record, ttlSeconds);
  return record.chunks.length;
}

/**
 * Mark the session complete (graceful end of stream). Caller may also
 * delete the record afterwards to release storage early.
 */
async function complete(streamId, { ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  if (!streamId) return;
  let record = _memoryGet(streamId) || await _redisGet(streamId);
  if (!record) return;
  record.complete = true;
  _memorySet(streamId, record, ttlSeconds);
  await _redisSet(streamId, record, ttlSeconds);
}

/**
 * Record a fatal stream error. Resumes that hit this will see it and
 * surface to the client.
 */
async function fail(streamId, message, { ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  if (!streamId) return;
  let record = _memoryGet(streamId) || await _redisGet(streamId);
  if (!record) {
    record = { chunks: [], complete: false, error: null, ttlSeconds };
  }
  record.error = String(message || 'stream_failed');
  _memorySet(streamId, record, ttlSeconds);
  await _redisSet(streamId, record, ttlSeconds);
}

async function destroy(streamId) {
  if (!streamId) return;
  _memoryStore.delete(streamId);
  await _redisDel(streamId);
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
  append,
  complete,
  fail,
  destroy,
  load,
  parseLastEventId,
  generateStreamId,
  DEFAULT_TTL_SECONDS,
  DEFAULT_MAX_CHUNKS,
  // Test seams
  _setInjectedRedis,
  _resetForTests,
};
