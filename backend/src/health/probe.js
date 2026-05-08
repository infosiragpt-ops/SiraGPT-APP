/**
 * probe.js
 *
 * Health probe interface and registry for service readiness/liveness
 * endpoints. Each Probe wraps a check function with timeout, category
 * (critical | degraded), and TTL caching. The HealthRegistry composes
 * many probes into an aggregated JSON result and Express handlers.
 *
 * Aggregation semantics:
 *   - probe.status: 'pass' | 'warn' | 'fail' | 'timeout'
 *   - critical fail/timeout → overall 'down' (HTTP 503)
 *   - degraded fail/timeout → overall 'degraded' (HTTP 200)
 *   - otherwise              → overall 'ok'        (HTTP 200)
 */

'use strict';

const STATUS = Object.freeze({
  PASS:    'pass',
  WARN:    'warn',
  FAIL:    'fail',
  TIMEOUT: 'timeout',
});

const CATEGORY = Object.freeze({
  CRITICAL: 'critical',
  DEGRADED: 'degraded',
});

const OVERALL = Object.freeze({
  OK:       'ok',
  DEGRADED: 'degraded',
  DOWN:     'down',
});

class ProbeError extends Error {
  constructor(message, { status = STATUS.FAIL, cause } = {}) {
    super(message);
    this.name = 'ProbeError';
    this.status = status;
    if (cause) this.cause = cause;
  }
}

/**
 * A single dependency health check.
 *
 * @param {object} opts
 * @param {string} opts.name              Unique probe name.
 * @param {function} opts.check           async () => result | throws | returns {status,details}
 * @param {string} [opts.category]        'critical' (default) or 'degraded'.
 * @param {number} [opts.timeoutMs=2000]  Hard timeout.
 * @param {number} [opts.ttlMs=5000]      Cache TTL for results (0 disables cache).
 * @param {function} [opts.now]           Injectable clock (testing).
 */
class Probe {
  constructor(opts = {}) {
    const {
      name,
      check,
      category = CATEGORY.CRITICAL,
      timeoutMs = 2000,
      ttlMs = 5000,
      now = Date.now,
    } = opts;

    if (!name || typeof name !== 'string') {
      throw new TypeError('Probe: "name" is required');
    }
    if (typeof check !== 'function') {
      throw new TypeError(`Probe[${name}]: "check" must be a function`);
    }
    if (category !== CATEGORY.CRITICAL && category !== CATEGORY.DEGRADED) {
      throw new TypeError(`Probe[${name}]: invalid category "${category}"`);
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError(`Probe[${name}]: timeoutMs must be > 0`);
    }
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new TypeError(`Probe[${name}]: ttlMs must be >= 0`);
    }

    const historySize = Number.isFinite(opts.historySize) ? opts.historySize : 50;
    if (historySize < 0) {
      throw new TypeError(`Probe[${name}]: historySize must be >= 0`);
    }

