/**
 * probe-scheduler.js
 *
 * Generic periodic scheduler for any Probe (db, redis, memory,
 * synthetic-ping, custom). Unlike SyntheticPingSampler — which is
 * coupled to a single ping probe — this scheduler manages many
 * probes with per-probe intervals, optional jitter, and adaptive
 * back-off when a probe stays unhealthy.
 *
 * Why this exists:
 *   Probe.history grows only when `Probe.run()` is invoked. In a
 *   long-lived backend nobody hits /internal/health/ready unless
 *   something is on fire, so the rolling history that powers
 *   /internal/health/history is mostly empty when you need it most.
 *   A periodic scheduler keeps history continuously populated so the
 *   p50/p95 percentiles and `slo-aggregator` outputs are meaningful
 *   the moment an operator opens the dashboard.
 *
 * Why per-probe intervals:
 *   A cheap in-process probe (memory, disk) can poll every 5s, while
 *   a network round-trip probe (provider-openai) should poll less
 *   often to avoid burning rate limit.
 *
 * Why adaptive back-off:
 *   When a probe fails repeatedly, the scheduler doubles the
 *   interval (capped at maxIntervalMs) so a sustained outage doesn't
 *   amplify load on whatever is already broken. The next successful
 *   sample resets the interval to the configured base.
 */

'use strict';

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_JITTER_RATIO = 0.1;
const DEFAULT_BACKOFF_FACTOR = 2;
const DEFAULT_BACKOFF_CAP_RATIO = 10; // max = baseInterval * cap
const MAX_TIMER_DELAY_MS = 2_147_483_647;

class ProbeScheduler {
  constructor({
    now = Date.now,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    onError = null,
    onSample = null,
    defaultIntervalMs = DEFAULT_INTERVAL_MS,
    jitterRatio = DEFAULT_JITTER_RATIO,
    backoffFactor = DEFAULT_BACKOFF_FACTOR,
    backoffCapRatio = DEFAULT_BACKOFF_CAP_RATIO,
    random = Math.random,
  } = {}) {
    if (!Number.isFinite(defaultIntervalMs) || defaultIntervalMs < 1000) {
      throw new TypeError('ProbeScheduler: defaultIntervalMs must be >= 1000');
    }
    if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
      throw new TypeError('ProbeScheduler: jitterRatio must be in [0,1]');
    }
    if (!Number.isFinite(backoffFactor) || backoffFactor < 1) {
      throw new TypeError('ProbeScheduler: backoffFactor must be >= 1');
    }
    if (!Number.isFinite(backoffCapRatio) || backoffCapRatio < 1) {
      throw new TypeError('ProbeScheduler: backoffCapRatio must be >= 1');
    }

    this._now = now;
    this._setInterval = setIntervalImpl;
    this._clearInterval = clearIntervalImpl;
    this._setTimeout = setTimeoutImpl;
    this._clearTimeout = clearTimeoutImpl;
    this._random = random;
    this._onError = typeof onError === 'function' ? onError : null;
    this._onSample = typeof onSample === 'function' ? onSample : null;

    this._defaultIntervalMs = Math.min(defaultIntervalMs, MAX_TIMER_DELAY_MS);
    this._jitterRatio = jitterRatio;
    this._backoffFactor = backoffFactor;
    this._backoffCapRatio = backoffCapRatio;

