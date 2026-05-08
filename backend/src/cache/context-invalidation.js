'use strict';

/**
 * context-invalidation — pub/sub layer for cache and context invalidation.
 *
 * Decouples cache-bearing modules (semantic.js, llm-cache.js, TwoTier.js,
 * memory-store, response cache) from the events that should bust their
 * entries. Subscribers register a handler against one or more tag patterns;
 * when a publisher emits an invalidation for a tag, every matching handler
 * is called with a structured event.
 *
 * Why this exists:
 *   - Existing caches store entries by scope/key but cannot be told "the
 *     underlying context for scope=X just changed; drop everything".
 *   - Without a central invalidator, we either over-invalidate (clear all)
 *     or under-invalidate (serve stale). This module fixes the middle path.
 *
 * Design:
 *   - In-process pub/sub. No network. No persistence (in-flight events
 *     only). Fits a single-replica deployment cleanly; for multi-replica
 *     fan-out, the publisher is responsible for sending the event to all
 *     replicas (e.g. via Redis Pub/Sub adapter — out of scope here).
 *   - Subscribers identified by an opaque numeric handle so unsubscribe is
 *     exact and survives handler-function reuse across modules.
 *   - Events carry: tag, reason, source, ts, idempotencyKey (optional).
 *     idempotencyKey lets a publisher safely re-emit the same event without
 *     double-busting (a sliding window remembers the last N keys).
 *   - Tag matching is exact + wildcard ('*'). Hierarchical dotted tags
 *     supported via prefix wildcard ('user.42.*').
 *   - Recent invalidation log (ring buffer) for observability.
 *   - getStats() — counts of subscribers, emissions, suppressed duplicates,
 *     handler errors.
 *
 * Public API:
 *   - ContextInvalidator class
 *   - getInvalidator() — process-wide singleton
 *   - resetInvalidatorForTests() — drops the singleton (test harness only)
 *   - tagMatches(pattern, tag) — pure helper exported for completeness
 *   - InvalidationError — base error type
 *
 * Non-goals:
 *   - Persistence across restarts. The in-memory caches that subscribe are
 *     themselves volatile; an event arriving after restart against an empty
 *     cache is a no-op.
 *   - Ordering guarantees beyond intra-tag FIFO across subscribers in the
 *     order they were registered.
 */

class InvalidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'InvalidationError';
    Object.assign(this, details);
  }
}

const WILDCARD = '*';

/**
 * Returns true when `pattern` should match `tag`. Supported syntaxes:
 *   - exact:        "users.42.context" matches "users.42.context"
 *   - star:         "*" matches every tag
 *   - prefix-glob:  "users.42.*" matches "users.42.context",
 *                   "users.42.cache", "users.42.x.y", etc.
 *
 * No regex; intentionally narrow to keep matching predictable and fast.
 */
function tagMatches(pattern, tag) {
  if (typeof pattern !== 'string' || typeof tag !== 'string') return false;
  if (pattern === tag) return true;
  // Either side may be the wildcard:
  //  - pattern '*' = subscriber wants every event
  //  - tag '*'     = publisher broadcasts to every subscriber (used by invalidateAll)
  if (pattern === WILDCARD || tag === WILDCARD) return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1); // keep trailing dot, strip the *
    return tag.startsWith(prefix);
  }
  return false;
}

class ContextInvalidator {
  constructor({ logCapacity = 200, dedupeWindow = 1000 } = {}) {
    this.subs = new Map();
    this.idCounter = 0;
    this.log = [];
    this.logCapacity = Math.max(1, logCapacity | 0);
    this.dedupeWindow = Math.max(1, dedupeWindow | 0);
    this.recentKeys = new Map(); // insertion-ordered Map for FIFO trim
    this.metrics = {
      subscribers: 0,
      emitted: 0,
      delivered: 0,
      suppressedDuplicates: 0,
      handlerErrors: 0,
    };
  }