    this.name = name;
    this.category = category;
    this.timeoutMs = timeoutMs;
    this.ttlMs = ttlMs;
    this.historySize = historySize;
    this._check = check;
    this._now = now;
    this._cache = null; // { expiresAt, result }
    this._inflight = null;
    this._history = []; // ring buffer of { timestamp, status, elapsedMs, cached, error? }
  }

  /** Runs the probe (respecting TTL cache and de-duplicating concurrent calls). */
  async run({ bypassCache = false } = {}) {
    const t = this._now();
    if (!bypassCache && this._cache && t < this._cache.expiresAt) {
      return { ...this._cache.result, cached: true };
    }
    if (this._inflight) return this._inflight;

    this._inflight = this._execute(t)
      .then((result) => {
        if (this.ttlMs > 0) {
          this._cache = {
            expiresAt: this._now() + this.ttlMs,
            result,
          };
        }
        this._record(result);
        return result;
      })
      .finally(() => { this._inflight = null; });

    return this._inflight;
  }

  /** Drops cached result and forces a fresh run on next invocation. */
  invalidate() { this._cache = null; }

  /**
   * Returns the most recent run records (newest last).
   * @param {number} [limit] Optional cap on number of records.
   */
  getHistory(limit) {
    if (!Number.isFinite(limit) || limit <= 0 || limit >= this._history.length) {
      return this._history.slice();
    }
    return this._history.slice(this._history.length - limit);
  }

  /** Drops all stored history. */
  clearHistory() { this._history = []; }

  _record(result) {
    if (this.historySize <= 0) return;
    const entry = {
      timestamp: new Date(this._now()).toISOString(),
      status: result.status,
      elapsedMs: result.elapsedMs,
      cached: result.cached === true,
    };
    if (result.error) entry.error = result.error;
    this._history.push(entry);
    if (this._history.length > this.historySize) {
      this._history.splice(0, this._history.length - this.historySize);
    }
  }

  async _execute(startedAt) {
    let timer;
    let timedOut = false;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve({ __timeout: true });
      }, this.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });

    let raw;
    try {
      raw = await Promise.race([
        Promise.resolve().then(() => this._check({ name: this.name, timeoutMs: this.timeoutMs })),
        timeoutPromise,
      ]);
    } catch (err) {
      clearTimeout(timer);
      return this._format({
        startedAt,
        status: err && err.status === STATUS.WARN ? STATUS.WARN : STATUS.FAIL,
        error: err,
      });
    }
    clearTimeout(timer);

    if (timedOut) {
      return this._format({
        startedAt,
        status: STATUS.TIMEOUT,
        error: new Error(`probe "${this.name}" timed out after ${this.timeoutMs}ms`),
      });
    }

    // Allow check() to return a structured result.
    if (raw && typeof raw === 'object' && raw.__timeout !== true && 'status' in raw) {
      const status = normalizeStatus(raw.status);
      return this._format({
        startedAt,
        status,
        details: raw.details ?? null,
        message: raw.message ?? null,
      });
    }

    return this._format({
      startedAt,
      status: STATUS.PASS,
      details: raw === undefined ? null : raw,
    });
  }

  _format({ startedAt, status, error = null, details = null, message = null }) {
    const elapsedMs = Math.max(0, this._now() - startedAt);
    const out = {
      name: this.name,
      category: this.category,
      status,
      elapsedMs,
      timeoutMs: this.timeoutMs,
      cached: false,
    };
    if (details !== null && details !== undefined) out.details = details;
    if (message) out.message = message;
    if (error) {
      out.error = error.message || String(error);
      if (error.code) out.code = error.code;
    }
    return out;
  }
}

/**
 * Computes a percentile (e.g. 0.5, 0.95) over a numeric array using
 * linear interpolation between order statistics. Returns null for empty input.
 */
function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new TypeError(`percentile: p must be in [0,1], got ${p}`);
  }
  const sorted = values
    .filter((v) => Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Summarizes a list of history entries into duration percentiles
 * and per-status counts. Cached entries are excluded from latency
 * statistics but still counted under `byStatus`.
 */
function summarizeHistory(entries) {
  const total = entries.length;
  const byStatus = {};
  const latencies = [];
  let lastTimestamp = null;
  for (const e of entries) {
    byStatus[e.status] = (byStatus[e.status] || 0) + 1;
    if (!e.cached && Number.isFinite(e.elapsedMs)) latencies.push(e.elapsedMs);
    if (e.timestamp) lastTimestamp = e.timestamp;
  }
  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);
  return {
    total,
    sampled: latencies.length,
    byStatus,
    p50: p50 == null ? null : Math.round(p50),
    p95: p95 == null ? null : Math.round(p95),
    minMs: latencies.length ? Math.min(...latencies) : null,
    maxMs: latencies.length ? Math.max(...latencies) : null,
    lastTimestamp,
  };
}

function normalizeStatus(s) {
  if (s === STATUS.PASS || s === STATUS.WARN || s === STATUS.FAIL || s === STATUS.TIMEOUT) {
    return s;
  }
  if (s === true || s === 'ok' || s === 'up') return STATUS.PASS;
  if (s === false || s === 'down') return STATUS.FAIL;
  return STATUS.WARN;
}

/** Combines probe results into an overall status. */
function aggregate(results) {
  let overall = OVERALL.OK;
  for (const r of results) {
    const broken = r.status === STATUS.FAIL || r.status === STATUS.TIMEOUT;
    const warned = r.status === STATUS.WARN;
    if (broken && r.category === CATEGORY.CRITICAL) {
      overall = OVERALL.DOWN;
      break;
    }
    if ((broken && r.category === CATEGORY.DEGRADED) || warned) {
      if (overall === OVERALL.OK) overall = OVERALL.DEGRADED;
    }
  }
  return overall;
}

/**
 * Registers a set of probes and exposes Express handlers for
 * `/internal/health/live` and `/internal/health/ready`.
 */
class HealthRegistry {
  constructor({ now = Date.now } = {}) {
    this._probes = new Map();
    this._now = now;
    this._startedAt = now();
  }

