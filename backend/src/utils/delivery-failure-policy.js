'use strict';

/**
 * delivery-failure-policy — DLQ + retry-exhaustion classifier for outbound
 * deliveries (webhooks, agent task callbacks, email/slack notifications,
 * downstream service calls).
 *
 * The audit log records what happened; this module decides what should
 * happen next when delivery keeps failing:
 *
 *   - classify(error) → one of:
 *       'transient'  — retryable; harness should kick off backoff
 *       'permanent'  — DO NOT retry; route to DLQ if no human intervention
 *       'poison'     — repeated permanent failure across replicas; quarantine
 *
 *   - DLQ (Dead Letter Queue) is in-memory by default with a capacity cap;
 *     a custom store can be plugged in via `{ store: customStore }`. Each
 *     DLQ entry carries: id, type, payload, createdAt, attempts, lastError,
 *     classification, replayCount, dedupeKey.
 *
 *   - replay(id, dispatcher) re-attempts a single DLQ entry through the
 *     supplied dispatcher; if delivery now succeeds, the entry is removed.
 *
 *   - Exhaustion policy: when an upstream retry harness has consumed its
 *     attempt budget, it calls policy.markExhausted(envelope, error) which
 *     classifies the failure and persists to DLQ. The classifier respects
 *     known transient HTTP statuses (408, 425, 429, 5xx) and explicit
 *     `transient: true` flags on errors.
 *
 *   - Poison detection: when the same `dedupeKey` produces N permanent
 *     failures within the policy's lifetime, classification is upgraded
 *     to 'poison' and routed to a separate quarantine bucket.
 *
 * Public API:
 *   - DeliveryFailurePolicy class
 *   - InMemoryDLQStore — default store (drop-in pluggable)
 *   - classifyError(error) — pure helper, exported for tests / external use
 *   - DeliveryError — base error type
 *   - TRANSIENT_HTTP, TRANSIENT_NET_CODES — exported sets
 */

class DeliveryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DeliveryError';
    this.code = code;
    Object.assign(this, details);
  }
}

const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_NET_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
]);

/**
 * Classify a delivery failure as transient / permanent / poison. The
 * classification respects (in priority order):
 *   1. Explicit `error.poison === true`
 *   2. Explicit `error.transient` boolean
 *   3. HTTP status code on the error (4xx → permanent except known transients)
 *   4. Network / OS error code on the error
 *   5. AbortError → transient (caller likely cancelled an in-flight retry)
 *   6. Unknown → 'transient' (let the harness's retry budget be the gate)
 */
function classifyError(err) {
  if (!err) return 'permanent';
  if (err.poison === true) return 'poison';
  if (err.transient === true) return 'transient';
  if (err.transient === false) return 'permanent';
  if (typeof err.status === 'number') {
    if (TRANSIENT_HTTP.has(err.status)) return 'transient';
    if (err.status >= 400 && err.status < 500) return 'permanent';
    if (err.status >= 500 && err.status < 600) return 'transient';
  }
  if (typeof err.code === 'string' && TRANSIENT_NET_CODES.has(err.code)) {
    return 'transient';
  }
  if (err.name === 'AbortError') return 'transient';
  return 'transient';
}

class InMemoryDLQStore {
  constructor({ capacity = 1000 } = {}) {
    this.capacity = Math.max(1, capacity | 0);
    this.items = new Map();
    this.order = [];
  }

  size() { return this.items.size; }

  list() { return Array.from(this.items.values()); }

  get(id) { return this.items.get(id) || null; }

  enqueue(entry) {
    if (!entry || typeof entry.id !== 'string') {
      throw new DeliveryError('entry_invalid', 'enqueue: entry.id required');
    }
    this.items.set(entry.id, entry);
    this.order.push(entry.id);
    while (this.order.length > this.capacity) {
      const evict = this.order.shift();
      if (evict !== entry.id) this.items.delete(evict);
    }
  }

  remove(id) {
    const ok = this.items.delete(id);
    if (ok) {
      const ix = this.order.indexOf(id);
      if (ix >= 0) this.order.splice(ix, 1);
    }
    return ok;
  }

  clear() {
    this.items.clear();
    this.order = [];
  }
}