  /**
   * Register a handler.
   *
   * @param {object} args
   * @param {string[]} args.patterns — one or more tag patterns to match
   * @param {(event: object) => any} args.handler — invoked synchronously;
   *   may return a promise (errors are caught and counted, never thrown).
   * @param {string} [args.name] — short label for log/error attribution
   * @returns {{ id: number, unsubscribe: () => boolean }}
   */
  subscribe({ patterns, handler, name = 'anonymous' } = {}) {
    if (!Array.isArray(patterns) || patterns.length === 0) {
      throw new InvalidationError('subscribe: patterns must be a non-empty array');
    }
    if (typeof handler !== 'function') {
      throw new InvalidationError('subscribe: handler must be a function');
    }
    for (const p of patterns) {
      if (typeof p !== 'string' || p.length === 0) {
        throw new InvalidationError('subscribe: each pattern must be a non-empty string');
      }
    }
    const id = ++this.idCounter;
    this.subs.set(id, { id, patterns: patterns.slice(), name: String(name), handler });
    this.metrics.subscribers = this.subs.size;
    return {
      id,
      unsubscribe: () => this.unsubscribe(id),
    };
  }

  unsubscribe(id) {
    const removed = this.subs.delete(id);
    this.metrics.subscribers = this.subs.size;
    return removed;
  }

  unsubscribeAll() {
    const count = this.subs.size;
    this.subs.clear();
    this.metrics.subscribers = 0;
    return count;
  }

  /**
   * Emit an invalidation event for `tag`. Returns the count of handlers
   * actually called. If `idempotencyKey` is provided and the same key was
   * seen within `dedupeWindow` events, the call is a no-op (returns 0)
   * and `suppressedDuplicates` is incremented.
   */
  invalidate(tag, opts = {}) {
    if (typeof tag !== 'string' || tag.length === 0) {
      throw new InvalidationError('invalidate: tag must be a non-empty string');
    }
    const { reason = 'unspecified', source = 'unknown', idempotencyKey, metadata } = opts;

    if (idempotencyKey) {
      if (this.recentKeys.has(idempotencyKey)) {
        this.metrics.suppressedDuplicates += 1;
        return 0;
      }
      this.recentKeys.set(idempotencyKey, Date.now());
      while (this.recentKeys.size > this.dedupeWindow) {
        const firstKey = this.recentKeys.keys().next().value;
        this.recentKeys.delete(firstKey);
      }
    }

    const event = {
      tag,
      reason: String(reason),
      source: String(source),
      ts: Date.now(),
      idempotencyKey: idempotencyKey || null,
      metadata: metadata || null,
    };
    this.metrics.emitted += 1;
    this._appendLog(event);

    let delivered = 0;
    for (const sub of this.subs.values()) {
      const matched = sub.patterns.some(p => tagMatches(p, tag));
      if (!matched) continue;
      try {
        const r = sub.handler(event);
        if (r && typeof r.catch === 'function') {
          r.catch(err => {
            this.metrics.handlerErrors += 1;
            this._noteHandlerError(sub, err);
          });
        }
      } catch (err) {
        this.metrics.handlerErrors += 1;
        this._noteHandlerError(sub, err);
      }
      delivered += 1;
    }
    this.metrics.delivered += delivered;
    return delivered;
  }

  invalidateMany(tags, opts = {}) {
    if (!Array.isArray(tags)) {
      throw new InvalidationError('invalidateMany: tags must be an array');
    }
    let total = 0;
    for (const tag of tags) total += this.invalidate(tag, opts);
    return total;
  }

  invalidateAll(reason = 'global-flush', source = 'unknown') {
    return this.invalidate(WILDCARD, { reason, source });
  }

  getLog() { return this.log.slice(); }

  getStats() {
    return { ...this.metrics, logSize: this.log.length };
  }

  _appendLog(event) {
    this.log.push(event);
    if (this.log.length > this.logCapacity) this.log.shift();
  }

  _noteHandlerError(sub, err) {
    this._appendLog({
      tag: '_handler_error',
      reason: err && err.message ? String(err.message).slice(0, 240) : 'unknown',
      source: sub.name,
      ts: Date.now(),
      idempotencyKey: null,
      metadata: { subscriberId: sub.id },
    });
  }
}

let _singleton = null;

function getInvalidator(opts) {
  if (!_singleton) _singleton = new ContextInvalidator(opts);
  return _singleton;
}

function resetInvalidatorForTests() {
  _singleton = null;
}

module.exports = {
  ContextInvalidator,
  InvalidationError,
  getInvalidator,
  resetInvalidatorForTests,
  tagMatches,
};