  /** Add a probe (Probe instance or plain options). */
  add(probeOrOpts) {
    const probe = probeOrOpts instanceof Probe ? probeOrOpts : new Probe(probeOrOpts);
    if (this._probes.has(probe.name)) {
      throw new Error(`HealthRegistry: probe "${probe.name}" already registered`);
    }
    this._probes.set(probe.name, probe);
    return probe;
  }

  remove(name) { return this._probes.delete(name); }
  get(name)    { return this._probes.get(name); }
  list()       { return Array.from(this._probes.values()); }
  invalidate() { for (const p of this._probes.values()) p.invalidate(); }

  /**
   * Snapshot of recent run history per probe with duration percentiles.
   *
   * @param {object} [opts]
   * @param {number} [opts.limit]   Max records returned per probe.
   * @param {string} [opts.name]    Restrict to a single probe by name.
   */
  getHistory({ limit, name } = {}) {
    const probes = name
      ? (this._probes.has(name) ? [this._probes.get(name)] : [])
      : this.list();
    const out = probes.map((p) => {
      const records = p.getHistory(limit);
      return {
        name: p.name,
        category: p.category,
        timeoutMs: p.timeoutMs,
        historySize: p.historySize,
        stats: summarizeHistory(records),
        records,
      };
    });
    return {
      timestamp: new Date(this._now()).toISOString(),
      uptimeMs: Math.max(0, this._now() - this._startedAt),
      probes: out,
    };
  }

  /** Run all probes (or a filtered subset by category). */
  async runAll({ category = null, bypassCache = false } = {}) {
    const probes = this.list().filter((p) => !category || p.category === category);
    const results = await Promise.all(probes.map((p) => p.run({ bypassCache })));
    const overall = aggregate(results);
    const httpStatus = overall === OVERALL.DOWN ? 503 : 200;
    return {
      status: overall,
      httpStatus,
      uptimeMs: Math.max(0, this._now() - this._startedAt),
      timestamp: new Date(this._now()).toISOString(),
      probes: results,
    };
  }

  /** GET /internal/health/live — process liveness only. */
  liveHandler() {
    return async (_req, res) => {
      const body = {
        status: OVERALL.OK,
        uptimeMs: Math.max(0, this._now() - this._startedAt),
        timestamp: new Date(this._now()).toISOString(),
        pid: process.pid,
      };
      res.status(200).json(body);
    };
  }

  /** GET /internal/health/ready — runs all probes. */
  readyHandler({ bypassCache = false } = {}) {
    return async (_req, res) => {
      try {
        const result = await this.runAll({ bypassCache });
        const { httpStatus, ...body } = result;
        res.status(httpStatus).json(body);
      } catch (err) {
        res.status(503).json({
          status: OVERALL.DOWN,
          error: err.message || String(err),
          timestamp: new Date(this._now()).toISOString(),
        });
      }
    };
  }

  /**
   * GET /internal/health/history — returns the last N results per probe
   * with duration percentiles. Accepts query params:
   *   - n=<number>   max records per probe (default 20)
   *   - name=<probe> filter to a specific probe
   */
  historyHandler({ defaultLimit = 20, maxLimit = 500 } = {}) {
    return async (req, res) => {
      try {
        const q = (req && req.query) || {};
        let limit = defaultLimit;
        if (q.n !== undefined) {
          const parsed = Number.parseInt(q.n, 10);
          if (Number.isFinite(parsed) && parsed > 0) {
            limit = Math.min(parsed, maxLimit);
          }
        }
        const name = typeof q.name === 'string' && q.name.length > 0 ? q.name : undefined;
        if (name && !this._probes.has(name)) {
          res.status(404).json({
            error: `unknown probe "${name}"`,
            timestamp: new Date(this._now()).toISOString(),
          });
          return;
        }
        const body = this.getHistory({ limit, name });
        res.status(200).json(body);
      } catch (err) {
        res.status(500).json({
          error: err.message || String(err),
          timestamp: new Date(this._now()).toISOString(),
        });
      }
    };
  }

  /** Mount handlers on an Express app. */
  mount(app, { basePath = '/internal/health' } = {}) {
    app.get(`${basePath}/live`, this.liveHandler());
    app.get(`${basePath}/ready`, this.readyHandler());
    app.get(`${basePath}/history`, this.historyHandler());
    return this;
  }
}

module.exports = {
  Probe,
  ProbeError,
  HealthRegistry,
  aggregate,
  percentile,
  summarizeHistory,
  STATUS,
  CATEGORY,
  OVERALL,
};
