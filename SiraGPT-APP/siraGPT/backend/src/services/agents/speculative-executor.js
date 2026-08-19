'use strict';

/**
 * speculative-executor — branch-prediction for agent tool-calls.
 *
 * While the main LLM is still streaming, a fast predictor anticipates
 * which tools the model is likely to invoke and pre-executes them in
 * parallel. When the model commits to a tool call:
 *   - HIT  → return the cached result (often 200-2000 ms saved)
 *   - MISS → discard the speculation; run the tool call normally
 *
 * Conceptually identical to a CPU branch predictor: speculative work
 * is correctness-neutral (we never expose speculative results to the
 * model unless they match its actual call), but a high hit rate cuts
 * end-to-end latency significantly.
 *
 * Safety invariants:
 *   1. Only speculate on tools whose manifest says they are
 *      side-effect-free (`side_effect_level` ∈ {'none','remote-read'})
 *      AND not flagged `requires_confirmation`. The default
 *      `safeToolFilter` enforces this; callers can swap it for
 *      stricter policies.
 *   2. Speculative work is always coalesced with single-flight, so
 *      duplicate speculations for the same (tool, args) pair never
 *      double-execute.
 *   3. Errors during speculation are classified via the existing
 *      delivery-failure-policy classifier and stored alongside the
 *      pool entry; on lookup-hit, callers receive either {result} or
 *      {error, classification} faithfully.
 *   4. Misses do nothing destructive — speculative pool entries are
 *      evicted by TTL and capacity, never raised to the caller.
 *
 * Architecture:
 *
 *   [LLM stream]──┐                  ┌──[Predictor]
 *                 │                  │ (n-gram / heuristic / fast LLM)
 *                 │                  │
 *                 ▼                  ▼
 *               speculate(context) ────┐
 *                                      │
 *                  candidates filtered by:
 *                    confidence ≥ threshold
 *                    safeToolFilter(manifest)
 *                    maxConcurrent cap
 *                                      │
 *                                      ▼
 *               for each candidate:
 *                 SingleFlight.do(`spec:${tool}:${argsHash}`,
 *                                 () => toolDispatcher(tool, args))
 *                 → store result/error in pool with TTL
 *                                      │
 *                                      ▼
 *               LLM emits tool_call → lookup(tool, args)
 *                 hit  → return cached
 *                 miss → caller runs tool normally
 *
 * Pluggable components:
 *   - predictor      — { predict(ctx) → [{ toolName, args, confidence }] }
 *   - toolDispatcher — (toolName, args) → Promise<result>  (the real exec)
 *   - safeToolFilter — (manifest) → boolean   (defaults to read-only check)
 *   - manifestProvider — (toolName) → manifest|null  (looked up before speculate)
 *
 * Public API:
 *   - SpeculativeExecutor class
 *   - NGramPredictor      — bundled simple predictor for testing/bootstrap
 *   - argsHash(args)      — stable hash for tool args
 *   - SpeculationError
 */

const crypto = require('node:crypto');
const { SingleFlight } = require('../../cache/single-flight');
const { classifyError } = require('../../utils/delivery-failure-policy');

class SpeculationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SpeculationError';
    this.code = code;
    Object.assign(this, details);
  }
}

/**
 * Stable, deterministic hash of any JSON-serializable value.
 *
 * Object keys are sorted recursively so {a:1,b:2} hashes the same as
 * {b:2,a:1}. Arrays preserve order. Non-serializable values
 * (functions, symbols, BigInt) are coerced to a sentinel string so the
 * hash never throws but always changes when those values do.
 */
function argsHash(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 24);
}

function stableStringify(value) {
  if (value === undefined) return 'u';
  if (value === null) return 'n';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number') return Number.isFinite(value) ? String(value) : 'inf';
  if (t === 'boolean') return value ? 't' : 'f';
  if (t === 'bigint') return `bi:${value.toString()}`;
  if (t === 'function' || t === 'symbol') return `${t}:?`;
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return `?:${String(value)}`;
}

/**
 * Default filter: a tool is safe to speculate when its manifest says
 * the side-effect level is at most 'remote-read' AND it does not
 * require confirmation. Tools without a manifest are unsafe by default
 * (closed-world).
 */
function defaultSafeToolFilter(manifest) {
  if (!manifest) return false;
  if (manifest.requires_confirmation === true) return false;
  const level = String(manifest.side_effect_level || 'destructive').toLowerCase();
  return level === 'none' || level === 'remote-read';
}

