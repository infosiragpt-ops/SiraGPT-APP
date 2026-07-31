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
// Durable inserts may finish before an earlier append has completed its
// best-effort Redis publish. Keep publication FIFO per process as well, so a
// local fan-out cannot observe seq N before seq N-1. The client still performs
// gap recovery for cross-instance Redis races.
const publishChains = new Map(); // runId -> Promise (tail of the publish chain)
const transcriptSinks = new Map(); // runId -> async (envelope) => void

const MAX_COLLISION_RETRIES = 5;
const DEFAULT_REPLAY_PAGE_SIZE = 5000;
const MAX_REPLAY_PAGE_SIZE = 20000;
const MAX_REPLAY_EVENTS = 100000;

function requireDb(db) {
  if (!db || !db.codexEvent) throw new Error('database unavailable');
  return db;
}

async function publishWithinDeadline(publish, runId, envelope, env) {
  const timeoutMs = typeof pubsub.resolvePublishTimeoutMs === 'function'
    ? pubsub.resolvePublishTimeoutMs(env)
    : 200;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => publish(runId, envelope)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`event publish timed out after ${timeoutMs}ms`);
          err.code = 'CODEX_EVENT_PUBLISH_TIMEOUT';
          reject(err);
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    /* publish is best-effort; replay covers any loss */
  } finally {
    clearTimeout(timer);
  }
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

  // Best-effort live fan-out (never blocks the durable path). Publish in the
  // same order as the per-run durable append chain. Without this second chain,
  // append N+1 could publish while append N is still waiting on Redis, which
  // lets a single process create an observable SSE gap.
  const doPublish = publish || ((rid, env_) => pubsub.publishEvent(rid, env_, { env }));
  const previousPublish = publishChains.get(runId) || Promise.resolve();
  const publishTask = previousPublish
    .catch(() => {})
    .then(() => publishWithinDeadline(doPublish, runId, envelope, env));
  publishChains.set(runId, publishTask);
  // Do not make the durable append wait for the fan-out queue. Each publish
  // is bounded and ordered, while the caller gets its committed envelope
  // immediately; replay/gap recovery covers a slow or unavailable publisher.
  publishTask.then(
    () => {
      if (publishChains.get(runId) === publishTask) publishChains.delete(runId);
    },
    () => {
      if (publishChains.get(runId) === publishTask) publishChains.delete(runId);
    },
  );

  const transcriptSink = transcriptSinks.get(runId);
  if (transcriptSink) {
    try {
      await transcriptSink(envelope);
    } catch {
      /* transcript is a secondary artifact; the durable DB event already won */
    }
  }

  return envelope;
}

/**
 * Replay: events with seq > afterSeq, ordered ascending. Returns wire
 * envelopes ready to write to an SSE stream.
 */
async function listEvents(runId, options = {}) {
  const {
    afterSeq = 0,
    limit,
    prisma = defaultPrisma,
  } = options;
  const db = requireDb(prisma);
  // `limit: undefined` is equivalent to omitting the option. In particular it
  // must not disable the paginated default replay path.
  const hasExplicitLimit = Object.prototype.hasOwnProperty.call(options, 'limit')
    && options.limit !== undefined;
  const requestedLimit = Number(limit);
  const pageSize = Math.max(
    1,
    Math.min(
      MAX_REPLAY_PAGE_SIZE,
      hasExplicitLimit && Number.isFinite(requestedLimit)
        ? requestedLimit
        : DEFAULT_REPLAY_PAGE_SIZE,
    ),
  );
  const rows = [];
  let cursor = Number(afterSeq) || 0;

  // A caller that supplies `limit` gets one bounded page for compatibility.
  // The default path transparently follows pages so a terminal run with more
  // than 5000 events is fully replayable before the SSE route closes it.
  do {
    const page = await db.codexEvent.findMany({
      where: { runId, seq: { gt: cursor } },
      orderBy: { seq: 'asc' },
      take: pageSize,
    });
    rows.push(...page);
    if (!page.length || hasExplicitLimit || page.length < pageSize) break;
    const nextCursor = page[page.length - 1]?.seq;
    if (!Number.isInteger(nextCursor) || nextCursor <= cursor) break;
    cursor = nextCursor;
  } while (rows.length < MAX_REPLAY_EVENTS);

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
    publishChains.clear();
  } else {
    seqCache.delete(runId);
    appendChains.delete(runId);
    publishChains.delete(runId);
  }
}

/**
 * Lifecycle hook: drop the per-run in-memory seq counter + append-chain once a
 * run reaches a terminal state, so these process-local Maps don't grow one
 * entry per run forever. The seq counter is rebuildable from the DB high-water
 * mark if the run is ever touched again.
 */
function forgetRun(runId) {
  if (runId === undefined) return;
  // Keep a queued publish chain alive until its bounded fan-out settles. A
  // terminal run normally has no later events, but dropping the chain here
  // would let a late append create a second chain and overtake the tail.
  seqCache.delete(runId);
  appendChains.delete(runId);
  transcriptSinks.delete(runId);
}

function registerTranscriptSink(runId, sink) {
  if (!runId || typeof sink !== 'function') throw new TypeError('runId and transcript sink are required');
  transcriptSinks.set(runId, sink);
  return () => {
    if (transcriptSinks.get(runId) === sink) transcriptSinks.delete(runId);
  };
}

module.exports = {
  appendEvent,
  listEvents,
  createSeqGate,
  registerTranscriptSink,
  _resetSeqCache,
  forgetRun,
};
