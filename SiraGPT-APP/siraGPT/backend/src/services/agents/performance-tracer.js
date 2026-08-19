/**
 * performance-tracer — lightweight operation tracing and metrics aggregation.
 *
 * Traces the lifecycle of an operation through the system, recording
 * elapsed time at each phase. Designed for agentic workflows where a
 * single user request may fan out across multiple sub-agents, provider
 * calls, and tool executions.
 *
 * Architecture:
 *   Tracer
 *     ├── start(operation)    → creates a new span
 *     ├── child(parent)       → creates a child span
 *     ├── end(span)           → records duration, emits event
 *     └── snapshot()          → returns all completed spans
 *
 * Output format is compatible with OpenTelemetry's span model (trace_id,
 * span_id, parent_span_id, name, start_time, end_time, duration_ms,
 * status, attributes) so traces can be exported to any OTel-compatible
 * backend (Jaeger, Grafana Tempo, etc.) without an SDK dependency.
 *
 * Usage:
 *   const tracer = new Tracer({ service: 'siragpt-agent' });
 *   const root = tracer.start('orchestrate');
 *   const child = tracer.start('sub-agent:research', root.spanId);
 *   // ... do work ...
 *   tracer.end(child, { status: 'ok', attributes: { steps: 5 } });
 *   tracer.end(root);
 *   const report = tracer.snapshot();  // [{ name, durationMs, ... }]
 */

const { generateTraceId, getLogger } = require('./structured-logger');

const log = getLogger('perf-tracer');

// ─── Tracer ────────────────────────────────────────────────────────────────

class Tracer {
  /**
   * @param {object} [opts]
   * @param {string} [opts.service='siragpt']  — service name for all spans
   * @param {boolean} [opts.enabled=true]       — set false to disable (no-op)
   * @param {number} [opts.maxSpans=1000]        — cap to prevent memory leak
   */
  constructor(opts = {}) {
    this.service = opts.service || 'siragpt';
    this.enabled = opts.enabled !== false;
    this.maxSpans = opts.maxSpans || 1000;
    this._spans = [];
    this._activeSpans = new Map();
  }

  /**
   * Start a new span (operation recording).
   *
   * @param {string} name         — operation name (e.g., "sub-agent:research")
   * @param {string} [parentSpanId]  — parent span ID to create hierarchy
   * @param {object} [attributes]    — initial attributes
   * @returns {object}  span descriptor { spanId, traceId, name, ... }
   */
  start(name, parentSpanId = null, attributes = {}) {
    if (!this.enabled) {
      return { spanId: null, traceId: null, name, _noop: true };
    }

    const spanId = generateTraceId().slice(0, 24);
    const traceId = parentSpanId
      ? (this._activeSpans.get(parentSpanId)?.traceId || generateTraceId())
      : generateTraceId();

    const span = {
      spanId,
      traceId,
      parentSpanId,
      name,
      service: this.service,
      startTime: Date.now(),
      startTimeISO: new Date().toISOString(),
      endTime: null,
      endTimeISO: null,
      durationMs: null,
      status: 'ok',
      attributes: { ...attributes },
    };

    this._spans.push(span);
    this._activeSpans.set(spanId, span);

    // Enforce capacity
    if (this._spans.length > this.maxSpans) {
      const removed = this._spans.splice(0, this._spans.length - this.maxSpans);
      for (const s of removed) {
        this._activeSpans.delete(s.spanId);
      }
    }

    return span;
  }

  /**
   * End a span, recording its duration.
   *
   * @param {object} span           — returned from start()
   * @param {object} [opts]
   * @param {'ok'|'error'} [opts.status='ok']
   * @param {object} [opts.attributes]  — additional attributes to merge
   */
  end(span, opts = {}) {
    if (!this.enabled || !span || span._noop) return;

    span.endTime = Date.now();
    span.endTimeISO = new Date().toISOString();
    span.durationMs = span.endTime - span.startTime;
    span.status = opts.status || 'ok';

    if (opts.attributes) {
      Object.assign(span.attributes, opts.attributes);
    }

    this._activeSpans.delete(span.spanId);

    log.debug('span complete', {
      name: span.name,
      durationMs: span.durationMs,
      status: span.status,
      traceId: span.traceId?.slice(0, 16),
    });
  }

  /**
   * Mark an error on an active span without ending it.
   */
  error(span, error, attributes = {}) {
    if (!this.enabled || !span || span._noop) return;

    span.status = 'error';
    span.attributes.error = error?.message || String(error);
    Object.assign(span.attributes, attributes);
  }

  /**
   * Execute a function inside a traced span. The span is automatically
   * ended when the function completes (or throws).
   *
   * @param {string} name
   * @param {Function} fn        — async () => T
   * @param {object} [opts]
   * @param {string} [opts.parentSpanId]
   * @param {object} [opts.attributes]
   * @returns {Promise<{ result: T, span: object }>}
   */
  async trace(name, fn, opts = {}) {
    const span = this.start(name, opts.parentSpanId, opts.attributes);

    try {
      const result = await fn();
      this.end(span, { status: 'ok' });
      return { result, span };
    } catch (err) {
      this.end(span, { status: 'error', attributes: { error: err.message } });
      throw err;
    }
  }

  /**
   * Record a metric value (gauge/histogram point).
   *
   * @param {string} name   — metric name
   * @param {number} value  — numeric value
   * @param {object} [tags] — key-value tags
   */
  gauge(name, value, tags = {}) {
    if (!this.enabled) return;

    this._spans.push({
      spanId: null,
      traceId: null,
      parentSpanId: null,
      name: `__metric:${name}`,
      service: this.service,
      startTime: Date.now(),
      startTimeISO: new Date().toISOString(),
      endTime: null,
      endTimeISO: null,
      durationMs: null,
      status: 'metric',
      attributes: { value, ...tags },
      _metric: true,
    });
  }

