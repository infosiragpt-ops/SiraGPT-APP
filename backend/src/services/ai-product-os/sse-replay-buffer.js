'use strict';

/**
 * sse-replay-buffer — per-stream ring buffer that lets a client which
 * dropped its SSE connection mid-response reconnect with the
 * `Last-Event-ID` header and pick up exactly where it left off,
 * without us re-running the (expensive) generation. Pairs with the
 * SSE reassembler (#17) and the streaming-budget governor (#7).
 *
 * Per-stream lifecycle:
 *   const buf = createSseReplayBuffer({ capacity, ttlMs })
 *   const id = buf.append({ event, data })           // returns monotonic id
 *   const events = buf.replayFrom(lastEventId)        // events with id > lastEventId
 *   buf.size() / buf.snapshot()
 *   buf.close()                                       // future appends throw
 *
 * Multi-stream coordinator:
 *   const reg = createReplayRegistry({ capacity, ttlMs, gcIntervalMs })
 *   const buf = reg.openStream(streamId)
 *   reg.replayFrom(streamId, lastEventId)
 *   reg.closeStream(streamId)
 *   reg.gc() / reg.snapshot()
 *
 * Event ids are monotonic per-stream integers serialized as decimal
 * strings (matches what most browsers send back in Last-Event-ID).
 * Old events past `capacity` or `ttlMs` are evicted; the registry's
 * `gcIntervalMs` runs the sweep on a setInterval (unref'd).
 */

const DEFAULT_CAPACITY = 256;
const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_GC_INTERVAL_MS = 60_000;

class StreamClosedError extends Error {
  constructor(streamId) {
    super(`sse-replay-buffer: stream "${streamId || 'anonymous'}" is closed`);
    this.name = 'StreamClosedError';
    this.code = 'STREAM_CLOSED';
  }
}

function createSseReplayBuffer(opts = {}) {
  const capacity = Number.isFinite(opts.capacity) && opts.capacity > 0
    ? Math.floor(opts.capacity)
    : DEFAULT_CAPACITY;
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0
    ? Math.floor(opts.ttlMs)
    : DEFAULT_TTL_MS;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const streamId = typeof opts.streamId === 'string' ? opts.streamId : null;

  /** @type {Array<{id:number, event:string|null, data:string, ts:number}>} */
  const events = [];
  let nextId = 1;
  let closed = false;
  let totalAppended = 0;
  let totalReplayed = 0;

  function pruneAge(t) {
    const cutoff = t - ttlMs;
    let i = 0;
    while (i < events.length && events[i].ts < cutoff) i += 1;
    if (i > 0) events.splice(0, i);
  }

  function pruneCapacity() {
    const overflow = events.length - capacity;
    if (overflow > 0) events.splice(0, overflow);
  }

  function append({ event = null, data = '', id = null } = {}) {
    if (closed) throw new StreamClosedError(streamId);
    const t = now();
    pruneAge(t);
    const useId = Number.isFinite(id) && id >= nextId ? Math.floor(id) : nextId;
    nextId = useId + 1;
    events.push({ id: useId, event, data: String(data), ts: t });
    pruneCapacity();
    totalAppended += 1;
    return useId;
  }

  function replayFrom(lastEventId) {
    pruneAge(now());
    const since = Number(lastEventId);
    if (!Number.isFinite(since)) return events.slice();
    const out = events.filter((e) => e.id > since);
    totalReplayed += out.length;
    return out;
  }

  function size() {
    pruneAge(now());
    return events.length;
  }

  function close() { closed = true; }

  function snapshot() {
    return {
      streamId,
      size: size(),
      capacity,
      ttlMs,
      nextId,
      closed,
      totalAppended,
      totalReplayed,
      oldest: events[0] ? events[0].id : null,
      newest: events[events.length - 1] ? events[events.length - 1].id : null,
    };
  }

  return { append, replayFrom, size, close, snapshot, isClosed: () => closed };
}

function createReplayRegistry(opts = {}) {
  const capacity = opts.capacity;
  const ttlMs = opts.ttlMs;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const gcIntervalMs = Number.isFinite(opts.gcIntervalMs) && opts.gcIntervalMs > 0
    ? Math.floor(opts.gcIntervalMs)
    : DEFAULT_GC_INTERVAL_MS;

  const streams = new Map();

  function openStream(streamId) {
    if (typeof streamId !== 'string' || !streamId) throw new TypeError('openStream: streamId required');
    let buf = streams.get(streamId);
    if (!buf || buf.isClosed()) {
      buf = createSseReplayBuffer({ capacity, ttlMs, now, streamId });
      streams.set(streamId, buf);
    }
    return buf;
  }

  function closeStream(streamId) {
    const buf = streams.get(streamId);
    if (!buf) return false;
    buf.close();
    return true;
  }

  function getStream(streamId) {
    return streams.get(streamId) || null;
  }

  function replayFrom(streamId, lastEventId) {
    const buf = streams.get(streamId);
    if (!buf) return [];
    return buf.replayFrom(lastEventId);
  }

  function gc() {
    const cutoff = now() - (Number.isFinite(ttlMs) ? ttlMs : DEFAULT_TTL_MS);
    let removed = 0;
    for (const [id, buf] of streams) {
      const snap = buf.snapshot();
      // A closed stream with empty buffer or no recent activity is GC-able.
      if (snap.closed && snap.size === 0) {
        streams.delete(id);
        removed += 1;
        continue;
      }
      // Force a size() walk so age-based prune fires; if nothing remains
      // and the stream is closed, drop it.
      if (buf.size() === 0 && snap.closed) {
        streams.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  function startGcLoop() {
    const handle = setInterval(() => { try { gc(); } catch { /* swallow */ } }, gcIntervalMs);
    if (typeof handle.unref === 'function') handle.unref();
    return () => clearInterval(handle);
  }

  function snapshot() {
    return {
      streams: streams.size,
      gcIntervalMs,
      open: [...streams.values()].filter((b) => !b.isClosed()).length,
    };
  }

  return { openStream, closeStream, getStream, replayFrom, gc, startGcLoop, snapshot };
}

module.exports = {
  createSseReplayBuffer,
  createReplayRegistry,
  StreamClosedError,
  DEFAULT_CAPACITY,
  DEFAULT_TTL_MS,
  DEFAULT_GC_INTERVAL_MS,
};
