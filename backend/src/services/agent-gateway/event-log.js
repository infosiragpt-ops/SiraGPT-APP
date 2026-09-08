'use strict';

/**
 * 3H-BE-009 — per-session gateway event ring for Last-Event-ID replay.
 * 3H2-BE-021 leftover: stamp seq, TTL prune so replay cannot grow forever.
 * OpenClaw idea rewritten: events are sequenced and resumable. No source copied.
 */

const DEFAULT_MAX = 200;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

function createEventLog({ max = DEFAULT_MAX, ttlMs = DEFAULT_TTL_MS } = {}) {
  const rings = new Map(); // sessionKey -> frames[]
  const hashes = new Map(); // sessionKey -> Map(hash -> at)
  const sweepState = { lastSweepAt: 0 };
  const watermarks = new Map();
  // 3H16: per-session seq (strict event order on the single gateway).
  // A global counter made Last-Event-ID from session A skip frames in B.

  function prune(list, now) {
    const cut = now - ttlMs;
    while (list.length && Number(list[0] && list[0].at || 0) < cut) list.shift();
    while (list.length > max) list.shift();
    return list;
  }

  function remember(sessionKey, frame) {
    const key = String(sessionKey || '');
    if (!key || !frame) return 0;
    const list = prune(rings.get(key) || [], Date.now());
    const lastSeq = list.length ? Number(list[list.length - 1].seq) || 0 : 0;
    let seq;
    try {
      const stamped = require('../agent-runner/engine-completion').stampMonotonicSeq(lastSeq, frame.seq);
      seq = stamped.seq;
    } catch (_) {
      seq = frame.seq != null ? Number(frame.seq) : lastSeq + 1;
      if (!Number.isFinite(seq) || seq !== lastSeq + 1) seq = lastSeq + 1;
    }
    const stamped = {
      ...frame,
      seq,
      id: frame.id != null ? frame.id : seq,
      at: frame.at || Date.now(),
    };
    try {
      const nxt = require('../agent-runner/engine-next');
      const layer = require('../agent-runner/engine-layer');
      if (!hashes.has(key)) hashes.set(key, new Map());
      const store = hashes.get(key);
      layer.pruneHashTtl(store);
      const hash = nxt.eventContentHash(key, stamped);
      const dup = layer.rememberHashTtl(store, hash);
      if (dup.duplicate) return list.length;
    } catch (_) { /* fail-open */ }
    list.push(stamped);
    const beforeLen = list.length;
    try {
      const parity = require('../agent-runner/engine-parity');
      const capped = parity.dropOldestSse(list, max);
      if (capped && capped.dropped) list.splice(0, list.length, ...capped.frames);
      parity.watermarkLastEventId(watermarks, key, stamped.seq);
    } catch (_) { /* optional */ }
    rings.set(key, prune(list, Date.now()));
    try {
      const ops = require('../agent-runner/engine-ops');
      const kept = rings.get(key) || [];
      const dropped = Math.max(0, beforeLen - kept.length);
      if (dropped > 0) ops.recordReplayMetrics({ frames: kept, dropped, truncated: true });
    } catch (_) { /* optional */ }
    try {
      const dur = require('../agent-runner/engine-durability');
      Promise.resolve(dur.persistEventFrame(dur.getSharedKv(), key, stamped)).catch(() => {});
    } catch (_) { /* fail-open in-memory ring */ }
    return list.length;
  }

  function replayFrom(sessionKey, lastId) {
    const key = String(sessionKey || '');
    const n = Number(lastId) || 0;
    const list = prune(rings.get(key) || [], Date.now());
    rings.set(key, list);
    let local = list.filter((f) => Number(f && (f.seq != null ? f.seq : f.id)) > n);
    try {
      const { fillSseGaps, rememberIdempotent } = require('../agent-runner/engine-hardening');
      local = fillSseGaps(local, n).frames;
    } catch (_) { /* no fill */ }
    if (local.length) return local;
    // Durable Last-Event-ID resume after backend recreate (empty in-memory ring).
    try {
      const dur = require('../agent-runner/engine-durability');
      const pending = dur.replayEventFrames(dur.getSharedKv(), key, n);
      if (pending && typeof pending.then === 'function') {
        // Sync API: hydrate from a cached last-replay if a prior await populated rings.
        return local;
      }
      if (Array.isArray(pending) && pending.length) return pending;
    } catch (_) { /* in-memory only */ }
    return local;
  }

  async function replayFromDurable(sessionKey, lastId) {
    const local = replayFrom(sessionKey, lastId);
    if (local.length) return local;
    try {
      const dur = require('../agent-runner/engine-durability');
      return await dur.replayEventFrames(dur.getSharedKv(), String(sessionKey || ''), lastId);
    } catch (_) {
      return [];
    }
  }

  function lastSeq(sessionKey) {
    const list = rings.get(String(sessionKey || '')) || [];
    if (!list.length) return 0;
    return Number(list[list.length - 1].seq) || 0;
  }

  function watermark(sessionKey) {
    try {
      const parity = require('../agent-runner/engine-parity');
      return parity.readWatermark(watermarks, sessionKey).seq;
    } catch (_) {
      return lastSeq(sessionKey);
    }
  }

  function size(sessionKey) {
    if (sessionKey == null) return rings.size;
    return (rings.get(String(sessionKey)) || []).length;
  }

  function clear(sessionKey) {
    if (sessionKey == null) {
      rings.clear();
      hashes.clear();
    } else {
      rings.delete(String(sessionKey));
      hashes.delete(String(sessionKey));
    }
  }

  function pruneHashes({ now = Date.now(), ttlMs, intervalMs } = {}) {
    let pruned = 0;
    let swept = false;
    try {
      const ops = require('../agent-runner/engine-ops');
      const due = ops.hashSweepDue(sweepState.lastSweepAt, { now, intervalMs });
      if (!due.due) return { pruned: 0, sessions: hashes.size, swept: false };
      swept = true;
      sweepState.lastSweepAt = now;
      const layer = require('../agent-runner/engine-layer');
      for (const store of hashes.values()) {
        const out = layer.pruneHashTtl(store, { now, ttlMs });
        pruned += Number(out && out.pruned) || 0;
      }
    } catch (_) { /* optional */ }
    return { pruned, sessions: hashes.size, swept };
  }

  const orphans = (function makeOrphans() {
    try { return require('../agent-runner/engine-control').createOrphanStreamRegistry(); }
    catch (_) { return { register() { return { ok: false }; }, beat() { return { ok: false }; }, close() { return { ok: false }; }, closeStale() { return { closed: 0 }; }, size() { return 0; } }; }
  }());

  function attachStream(sessionKey, closer) {
    return orphans.register(sessionKey, closer);
  }
  function beatStream(sessionKey) {
    return orphans.beat(sessionKey);
  }
  function reapOrphans(now) {
    return orphans.closeStale(now);
  }
  async function hydrate(sessionKey, lastId) {
    try {
      const control = require('../agent-runner/engine-control');
      const dur = require('../agent-runner/engine-durability');
      return await control.hydrateSseRingFromRedis({
        eventLog: { remember, replayFrom },
        kv: dur.getSharedKv(),
        sessionKey,
        lastEventId: lastId,
      });
    } catch (_) {
      return { ok: false, frames: replayFrom(sessionKey, lastId), replayed: 0, code: 'sse_resume' };
    }
  }

  return { remember, replayFrom, replayFromDurable, lastSeq, watermark, size, clear, pruneHashes, attachStream, beatStream, reapOrphans, hydrate };
}

module.exports = { createEventLog, DEFAULT_MAX, DEFAULT_TTL_MS };