  /**
   * Snapshot all completed spans as an array.
   * Optionally filter to a specific trace.
   *
   * @param {string} [traceId]
   * @returns {Array}
   */
  snapshot(traceId = null) {
    const spans = this._spans.filter(s => s.endTime !== null);
    if (traceId) {
      return spans.filter(s => s.traceId === traceId);
    }
    return spans;
  }

  /**
   * Get a summary of all traces, with aggregated metrics per span name.
   */
  summary() {
    const completed = this._spans.filter(s => s.endTime !== null && !s._metric);

    const byName = {};
    for (const span of completed) {
      if (!byName[span.name]) {
        byName[span.name] = { count: 0, totalMs: 0, errors: 0 };
      }
      byName[span.name].count++;
      byName[span.name].totalMs += span.durationMs;
      if (span.status === 'error') byName[span.name].errors++;
    }

    const names = Object.entries(byName).map(([name, stats]) => ({
      name,
      count: stats.count,
      avgMs: Math.round(stats.totalMs / stats.count),
      totalMs: stats.totalMs,
      errors: stats.errors,
      errorRate: stats.count > 0 ? (stats.errors / stats.count * 100).toFixed(1) + '%' : '0%',
    }));

    const totalDurationMs = completed.reduce((sum, s) => sum + s.durationMs, 0);

    return {
      totalSpans: completed.length,
      totalDurationMs,
      uniqueOperations: names.length,
      operations: names.sort((a, b) => b.totalMs - a.totalMs),
      slowest: names.slice(0, 5),
    };
  }

  /**
   * Clear all recorded spans.
   */
  reset() {
    this._spans = [];
    this._activeSpans.clear();
  }

  /**
   * Export all spans to OpenTelemetry-compatible JSON format.
   */
  exportOtlp() {
    return this._spans
      .filter(s => s.endTime !== null && !s._metric)
      .map(s => ({
        traceId: s.traceId,
        spanId: s.spanId,
        parentSpanId: s.parentSpanId,
        name: s.name,
        startTimeUnixNano: BigInt(s.startTime) * 1_000_000n,
        endTimeUnixNano: BigInt(s.endTime) * 1_000_000n,
        durationMs: s.durationMs,
        status: { code: s.status === 'error' ? 2 : 1 },
        attributes: Object.entries(s.attributes).map(([key, value]) => ({
          key,
          value: { stringValue: String(value) },
        })),
      }));
  }
}

// ─── Metrics aggregator ────────────────────────────────────────────────────

class MetricsAggregator {
  /**
   * @param {object} [opts]
   * @param {number} [opts.windowMs=60000]  — rolling window for aggregation
   */
  constructor(opts = {}) {
    this.windowMs = opts.windowMs || 60_000;
    this._counters = new Map();
    this._timings = new Map();
  }

  /**
   * Increment a counter.
   */
  increment(name, by = 1, tags = {}) {
    const key = `${name}:${JSON.stringify(tags)}`;
    if (!this._counters.has(key)) {
      this._counters.set(key, { name, tags, value: 0, window: [] });
    }
    const entry = this._counters.get(key);
    entry.value += by;
    entry.window.push(Date.now());
    this._prune(entry);
  }

  /**
   * Record a timing value.
   */
  timing(name, durationMs, tags = {}) {
    const key = `${name}:${JSON.stringify(tags)}`;
    if (!this._timings.has(key)) {
      this._timings.set(key, { name, tags, values: [] });
    }
    const entry = this._timings.get(key);
    entry.values.push(durationMs);
    // Keep only last 1000 values per timing
    if (entry.values.length > 1000) entry.values.shift();
  }

  /**
   * Prune expired entries from a counter's rolling window.
   */
  _prune(entry) {
    const cutoff = Date.now() - this.windowMs;
    while (entry.window.length > 0 && entry.window[0] < cutoff) {
      entry.window.shift();
    }
  }

  /**
   * Snapshot all counters and timings.
   */
  snapshot() {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    const counters = Array.from(this._counters.values()).map(e => ({
      name: e.name,
      tags: e.tags,
      value: e.value,
      rate1m: e.window.filter(t => t > cutoff).length / (this.windowMs / 1000),
    }));

    const timings = Array.from(this._timings.values()).map(e => {
      const vals = e.values;
      const sorted = [...vals].sort((a, b) => a - b);
      return {
        name: e.name,
        tags: e.tags,
        count: vals.length,
        avg: vals.length > 0 ? vals.reduce((a, b) => a + b) / vals.length : 0,
        p50: sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.5)] : 0,
        p95: sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0,
        p99: sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.99)] : 0,
        min: sorted[0] || 0,
        max: sorted[sorted.length - 1] || 0,
      };
    });

    return { counters, timings };
  }

  reset() {
    this._counters.clear();
    this._timings.clear();
  }
}

// ── Singleton helpers (used by agent-system.js) ───────────────────

let _defaultTracer = null;
let _defaultMetrics = null;

/**
 * Get or create the default Tracer singleton.
 */
function getTracer(opts = {}) {
  if (!_defaultTracer) {
    _defaultTracer = new Tracer(opts);
  } else if (opts.enabled !== undefined) {
    _defaultTracer.enabled = opts.enabled;
  }
  return _defaultTracer;
}

/**
 * Get or create the default MetricsAggregator singleton.
 */
function getMetrics() {
  if (!_defaultMetrics) {
    _defaultMetrics = new MetricsAggregator();
  }
  return _defaultMetrics;
}

module.exports = {
  Tracer,
  MetricsAggregator,
  getTracer,
  getMetrics,
};
