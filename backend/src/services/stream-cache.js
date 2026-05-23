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
 * Implementation: in-memory quick-lru with maxSize plus per-entry
 * maxAge. quick-lru is ESM-only, so we lazy-load it once via dynamic
 * `import()` from this CommonJS module. Sliding TTL is preserved by
 * re-`set()`-ing the entry on every append/complete/fail; that
 * resets quick-lru's per-entry expiration without changing the
 * value reference, so handle closures keep mutating the same object.
 *
 * This replaces the previous `Map` + manual reaper combo. Two wins:
 *   - Hard maxSize bound: a runaway producer can't fill memory with
 *     orphan stream snapshots.
 *   - No more `setInterval` reaper holding a reference (and a
 *     potential pin) to the closure.
 *
 * Production replacement: swap quick-lru here for Redis. Callers
 * never see the difference — same start/resume surface.
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000;            // 10 minutes
const DEFAULT_MAX_STREAMS = Math.max(
  16,
  Number(process.env.STREAM_CACHE_MAX_ENTRIES) || 1000,
);

let _cachePromise = null;
function getCacheInstance() {
  if (!_cachePromise) {
    _cachePromise = import('quick-lru').then(({ default: QuickLRU }) =>
      new QuickLRU({ maxSize: DEFAULT_MAX_STREAMS, maxAge: DEFAULT_TTL_MS })
    );
  }
  return _cachePromise;
}

function key(userId, chatId) {
  return `${userId || 'anon'}:${chatId}`;
}

/**
 * Start a new cached stream. Returns an opaque handle with append /
 * complete / fail methods. The handle mutates the same entry object
 * in place so consumers can read progress with `resume()` at any
 * time. Each mutation also re-sets the entry in the LRU so the TTL
 * slides while a stream is actively producing.
 *
 * Async because the LRU is loaded lazily via dynamic ESM import.
 */
async function start(userId, chatId, { ttlMs = DEFAULT_TTL_MS, title = '' } = {}) {
  const cache = await getCacheInstance();
  const k = key(userId, chatId);
  const entry = {
    userId,
    chatId,
    title,
    status: 'streaming',
    content: '',
    error: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    taskId: null,
    agentPhase: null,
    agentPercent: null,
  };
  cache.set(k, entry);

  // ttlMs is accepted for API compatibility but the live cache uses a
  // single instance-wide maxAge. Per-entry override would require
  // a wrapper LRU per TTL bucket; not worth it for now.
  void ttlMs;

  return {
    append(chunk) {
      if (!chunk) return;
      entry.content += chunk;
      entry.updatedAt = Date.now();
      cache.set(k, entry); // refresh sliding TTL
    },
    replace(content) {
      entry.content = String(content || '');
      entry.updatedAt = Date.now();
      entry.expiresAt = entry.updatedAt + ttlMs;
    },
    complete() {
      entry.status = 'done';
      entry.updatedAt = Date.now();
      cache.set(k, entry);
    },
    fail(message) {
      entry.status = 'error';
      entry.error = message || 'stream failed';
      entry.updatedAt = Date.now();
      cache.set(k, entry);
    },
    setAgentProgress({ taskId, phase, percent } = {}) {
      if (taskId) entry.taskId = String(taskId);
      if (phase) entry.agentPhase = String(phase);
      if (Number.isFinite(Number(percent))) {
        entry.agentPercent = Math.max(0, Math.min(100, Math.floor(Number(percent))));
      }
      entry.updatedAt = Date.now();
      cache.set(k, entry);
    },
    forget() {
      cache.delete(k);
    },
  };
}

/**
 * Read the current cached state for a chat. Returns null when nothing
 * is cached (either never started or already evicted).
 *
 * Async because the LRU is loaded lazily via dynamic ESM import.
 */
async function resume(userId, chatId) {
  const cache = await getCacheInstance();
  const e = cache.get(key(userId, chatId));
  if (!e) return null;
  return {
    status: e.status,
    content: e.content,
    title: e.title,
    error: e.error,
    startedAt: e.startedAt,
    updatedAt: e.updatedAt,
    taskId: e.taskId || null,
    agentPhase: e.agentPhase || null,
    agentPercent: e.agentPercent ?? null,
  };
}

/**
 * Update agent progress for a chat without an active text stream handle.
 */
async function updateAgentProgress(userId, chatId, progress = {}) {
  const cache = await getCacheInstance();
  const k = key(userId, chatId);
  const e = cache.get(k);
  if (!e) return null;
  if (progress.taskId) e.taskId = String(progress.taskId);
  if (progress.phase) e.agentPhase = String(progress.phase);
  if (Number.isFinite(Number(progress.percent))) {
    e.agentPercent = Math.max(0, Math.min(100, Math.floor(Number(progress.percent))));
  }
  e.updatedAt = Date.now();
  cache.set(k, e);
  return {
    taskId: e.taskId,
    agentPhase: e.agentPhase,
    agentPercent: e.agentPercent,
    updatedAt: e.updatedAt,
  };
}

/** Test helpers — not part of the public contract. */
async function _reset() { (await getCacheInstance()).clear(); }
async function _size() { return (await getCacheInstance()).size; }

module.exports = { start, resume, updateAgentProgress, _reset, _size };
