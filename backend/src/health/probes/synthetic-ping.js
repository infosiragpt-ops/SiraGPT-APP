/**
 * Synthetic ping probe — executes a minimal chat completion request
 * against the primary provider and records end-to-end latency.
 *
 * Unlike `provider-openai`, which only verifies host reachability via
 * HEAD, this probe actually exercises the model path (POST to
 * /chat/completions with a 1-token payload) so we can observe the
 * latency a user-facing request would see.
 *
 * Designed to be sampled at low frequency (default 1/min) by the
 * SyntheticPingSampler. The probe itself is also a regular Probe and
 * can be registered in a HealthRegistry.
 */

'use strict';

const { Probe, CATEGORY } = require('../probe');

const DEFAULT_BODY = Object.freeze({
  // `model` is filled in at request time so callers may override.
  messages: [{ role: 'user', content: 'ping' }],
  max_tokens: 1,
  temperature: 0,
  stream: false,
});

/**
 * @param {object} opts
 * @param {string} [opts.name='synthetic-ping']
 * @param {string} [opts.baseUrl]      Provider base URL (defaults to OPENAI_BASE_URL or api.openai.com/v1).
 * @param {string} [opts.model]        Model id (defaults to SIRAGPT_PING_MODEL or 'gpt-4o-mini').
 * @param {string} [opts.apiKey]       API key (defaults to OPENAI_API_KEY). When missing the
 *                                     probe returns `warn` instead of failing the registry.
 * @param {string} [opts.path='/chat/completions']
 * @param {number} [opts.timeoutMs=8000]
 * @param {number} [opts.ttlMs=55000]  Cache TTL (slightly under sampling interval so a manual
 *                                     /health/ready hit does not spam the provider).
 * @param {string} [opts.category]     'critical' | 'degraded' (default degraded).
 * @param {function} [opts.fetchImpl]  Injected fetch (defaults to globalThis.fetch).
 * @param {object} [opts.body]         Override request body.
 */
function createSyntheticPingProbe({
  name = 'synthetic-ping',
  baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  model = process.env.SIRAGPT_PING_MODEL || 'gpt-4o-mini',
  apiKey = process.env.OPENAI_API_KEY,
  path = '/chat/completions',
  timeoutMs = 8000,
  ttlMs = 55_000,
  category = CATEGORY.DEGRADED,
  fetchImpl = (...args) => globalThis.fetch(...args),
  body,
  historySize = 60,
} = {}) {
  const url = joinUrl(baseUrl, path);
  const reqBody = Object.freeze({ ...DEFAULT_BODY, ...(body || {}), model });

  return new Probe({
    name,
    category,
    timeoutMs,
    ttlMs,
    historySize,
    check: async ({ timeoutMs: tm }) => {
      if (!apiKey) {
        return {
          status: 'warn',
          message: 'OPENAI_API_KEY missing — synthetic ping skipped',
          details: { url, model, skipped: true },
        };
      }

      const ac = new AbortController();
      const inner = setTimeout(() => ac.abort(), Math.max(50, tm - 50));
      if (typeof inner.unref === 'function') inner.unref();

      const t0 = Date.now();
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          signal: ac.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(reqBody),
        });
        const driverElapsedMs = Date.now() - t0;
        const code = res.status | 0;

        if (code >= 200 && code < 300) {
          let tokens = null;
          try {
            const json = await res.json();
            const usage = json && json.usage;
            if (usage && Number.isFinite(usage.total_tokens)) {
              tokens = usage.total_tokens;
            }
          } catch (_) { /* body parse is best-effort */ }
          return {
            status: 'pass',
            details: { url, model, httpStatus: code, driverElapsedMs, tokens },
          };
        }

        if (code === 429 || (code >= 500 && code < 600)) {
          return {
            status: 'fail',
            details: { url, model, httpStatus: code, driverElapsedMs },
          };
        }

        // 4xx other than 429 (e.g. 401/400) — provider reachable but request invalid.
        return {
          status: 'warn',
          details: { url, model, httpStatus: code, driverElapsedMs },
        };
      } finally {
        clearTimeout(inner);
      }
    },
  });
}

/**
 * Periodic sampler that drives a synthetic ping probe at a fixed cadence
 * (default 60s). Latency is recorded in the probe's history ring buffer
 * and also surfaced via `getLatencyStats()` for /metrics-style consumers.
 */
class SyntheticPingSampler {
  constructor({
    probe,
    intervalMs = 60_000,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    onError = null,
  } = {}) {
    if (!probe || typeof probe.run !== 'function') {
      throw new TypeError('SyntheticPingSampler: probe with .run() is required');
    }
    if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
      throw new TypeError('SyntheticPingSampler: intervalMs must be >= 1000');
    }
    this._probe = probe;
    this._intervalMs = intervalMs;
    this._setInterval = setIntervalImpl;
    this._clearInterval = clearIntervalImpl;
    this._onError = onError;
    this._timer = null;
    this._inflight = null;
    this._sampleCount = 0;
  }

  get running() { return this._timer !== null; }
  get sampleCount() { return this._sampleCount; }
  get intervalMs() { return this._intervalMs; }
  get probe() { return this._probe; }

  /** Begin sampling. Optionally fires once immediately. */
  start({ runImmediately = false } = {}) {
    if (this._timer) return this;
    this._timer = this._setInterval(() => this._tick(), this._intervalMs);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    if (runImmediately) this._tick();
    return this;
  }

  stop() {
    if (this._timer) {
      this._clearInterval(this._timer);
      this._timer = null;
    }
    return this;
  }

  /** Manually trigger one sample. Returns the probe result. */
  async sampleOnce() {
    return this._tick();
  }

  _tick() {
    if (this._inflight) return this._inflight;
    this._inflight = this._probe.run({ bypassCache: true })
      .then((result) => {
        this._sampleCount += 1;
        return result;
      })
      .catch((err) => {
        if (typeof this._onError === 'function') {
          try { this._onError(err); } catch (_) { /* swallow */ }
        }
        return null;
      })
      .finally(() => { this._inflight = null; });
    return this._inflight;
  }

  /**
   * Latency snapshot computed from the probe's recorded history. Cached
   * results are excluded so percentiles reflect real provider RTT.
   */
  getLatencyStats({ limit } = {}) {
    const records = this._probe.getHistory(limit);
    return summarize(records, this._probe.name);
  }
}

function summarize(records, name) {
  const latencies = [];
  const byStatus = {};
  let lastTimestamp = null;
  let lastElapsedMs = null;
  for (const r of records) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (!r.cached && Number.isFinite(r.elapsedMs)) latencies.push(r.elapsedMs);
    if (r.timestamp) lastTimestamp = r.timestamp;
    if (Number.isFinite(r.elapsedMs)) lastElapsedMs = r.elapsedMs;
  }
  return {
    name,
    samples: latencies.length,
    total: records.length,
    byStatus,
    lastTimestamp,
    lastElapsedMs,
    minMs: latencies.length ? Math.min(...latencies) : null,
    maxMs: latencies.length ? Math.max(...latencies) : null,
    avgMs: latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null,
    p50: pct(latencies, 0.5),
    p95: pct(latencies, 0.95),
    p99: pct(latencies, 0.99),
  };
}

function pct(values, p) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return Math.round(sorted[lo]);
  const frac = idx - lo;
  return Math.round(sorted[lo] * (1 - frac) + sorted[hi] * frac);
}

function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = String(path || '').replace(/^\/+/, '');
  return p ? `${b}/${p}` : b;
}

module.exports = {
  createSyntheticPingProbe,
  SyntheticPingSampler,
};
