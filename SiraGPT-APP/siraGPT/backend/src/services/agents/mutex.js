/**
 * mutex — minimal async lock registry.
 *
 * Two concurrent requests from the same user on the same collection
 * (e.g. POST /ingest + POST /ingest-code arriving in the same event
 * loop tick) both mutate the in-memory store. Without serialisation
 * the second call can see a half-built state from the first. This
 * module hands out a Promise-chain-based lock keyed by any string —
 * typically `storeKey(userId, collection)` — so write paths can wrap
 * themselves in a single-writer-at-a-time guard.
 *
 * The lock is CO-OPERATIVE: a caller must wrap its work inside the
 * runWithLock callback. If it throws, the lock is released and the
 * next waiter proceeds. No zombie holders.
 *
 * Keys live in a Map and are pruned when a lock chain becomes a
 * resolved promise with no waiters — not eagerly, since Promise
 * identity doesn't let us observe that. The Map is sweeped when it
 * grows past SWEEP_THRESHOLD.
 */

const SWEEP_THRESHOLD = 1024;

// Map<key, Promise<void>> — the tail of the current lock chain for that key.
const locks = new Map();

/**
 * Run `fn` with exclusive access on `key`. Returns whatever fn returns.
 * Errors propagate to the caller; the lock is released either way.
 *
 * Multiple calls for the SAME key queue up in FIFO order. Calls for
 * DIFFERENT keys run in parallel.
 */
async function runWithLock(key, fn) {
  if (!key || typeof fn !== 'function') {
    throw new Error('runWithLock: key and fn are required');
  }

  const prev = locks.get(key) || Promise.resolve();

  // Chain our work onto the previous promise. We need a NEW promise on
  // the map so the next caller queues behind us, not behind `prev`.
  let release;
  const held = new Promise(resolve => { release = resolve; });
  locks.set(key, prev.then(() => held));

  try {
    await prev;          // wait for our turn
    return await fn();   // do the work
  } finally {
    release();
    // Opportunistic sweep: if we're the tail holder for this key AND
    // the map has grown, drop keys whose chains have resolved.
    if (locks.get(key) && (await isResolved(locks.get(key)))) {
      locks.delete(key);
    }
    if (locks.size > SWEEP_THRESHOLD) sweepResolved();
  }
}

/** Does a Promise resolve synchronously? Probe via race against a resolved sentinel. */
function isResolved(p) {
  const sentinel = {};
  return Promise.race([p, Promise.resolve(sentinel)]).then(v => v !== sentinel).catch(() => true);
}

async function sweepResolved() {
  // Non-blocking: probe each key's tail for resolved state and drop.
  for (const [k, p] of locks) {
    // eslint-disable-next-line no-await-in-loop
    if (await isResolved(p)) locks.delete(k);
  }
}

/** For tests: how many keys are currently tracked. */
function activeLockCount() { return locks.size; }

/** For tests: reset. */
function _reset() { locks.clear(); }

module.exports = {
  runWithLock,
  activeLockCount,
  _reset,
};
