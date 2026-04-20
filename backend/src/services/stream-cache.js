/**
 * stream-cache — server-side snapshot of in-flight chat streams.
 *
 * The problem: the existing stream goes straight from OpenAI to the
 * HTTP response. If the client disconnects (browser tab closed,
 * network blip, hard reload), the partial answer is lost even though
 * the upstream call may have continued.
 *
 * This module lets the stream handler mirror chunks into a
 * server-side cache keyed by (userId, chatId). A new request can
 * then call `resume(userId, chatId)` to retrieve the partial content
 * (and the final content if the stream already finished).
 *
 * Current implementation: in-memory `Map` with a TTL reaper. That's
 * enough to cover the common real-world cases:
 *   - User opens the same chat in two tabs (resume pulls partial)
 *   - User reloads the chat while an answer is generating (resume)
 *   - Server restart: entries are lost (acceptable trade-off for now)
 *
 * Production replacement: swap the `Map` here for Redis. Callers
 * never see the difference — same ingest/fetch surface.
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000;  // 10 minutes
const REAP_INTERVAL_MS = 60 * 1000;     // 1 minute

const cache = new Map(); // key = `${userId}:${chatId}` → Entry

let reaperHandle = null;
function ensureReaper() {
  if (reaperHandle) return;
  reaperHandle = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (v.expiresAt <= now) cache.delete(k);
    }
  }, REAP_INTERVAL_MS);
  // Don't keep the process alive just for the reaper.
  if (typeof reaperHandle.unref === 'function') reaperHandle.unref();
}

function key(userId, chatId) {
  return `${userId || 'anon'}:${chatId}`;
}

/**
 * Start a new cached stream. Returns an opaque handle with append /
 * complete / fail methods. The handle is cheap — it mutates the same
 * entry in the Map in place so consumers can read progress with
 * `resume()` at any time.
 */
function start(userId, chatId, { ttlMs = DEFAULT_TTL_MS, title = '' } = {}) {
  ensureReaper();
  const entry = {
    userId,
    chatId,
    title,
    status: 'streaming',
    content: '',
    error: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
  };
  cache.set(key(userId, chatId), entry);
  return {
    append(chunk) {
      if (!chunk) return;
      entry.content += chunk;
      entry.updatedAt = Date.now();
      entry.expiresAt = entry.updatedAt + ttlMs;
    },
    complete() {
      entry.status = 'done';
      entry.updatedAt = Date.now();
      entry.expiresAt = entry.updatedAt + ttlMs;
    },
    fail(message) {
      entry.status = 'error';
      entry.error = message || 'stream failed';
      entry.updatedAt = Date.now();
      entry.expiresAt = entry.updatedAt + ttlMs;
    },
    forget() {
      cache.delete(key(userId, chatId));
    },
  };
}

/**
 * Read the current cached state for a chat. Returns null when nothing
 * is cached (either never started or already reaped).
 */
function resume(userId, chatId) {
  const e = cache.get(key(userId, chatId));
  if (!e) return null;
  return {
    status: e.status,
    content: e.content,
    title: e.title,
    error: e.error,
    startedAt: e.startedAt,
    updatedAt: e.updatedAt,
  };
}

/** Test helpers — not part of the public contract. */
function _reset() { cache.clear(); }
function _size() { return cache.size; }

module.exports = { start, resume, _reset, _size };