    this._entries = new Map(); // name → entry
    this._running = false;
  }

  get running() { return this._running; }
  get size() { return this._entries.size; }

  /**
   * Register a probe to be sampled. Returns the entry object so
   * callers can inspect or remove later by name.
   *
   * @param {Probe} probe
   * @param {object} [opts]
   * @param {number} [opts.intervalMs]    Sampling interval (default: scheduler default).
   * @param {boolean} [opts.runImmediately=false] Fire one sample now (after register).
   * @param {boolean} [opts.bypassCache=true]     Force fresh probe runs (default true — we want real measurements).
   */
  add(probe, opts = {}) {
    if (!probe || typeof probe.run !== 'function' || typeof probe.name !== 'string') {
      throw new TypeError('ProbeScheduler.add: probe with .name and .run() is required');
    }
    if (this._entries.has(probe.name)) {
      throw new Error(`ProbeScheduler: probe "${probe.name}" already registered`);
    }
    const intervalMs = Number.isFinite(opts.intervalMs) && opts.intervalMs >= 1000
      ? Math.min(opts.intervalMs, MAX_TIMER_DELAY_MS)
      : this._defaultIntervalMs;
    const bypassCache = opts.bypassCache !== false;

    const entry = {
      probe,
      baseIntervalMs: intervalMs,
      currentIntervalMs: intervalMs,
      bypassCache,
      timer: null,
      inflight: null,
      sampleCount: 0,
      consecutiveFailures: 0,
      lastResult: null,
      lastSampledAt: null,
      lastError: null,
    };
    this._entries.set(probe.name, entry);

    if (this._running) {
      this._schedule(entry, { runImmediately: opts.runImmediately === true });
    } else if (opts.runImmediately === true) {
      // Buffer a pending immediate sample; honoured when start() runs.
      entry._pendingImmediate = true;
    }

    return entry;
  }

  /** Bulk-register probes from a HealthRegistry. */
  addAll(registry, opts = {}) {
    if (!registry || typeof registry.list !== 'function') {
      throw new TypeError('ProbeScheduler.addAll: HealthRegistry-like object required');
    }
    const added = [];
    for (const probe of registry.list()) {
      if (!this._entries.has(probe.name)) {
        added.push(this.add(probe, opts));
      }
    }
    return added;
  }

  remove(name) {
    const entry = this._entries.get(name);
    if (!entry) return false;
    if (entry.timer) {
      this._clearTimeout(entry.timer);
      entry.timer = null;
    }
    this._entries.delete(name);
    return true;
  }

  get(name) { return this._entries.get(name) || null; }
  list() { return Array.from(this._entries.values()); }

  /** Begin sampling all registered probes. Idempotent. */
  start() {
    if (this._running) return this;
    this._running = true;
    for (const entry of this._entries.values()) {
      const runImmediately = entry._pendingImmediate === true;
      delete entry._pendingImmediate;
      this._schedule(entry, { runImmediately });
    }
    return this;
  }

  /** Stop sampling. Inflight samples are allowed to settle. */
  stop() {
    if (!this._running) return this;
    this._running = false;
    for (const entry of this._entries.values()) {
      if (entry.timer) {
        this._clearTimeout(entry.timer);
        entry.timer = null;
      }
    }
    return this;
  }

  /** Manually trigger one sample of a registered probe by name. */
  async sampleOnce(name) {
    const entry = this._entries.get(name);
    if (!entry) throw new Error(`ProbeScheduler: no probe "${name}"`);
    return this._runSample(entry);
  }

  /** Public snapshot for introspection / metrics. */
  snapshot() {
    return {
      running: this._running,
      size: this._entries.size,
      defaultIntervalMs: this._defaultIntervalMs,
      jitterRatio: this._jitterRatio,
      probes: this.list().map((entry) => ({
        name: entry.probe.name,
        category: entry.probe.category,
        baseIntervalMs: entry.baseIntervalMs,
        currentIntervalMs: entry.currentIntervalMs,
        sampleCount: entry.sampleCount,
        consecutiveFailures: entry.consecutiveFailures,
        lastSampledAt: entry.lastSampledAt,
        lastStatus: entry.lastResult ? entry.lastResult.status : null,
        lastError: entry.lastError ? (entry.lastError.message || String(entry.lastError)) : null,
      })),
    };
  }

  // ── internals ───────────────────────────────────────────────────

  _schedule(entry, { runImmediately = false } = {}) {
    if (!this._running) return;
    if (entry.timer) {
      this._clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (runImmediately) {
      // Run on a microtask so we don't recurse from add().
      Promise.resolve()
        .then(() => {
          if (!this._running) return null;
          return this._runSample(entry);
        })
        .catch(() => {})
        .finally(() => this._schedule(entry));
      return;
    }
    const delay = this._nextDelay(entry.currentIntervalMs);
    entry.timer = this._setTimeout(() => {
      entry.timer = null;
      if (!this._running) return;
      this._runSample(entry)
        .catch(() => {})
        .finally(() => this._schedule(entry));
    }, delay);
    if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
  }

  _nextDelay(intervalMs) {
    if (this._jitterRatio === 0) return intervalMs;
    const jitter = intervalMs * this._jitterRatio;
    // Symmetric jitter: [interval - jitter, interval + jitter].
    const offset = (this._random() * 2 - 1) * jitter;
    const delay = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(100, Math.round(intervalMs + offset)),
    );
    return delay;
  }

  async _runSample(entry) {
    if (entry.inflight) return entry.inflight;
    entry.inflight = entry.probe.run({ bypassCache: entry.bypassCache })
      .then((result) => {
        entry.sampleCount += 1;
        entry.lastResult = result;
        entry.lastSampledAt = new Date(this._now()).toISOString();
        entry.lastError = null;
        const failed = result && (result.status === 'fail' || result.status === 'timeout');
        if (failed) {
          entry.consecutiveFailures += 1;
          this._applyBackoff(entry);
        } else if (entry.consecutiveFailures > 0) {
          entry.consecutiveFailures = 0;
          entry.currentIntervalMs = entry.baseIntervalMs;
        }
        if (this._onSample) {
          try { this._onSample({ name: entry.probe.name, result }); }
          catch (_) { /* swallow */ }
        }
        return result;
      })
      .catch((err) => {
        entry.lastError = err;
        entry.consecutiveFailures += 1;
        this._applyBackoff(entry);
        if (this._onError) {
          try { this._onError({ name: entry.probe.name, error: err }); }
          catch (_) { /* swallow */ }
        }
        return null;
      })
      .finally(() => { entry.inflight = null; });
    return entry.inflight;
  }

  _applyBackoff(entry) {
    const cap = Math.min(MAX_TIMER_DELAY_MS, entry.baseIntervalMs * this._backoffCapRatio);
    const next = Math.min(
      MAX_TIMER_DELAY_MS,
      cap,
      Math.round(entry.currentIntervalMs * this._backoffFactor),
    );
    entry.currentIntervalMs = next;
  }
}

module.exports = {
  ProbeScheduler,
  DEFAULT_INTERVAL_MS,
  MAX_TIMER_DELAY_MS,
};
