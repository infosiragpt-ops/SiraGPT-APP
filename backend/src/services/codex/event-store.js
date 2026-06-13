'use strict';

/**
 * codex/event-store — append-only persistence + live fan-out for run events
 * (spec docs/codex-agent-ux.md §5, feature 04). Every event:
 *   1. is validated against the typed catalog (event-types.js),
 *   2. gets a monotonic per-run `seq` (gapless, no duplicates),
 *   3. is INSERTed into `codex_events` (the replay source of truth),
 *   4. is PUBLISHed best-effort on Redis `codex:run:<runId>` for live SSE.
 *
 * Appends for the same run are serialized in-process (a per-run promise chain)
 * so concurrent callers still produce 1..N without gaps; the DB unique
 * `(runId, seq)` + a bounded refetch/retry is the cross-process backstop.
 *
 * prisma + publish are injectable so tests stay fully offline.
 */

const { isValidEvent, isPersistedEventType, buildEnvelope } = require('./event-types');
const pubsub = require('./redis-pubsub');

const defaultPrisma = (() => {
  try { return require('../../config/database'); } catch { return null; }
})();

// Per-run next-seq cache and append serialization chain (process-local).
const seqCache = new Map(); // runId -> next seq (Int)
const appendChains = new Map(); // runId -> Promise (tail of the serialized chain)

const MAX_COLLISION_RETRIES = 5;

function requireDb(db) {
  if (!db || !db.codexEvent) throw new Error('database unavailable');
  return db;
}

async function maxSeq(prisma, runId) {
  const row = await prisma.codexEvent.aggregate({
    where: { runId },
    _max: { seq: true },
  });
  const m = row?._max?.seq;
  return Number.isInteger(m) ? m : 0;
}

function isUniqueViolation(err) {
  return err && (err.code === 'P2002' || /unique/i.test(String(err.message || '')));
}

async function insertWithSeq(prisma, runId, type, data) {
  // Lazily initialise the per-run counter from the DB high-water mark.
  if (!seqCache.has(runId)) {
    seqCache.set(runId, (await maxSeq(prisma, runId)) + 1);
  }
  let attempts = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const seq = seqCache.get(runId);
    try {
      const row = await prisma.codexEvent.create({
        data: { runId, seq, type, payload: data ?? {} },
      });
      seqCache.set(runId, seq + 1);
      return row;
    } catch (err) {
      if (isUniqueViolation(err) && attempts < MAX_COLLISION_RETRIES) {
        attempts += 1;
        // Another writer (or a stale cache) claimed this seq — re-sync and retry.
        seqCache.set(runId, (await maxSeq(prisma, runId)) + 1);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Append one persisted event. Validates type+data, assigns seq, persists and
 * publishes. Returns the wire envelope `{ runId, seq, ts, type, data }`.
 * Throws on unknown/invalid event or a wire-only type (heartbeat is not stored).
 */
async function appendEvent(runId, type, data, { prisma = defaultPrisma, publish, env } = {}) {
  if (!isPersistedEventType(type)) {
    throw new Error(`codex event-store: type "${type}" is not persistable`);
  }
  if (!isValidEvent(type, data)) {
    throw new Error(`codex event-store: invalid payload for event "${type}"`);
  }
  const db = requireDb(prisma);

  // Serialize appends per run so seq stays gapless under concurrency.
  const prev = appendChains.get(runId) || Promise.resolve();
  const task = prev.catch(() => {}).then(() => insertWithSeq(db, runId, type, data));
  appendChains.set(runId, task);
  let row;
  try {
    row = await task;
  } finally {
    if (appendChains.get(runId) === task) appendChains.delete(runId);
  }

  const envelope = buildEnvelope({
    runId,
    seq: row.seq,
    type,
    data: row.payload,
    ts: row.createdAt ? new Date(row.createdAt).toISOString() : undefined,
  });

  // Best-effort live fan-out (never blocks the durable path).
  const doPublish = publish || ((rid, env_) => pubsub.publishEvent(rid, env_, { env }));
  try {
    await doPublish(runId, envelope);
  } catch {
    /* publish is best-effort; replay covers any loss */
  }

  return envelope;
}

/**
 * Replay: events with seq > afterSeq, ordered ascending. Returns wire
 * envelopes ready to write to an SSE stream.
 */
async function listEvents(runId, { afterSeq = 0, limit = 5000, prisma = defaultPrisma } = {}) {
  const db = requireDb(prisma);
  const rows = await db.codexEvent.findMany({
    where: { runId, seq: { gt: Number(afterSeq) || 0 } },
    orderBy: { seq: 'asc' },
    take: Math.max(1, Math.min(20000, Number(limit) || 5000)),
  });
  return rows.map((r) =>
    buildEnvelope({
      runId,
      seq: r.seq,
      type: r.type,
      data: r.payload,
      ts: r.createdAt ? new Date(r.createdAt).toISOString() : undefined,
    }),
  );
}

/**
 * Stateful seq de-dup gate for an SSE stream. The stream writes the replay,
 * then flushes events buffered during subscribe, then live events — possibly
 * with overlap on reconnection. `shouldEmit(seq)` returns true exactly once
 * per distinct seq so a client never sees a duplicate, regardless of order.
 * Non-numeric seqs (e.g. heartbeats) always pass.
 */
function createSeqGate() {
  const seen = new Set();
  return {
    shouldEmit(seq) {
      if (typeof seq !== 'number' || !Number.isFinite(seq)) return true;
      if (seen.has(seq)) return false;
      seen.add(seq);
      return true;
    },
    seenCount: () => seen.size,
  };
}

/** Test hook: forget the in-memory seq counter for a run (or all runs). */
function _resetSeqCache(runId) {
  if (runId === undefined) {
    seqCache.clear();
    appendChains.clear();
  } else {
    seqCache.delete(runId);
    appendChains.delete(runId);
  }
}

module.exports = { appendEvent, listEvents, createSeqGate, _resetSeqCache };