class SpeculativeExecutor {
  constructor({
    predictor,
    toolDispatcher,
    manifestProvider,
    safeToolFilter,
    confidenceThreshold = 0.6,
    maxConcurrent = 4,
    ttlMs = 30_000,
    poolCapacity = 100,
    now,
    onSpeculate,
    onHit,
    onMiss,
  } = {}) {
    if (!predictor || typeof predictor.predict !== 'function') {
      throw new SpeculationError('predictor_required', 'predictor.predict must be a function');
    }
    if (typeof toolDispatcher !== 'function') {
      throw new SpeculationError('dispatcher_required', 'toolDispatcher must be a function');
    }
    this.predictor = predictor;
    this.toolDispatcher = toolDispatcher;
    this.manifestProvider = typeof manifestProvider === 'function' ? manifestProvider : null;
    this.safeToolFilter = typeof safeToolFilter === 'function' ? safeToolFilter : defaultSafeToolFilter;
    this.confidenceThreshold = +confidenceThreshold;
    this.maxConcurrent = Math.max(1, maxConcurrent | 0);
    this.ttlMs = Math.max(1, ttlMs | 0);
    this.poolCapacity = Math.max(1, poolCapacity | 0);
    this.now = now || (() => Date.now());
    this.onSpeculate = typeof onSpeculate === 'function' ? onSpeculate : null;
    this.onHit = typeof onHit === 'function' ? onHit : null;
    this.onMiss = typeof onMiss === 'function' ? onMiss : null;

    this._sf = new SingleFlight();
    this._pool = new Map(); // key → { toolName, args, hash, result?, error?, classification, startedAt, settledAt, status }
    this._order = []; // FIFO for capacity eviction
    this._inflight = 0;
    this.metrics = {
      predictions: 0,
      filtered: 0,
      executed: 0,
      hits: 0,
      misses: 0,
      errorsClassified: { transient: 0, permanent: 0, poison: 0 },
      latencySavedMs: 0,
      poolEvictions: 0,
    };
  }

  /**
   * Ask the predictor for likely tools given `context` and kick off
   * speculations for each candidate that passes the confidence + safety
   * filters. Returns immediately; speculation runs asynchronously and
   * settles into the pool as results arrive.
   *
   * `context` shape is opaque to this module — callers and the
   * predictor must agree on its structure.
   */
  speculate(context) {
    let candidates;
    try {
      candidates = this.predictor.predict(context) || [];
    } catch {
      candidates = [];
    }
    if (!Array.isArray(candidates)) candidates = [];
    this.metrics.predictions += candidates.length;

    const accepted = [];
    for (const cand of candidates) {
      if (!cand || typeof cand.toolName !== 'string') continue;
      if (typeof cand.confidence !== 'number' || cand.confidence < this.confidenceThreshold) {
        this.metrics.filtered += 1;
        continue;
      }
      const manifest = this.manifestProvider ? this.manifestProvider(cand.toolName) : null;
      if (!this.safeToolFilter(manifest)) {
        this.metrics.filtered += 1;
        continue;
      }
      if (this._inflight >= this.maxConcurrent) break;
      accepted.push(cand);
      this._inflight += 1;
    }

    for (const cand of accepted) this._kickoff(cand);
    return accepted.length;
  }

  /**
   * Look up a previously-speculated (toolName, args) pair. On hit,
   * returns { hit: true, result, error?, classification?, latencySavedMs }
   * with mutually exclusive result/error fields. On miss, returns
   * { hit: false }.
   *
   * A hit always consumes the pool entry (one-shot).
   */
  async lookup(toolName, args) {
    const key = this._key(toolName, args);
    this._evictExpired();
    const entry = this._pool.get(key);
    if (!entry) {
      this.metrics.misses += 1;
      if (this.onMiss) try { this.onMiss({ toolName }); } catch { /* journal must not throw */ }
      return { hit: false };
    }

    // If still running, await its settlement up to ttl.
    if (entry.status === 'running') {
      try {
        await entry.promise;
      } catch {
        // settlement promise also stored under entry.promise; errors
        // are surfaced via entry.error below regardless of how we got here.
      }
    }

    this._removeFromPool(key);
    this.metrics.hits += 1;
    // Latency saved = how long the answer waited in the pool ready to be
    // consumed. If speculation hadn't settled by lookup time, savings is 0
    // (the lookup had to wait the remaining dispatcher time, same as if
    // we had run the tool synchronously).
    const latencySaved = entry.settledAt
      ? Math.max(0, this.now() - entry.settledAt)
      : 0;
    this.metrics.latencySavedMs += latencySaved;
    if (this.onHit) {
      try { this.onHit({ toolName, latencySavedMs: latencySaved, hadError: !!entry.error }); }
      catch { /* journal */ }
    }
    if (entry.error) {
      return {
        hit: true,
        error: entry.error,
        classification: entry.classification || 'permanent',
        latencySavedMs: latencySaved,
      };
    }
    return { hit: true, result: entry.result, latencySavedMs: latencySaved };
  }

  /** Number of currently pooled entries (running + settled, not expired). */
  size() {
    this._evictExpired();
    return this._pool.size;
  }

  clear() {
    const n = this._pool.size;
    this._pool.clear();
    this._order = [];
    this._inflight = 0;
    return n;
  }

  getMetrics() {
    return JSON.parse(JSON.stringify(this.metrics));
  }

  // ── internals ────────────────────────────────────────────────────

  _key(toolName, args) {
    return `${toolName}|${argsHash(args)}`;
  }