class DeliveryFailurePolicy {
  constructor({ store, idGen, now, poisonThreshold = 5 } = {}) {
    this.store = store || new InMemoryDLQStore();
    this.idGen =
      idGen || (() => `dlq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
    this.now = now || (() => Date.now());
    this.poisonThreshold = Math.max(1, poisonThreshold | 0);
    this.poisonHistory = new Map(); // dedupeKey → permanent-failure count
    this.metrics = {
      classified: { transient: 0, permanent: 0, poison: 0 },
      dlqEnqueued: 0,
      dlqReplayed: 0,
      dlqReplaySucceeded: 0,
      dlqReplayFailed: 0,
      dlqRemoved: 0,
    };
  }

  classify(err) {
    const c = classifyError(err);
    if (this.metrics.classified[c] === undefined) this.metrics.classified[c] = 0;
    this.metrics.classified[c] += 1;
    return c;
  }

  /**
   * Called by an upstream retry harness once it has exhausted its budget.
   * Returns the DLQ entry created (or null if classification stays
   * 'transient' and `force=false`).
   *
   * @param {object} envelope — { type, payload?, meta?, attempts? }
   * @param {Error|object} err — last error encountered
   * @param {object} [opts]
   * @param {boolean} [opts.force=true] — upgrade transient → permanent on
   *   exhaustion (the typical case when retry budget is spent)
   * @param {string} [opts.dedupeKey] — used for poison detection
   */
  markExhausted(envelope, err, { force = true, dedupeKey } = {}) {
    if (!envelope || typeof envelope.type !== 'string' || envelope.type.length === 0) {
      throw new DeliveryError('envelope_invalid', 'envelope.type required');
    }
    let cls = this.classify(err);
    if (cls === 'transient' && force) cls = 'permanent';
    if (dedupeKey && cls === 'permanent') {
      const c = (this.poisonHistory.get(dedupeKey) || 0) + 1;
      this.poisonHistory.set(dedupeKey, c);
      if (c >= this.poisonThreshold) cls = 'poison';
    }
    if (cls === 'transient' && !force) return null;

    const entry = {
      id: this.idGen(),
      type: envelope.type,
      payload: envelope.payload != null ? envelope.payload : null,
      meta: envelope.meta || null,
      attempts: envelope.attempts | 0,
      lastError: serializeError(err),
      classification: cls,
      createdAt: this.now(),
      replayCount: 0,
      dedupeKey: dedupeKey || null,
    };
    this.store.enqueue(entry);
    this.metrics.dlqEnqueued += 1;
    return entry;
  }

  /**
   * Re-attempt a single DLQ entry. `dispatcher(payload, meta)` should
   * resolve on success or throw on failure.
   *
   * @returns {Promise<{ok: true, id: string} | {ok: false, id: string, error: object, classification: string}>}
   */
  async replay(id, dispatcher) {
    if (typeof id !== 'string' || !id) {
      throw new DeliveryError('id_invalid', 'replay: id required');
    }
    if (typeof dispatcher !== 'function') {
      throw new DeliveryError('dispatcher_invalid', 'dispatcher must be a function');
    }
    const entry = this.store.get(id);
    if (!entry) throw new DeliveryError('dlq_not_found', `DLQ entry ${id} not found`);

    entry.replayCount += 1;
    this.metrics.dlqReplayed += 1;
    try {
      await dispatcher(entry.payload, entry.meta || {});
      this.store.remove(id);
      this.metrics.dlqRemoved += 1;
      this.metrics.dlqReplaySucceeded += 1;
      return { ok: true, id };
    } catch (err) {
      const classification = this.classify(err);
      entry.lastError = serializeError(err);
      // Only upgrade classification if the new outcome is strictly more severe.
      const severity = { transient: 0, permanent: 1, poison: 2 };
      if ((severity[classification] || 0) > (severity[entry.classification] || 0)) {
        entry.classification = classification;
      }
      this.metrics.dlqReplayFailed += 1;
      return { ok: false, id, error: serializeError(err), classification };
    }
  }

  list({ classification, type } = {}) {
    let items = this.store.list();
    if (classification) items = items.filter(e => e.classification === classification);
    if (type) items = items.filter(e => e.type === type);
    return items;
  }

  remove(id) {
    const ok = this.store.remove(id);
    if (ok) this.metrics.dlqRemoved += 1;
    return ok;
  }

  size() { return this.store.size(); }

  clear() {
    this.store.clear();
    this.poisonHistory.clear();
  }

  getMetrics() {
    return JSON.parse(JSON.stringify(this.metrics));
  }
}

function serializeError(err) {
  if (!err) return null;
  let message;
  if (typeof err.message === 'string') {
    message = err.message.slice(0, 500);
  } else if (err.message !== undefined && err.message !== null) {
    message = String(err.message).slice(0, 500);
  } else {
    message = String(err).slice(0, 500);
  }
  return {
    name: err.name || 'Error',
    message,
    code: err.code || null,
    status: typeof err.status === 'number' ? err.status : null,
  };
}

module.exports = {
  DeliveryFailurePolicy,
  InMemoryDLQStore,
  DeliveryError,
  classifyError,
  serializeError,
  TRANSIENT_HTTP,
  TRANSIENT_NET_CODES,
};