  _kickoff(cand) {
    const key = this._key(cand.toolName, cand.args);
    const existing = this._pool.get(key);
    if (existing) {
      // Already speculating or speculated — just keep our hold; the
      // single-flight in the underlying dispatcher prevents duplicate
      // work, but we also avoid re-creating pool entries.
      this._inflight -= 1;
      return;
    }
    const startedAt = this.now();
    const entry = {
      toolName: cand.toolName,
      args: cand.args,
      hash: argsHash(cand.args),
      result: undefined,
      error: undefined,
      classification: null,
      startedAt,
      settledAt: null,
      status: 'running',
      promise: null,
    };
    entry.promise = this._sf
      .do(`spec:${key}`, () => Promise.resolve(this.toolDispatcher(cand.toolName, cand.args)))
      .then(
        result => {
          entry.result = result;
          entry.settledAt = this.now();
          entry.status = 'settled';
          this.metrics.executed += 1;
        },
        err => {
          const classification = classifyError(err);
          entry.error = serializeErr(err);
          entry.classification = classification;
          entry.settledAt = this.now();
          entry.status = 'settled';
          this.metrics.executed += 1;
          if (this.metrics.errorsClassified[classification] !== undefined) {
            this.metrics.errorsClassified[classification] += 1;
          }
        },
      )
      .finally(() => {
        this._inflight = Math.max(0, this._inflight - 1);
      });
    this._addToPool(key, entry);
    if (this.onSpeculate) {
      try {
        this.onSpeculate({ toolName: cand.toolName, hash: entry.hash, confidence: cand.confidence });
      } catch { /* journal */ }
    }
  }

  _addToPool(key, entry) {
    this._pool.set(key, entry);
    this._order.push(key);
    while (this._pool.size > this.poolCapacity) {
      const evictKey = this._order.shift();
      if (evictKey && this._pool.delete(evictKey)) {
        this.metrics.poolEvictions += 1;
      }
    }
  }

  _removeFromPool(key) {
    if (this._pool.delete(key)) {
      const ix = this._order.indexOf(key);
      if (ix >= 0) this._order.splice(ix, 1);
      return true;
    }
    return false;
  }

  _evictExpired() {
    const cutoff = this.now() - this.ttlMs;
    while (this._order.length > 0) {
      const oldest = this._order[0];
      const entry = this._pool.get(oldest);
      if (!entry) {
        this._order.shift();
        continue;
      }
      if (entry.startedAt > cutoff) break; // remaining entries are all newer
      this._order.shift();
      this._pool.delete(oldest);
      this.metrics.poolEvictions += 1;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// NGramPredictor — bigram-ish frequency predictor.
//
// Maintains contextKey → Map<toolName, count>. At predict() time, looks
// up the contextKey of the supplied context, returns top-K tools sorted
// by frequency with confidence = count / total. Useful as a baseline or
// for warm-up before a fast LLM predictor is wired in.
// ─────────────────────────────────────────────────────────────────────
class NGramPredictor {
  constructor({ contextHasher, k = 5, smoothing = 0.5 } = {}) {
    this.contextHasher = typeof contextHasher === 'function'
      ? contextHasher
      : (ctx) => stableStringify(ctx).slice(0, 64);
    this.k = Math.max(1, k | 0);
    this.smoothing = +smoothing;
    this.table = new Map();   // contextKey → Map<toolName, count>
    this.totals = new Map();  // contextKey → total count
    this.observations = 0;
  }

  /** Train the predictor on an observed (context, toolCalled) pair. */
  observe(context, toolName, args = null) {
    if (typeof toolName !== 'string' || !toolName) return;
    const key = this.contextHasher(context);
    let row = this.table.get(key);
    if (!row) {
      row = new Map();
      this.table.set(key, row);
    }
    row.set(toolName, (row.get(toolName) || 0) + 1);
    this.totals.set(key, (this.totals.get(key) || 0) + 1);
    this.observations += 1;
    // We discard args at observation time — predictor returns historical
    // tool names only, callers attach args via context-derived logic.
    void args;
  }

  predict(context) {
    const key = this.contextHasher(context);
    const row = this.table.get(key);
    if (!row) return [];
    const total = this.totals.get(key) || 0;
    if (total === 0) return [];
    const candidates = [];
    for (const [toolName, count] of row.entries()) {
      const confidence = (count + this.smoothing) / (total + this.smoothing * row.size);
      // Allow caller to attach args via predicted-args resolver if needed.
      // Default: pass-through context as args so the dispatcher can do its
      // own arg shaping. Tests inject a richer predictor for clarity.
      candidates.push({ toolName, args: null, confidence });
    }
    candidates.sort((a, b) => b.confidence - a.confidence);
    return candidates.slice(0, this.k);
  }

  getStats() {
    return {
      observations: this.observations,
      contexts: this.table.size,
    };
  }
}

function serializeErr(err) {
  if (!err) return null;
  return {
    name: err.name || 'Error',
    message: typeof err.message === 'string' ? err.message.slice(0, 500) : String(err).slice(0, 500),
    code: err.code || null,
    status: typeof err.status === 'number' ? err.status : null,
  };
}

module.exports = {
  SpeculativeExecutor,
  NGramPredictor,
  SpeculationError,
  argsHash,
  defaultSafeToolFilter,
  stableStringify,
};
