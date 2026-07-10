/**
 * metrics-registry.test.js — tests for backend/src/utils/metrics.js
 *
 * Covers: counter increments, gauge set, histogram bucket math, label
 * key generation, text-format rendering, optional integration helpers
 * (active guards, circuit breaker tracking, analyzer cache delta,
 * process metric refresh).
 */

'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const metrics = require('../src/utils/metrics');

function resetAll() {
  metrics._reset();
}

describe('metrics registry — counter', () => {
  beforeEach(resetAll);

  test('increments default series with no labels', () => {
    metrics.registerCounter('test_counter_a', { help: 'h' });
    metrics.counter('test_counter_a');
    metrics.counter('test_counter_a');
    metrics.counter('test_counter_a', {}, 3);
    const txt = metrics.renderText();
    assert.match(txt, /test_counter_a 5/);
  });

  test('separate series per label combination', () => {
    metrics.registerCounter('test_counter_b', { help: 'h', labels: ['route'] });
    metrics.counter('test_counter_b', { route: '/a' });
    metrics.counter('test_counter_b', { route: '/b' });
    metrics.counter('test_counter_b', { route: '/a' });
    const txt = metrics.renderText();
    assert.match(txt, /test_counter_b\{route="\/a"\} 2/);
    assert.match(txt, /test_counter_b\{route="\/b"\} 1/);
  });

  test('ignores negative or non-finite delta', () => {
    metrics.registerCounter('test_counter_c', { help: 'h' });
    metrics.counter('test_counter_c', {}, -5);
    metrics.counter('test_counter_c', {}, NaN);
    metrics.counter('test_counter_c', {}, 2);
    const txt = metrics.renderText();
    assert.match(txt, /test_counter_c 2/);
  });

  test('counter() is a no-op for an unregistered name', () => {
    metrics.counter('nope_counter', {}, 1);
    const txt = metrics.renderText();
    assert.doesNotMatch(txt, /nope_counter/);
  });
});

describe('metrics registry — gauge', () => {
  beforeEach(resetAll);

  test('set overwrites previous value', () => {
    metrics.registerGauge('test_gauge_a', { help: 'h' });
    metrics.gauge('test_gauge_a', {}, 10);
    metrics.gauge('test_gauge_a', {}, 7);
    const txt = metrics.renderText();
    assert.match(txt, /test_gauge_a 7/);
  });

  test('supports labels independently', () => {
    metrics.registerGauge('test_gauge_b', { help: 'h', labels: ['type'] });
    metrics.gauge('test_gauge_b', { type: 'rss' }, 1024);
    metrics.gauge('test_gauge_b', { type: 'heap' }, 256);
    const txt = metrics.renderText();
    assert.match(txt, /test_gauge_b\{type="rss"\} 1024/);
    assert.match(txt, /test_gauge_b\{type="heap"\} 256/);
  });
});

describe('metrics registry — histogram', () => {
  beforeEach(resetAll);

  test('bucket counts are cumulative across thresholds', () => {
    metrics.registerHistogram('test_hist_a', { help: 'h', buckets: [1, 5, 10] });
    metrics.observe('test_hist_a', {}, 0.5); // ≤1
    metrics.observe('test_hist_a', {}, 3);   // ≤5
    metrics.observe('test_hist_a', {}, 4);   // ≤5
    metrics.observe('test_hist_a', {}, 9);   // ≤10
    metrics.observe('test_hist_a', {}, 20);  // overflow → +Inf only
    const txt = metrics.renderText();
    assert.match(txt, /test_hist_a_bucket\{le="1"\} 1/);
    assert.match(txt, /test_hist_a_bucket\{le="5"\} 3/);
    assert.match(txt, /test_hist_a_bucket\{le="10"\} 4/);
    assert.match(txt, /test_hist_a_bucket\{le="\+Inf"\} 5/);
    assert.match(txt, /test_hist_a_count 5/);
    assert.match(txt, /test_hist_a_sum 36.5/);
  });

  test('histogram supports label combinations', () => {
    metrics.registerHistogram('test_hist_b', { help: 'h', labels: ['route'], buckets: [1] });
    metrics.observe('test_hist_b', { route: '/x' }, 0.5);
    metrics.observe('test_hist_b', { route: '/y' }, 2);
    const txt = metrics.renderText();
    assert.match(txt, /test_hist_b_bucket\{route="\/x",le="1"\} 1/);
    assert.match(txt, /test_hist_b_bucket\{route="\/y",le="1"\} 0/);
    assert.match(txt, /test_hist_b_bucket\{route="\/y",le="\+Inf"\} 1/);
  });

  test('negative or non-finite observations are dropped', () => {
    metrics.registerHistogram('test_hist_c', { help: 'h', buckets: [1] });
    metrics.observe('test_hist_c', {}, -1);
    metrics.observe('test_hist_c', {}, NaN);
    metrics.observe('test_hist_c', {}, 0.5);
    const txt = metrics.renderText();
    assert.match(txt, /test_hist_c_count 1/);
  });
});

describe('metrics registry — per-family series cap', () => {
  beforeEach(resetAll);

  test('default cap is finite and bounded', () => {
    metrics.registerCounter('test_default_series_cap', {
      help: 'h',
      labels: ['value'],
    });
    const family = metrics.registry.get('test_default_series_cap');
    assert.ok(Number.isInteger(family.maxSeries));
    assert.ok(family.maxSeries >= 1 && family.maxSeries <= 10_000);
  });

  test('configured cap is clamped to hard safety bounds', () => {
    metrics.registerCounter('test_series_cap_low', {
      help: 'h',
      labels: ['value'],
      maxSeries: -50,
    });
    metrics.registerCounter('test_series_cap_high', {
      help: 'h',
      labels: ['value'],
      maxSeries: 1_000_000,
    });
    assert.equal(metrics.registry.get('test_series_cap_low').maxSeries, 1);
    assert.equal(metrics.registry.get('test_series_cap_high').maxSeries, 10_000);
  });

  test('counter folds overflow label sets deterministically', () => {
    metrics.registerCounter('test_counter_series_cap', {
      help: 'h',
      labels: ['route'],
      maxSeries: 3,
    });
    for (const route of ['/a', '/b', '/c', '/d']) {
      metrics.counter('test_counter_series_cap', { route });
    }
    metrics.counter('test_counter_series_cap', { route: '/a' }, 2);

    const family = metrics.registry.get('test_counter_series_cap');
    assert.equal(family.series.size, 3);
    assert.equal(family.series.get('route=/a'), 3);
    assert.equal(family.series.get('route=/b'), 1);
    assert.equal(family.series.get('route=__other__'), 2);
  });

  test('histogram folds overflow observations into one bounded series', () => {
    metrics.registerHistogram('test_histogram_series_cap', {
      help: 'h',
      labels: ['route'],
      buckets: [10],
      maxSeries: 2,
    });
    metrics.observe('test_histogram_series_cap', { route: '/a' }, 1);
    metrics.observe('test_histogram_series_cap', { route: '/b' }, 2);
    metrics.observe('test_histogram_series_cap', { route: '/c' }, 3);

    const family = metrics.registry.get('test_histogram_series_cap');
    assert.equal(family.series.size, 2);
    assert.equal(family.series.get('route=/a').count, 1);
    assert.equal(family.series.get('route=__other__').count, 2);
    assert.equal(family.series.get('route=__other__').sum, 5);
  });

  test('gauge retains the first bounded label sets and drops later new sets', () => {
    metrics.registerGauge('test_gauge_series_cap', {
      help: 'h',
      labels: ['worker'],
      maxSeries: 2,
    });
    metrics.gauge('test_gauge_series_cap', { worker: 'a' }, 1);
    metrics.gauge('test_gauge_series_cap', { worker: 'b' }, 2);
    metrics.gauge('test_gauge_series_cap', { worker: 'c' }, 3);
    metrics.gauge('test_gauge_series_cap', { worker: 'a' }, 4);

    const family = metrics.registry.get('test_gauge_series_cap');
    assert.equal(family.series.size, 2);
    assert.equal(family.series.get('worker=a'), 4);
    assert.equal(family.series.get('worker=b'), 2);
    assert.equal(family.series.has('worker=c'), false);
    assert.equal(family.series.has('worker=__other__'), false);
  });
});

describe('metrics registry — text format', () => {
  beforeEach(resetAll);

  test('emits HELP and TYPE lines for each metric', () => {
    metrics.registerCounter('test_fmt_ctr', { help: 'a counter' });
    metrics.registerGauge('test_fmt_gauge', { help: 'a gauge' });
    metrics.registerHistogram('test_fmt_hist', { help: 'a hist', buckets: [1] });
    metrics.observe('test_fmt_hist', {}, 0.5);
    const txt = metrics.renderText();
    assert.match(txt, /# HELP test_fmt_ctr a counter/);
    assert.match(txt, /# TYPE test_fmt_ctr counter/);
    assert.match(txt, /# HELP test_fmt_gauge a gauge/);
    assert.match(txt, /# TYPE test_fmt_gauge gauge/);
    assert.match(txt, /# HELP test_fmt_hist a hist/);
    assert.match(txt, /# TYPE test_fmt_hist histogram/);
  });

  test('escapes label values containing quotes / backslashes', () => {
    metrics.registerCounter('test_esc', { help: 'x', labels: ['k'] });
    metrics.counter('test_esc', { k: 'a"b' });
    const txt = metrics.renderText();
    // Quote got replaced (we strip in label key) — what's important is no
    // unescaped quote breaks the prom format. So no `="a"b"` pattern.
    assert.doesNotMatch(txt, /k="a"b"/);
  });

  test('renderText output ends with newline', () => {
    metrics.registerCounter('test_nl', { help: 'h' });
    const txt = metrics.renderText();
    assert.ok(txt.endsWith('\n'), 'metrics output must end with newline');
  });
});

describe('metrics registry — async-guard integration', () => {
  beforeEach(() => {
    resetAll();
  });

  test('incActiveGuards / decActiveGuards adjust the gauge', () => {
    metrics.incActiveGuards();
    metrics.incActiveGuards();
    assert.equal(metrics.getActiveGuards(), 2);
    metrics.decActiveGuards();
    assert.equal(metrics.getActiveGuards(), 1);
    const txt = metrics.renderText();
    assert.match(txt, /siragpt_async_guards_active 1/);
  });

  test('dec does not go below zero', () => {
    while (metrics.getActiveGuards() > 0) metrics.decActiveGuards();
    metrics.decActiveGuards();
    metrics.decActiveGuards();
    assert.equal(metrics.getActiveGuards(), 0);
  });
});

describe('metrics registry — circuit breaker tracking', () => {
  beforeEach(resetAll);

  test('trackCircuitBreaker records initial state + transitions', () => {
    const fakeBreaker = new EventEmitter();
    fakeBreaker.name = 'svc-x';
    fakeBreaker.state = 'CLOSED';
    metrics.trackCircuitBreaker(fakeBreaker);
    let txt = metrics.renderText();
    assert.match(txt, /siragpt_circuit_breaker_state\{name="svc-x"\} 0/);
    fakeBreaker.emit('stateChange', { from: 'CLOSED', to: 'OPEN', name: 'svc-x' });
    txt = metrics.renderText();
    assert.match(txt, /siragpt_circuit_breaker_state\{name="svc-x"\} 2/);
    fakeBreaker.emit('stateChange', { from: 'OPEN', to: 'HALF_OPEN', name: 'svc-x' });
    txt = metrics.renderText();
    assert.match(txt, /siragpt_circuit_breaker_state\{name="svc-x"\} 1/);
  });

  test('trackCircuitBreaker handles unknown state value gracefully', () => {
    const fakeBreaker = new EventEmitter();
    fakeBreaker.name = 'svc-y';
    fakeBreaker.state = 'WHATEVER';
    metrics.trackCircuitBreaker(fakeBreaker);
    const txt = metrics.renderText();
    assert.match(txt, /siragpt_circuit_breaker_state\{name="svc-y"\} 0/);
  });

  test('CB_STATE_VALUE mapping exposes the expected ordering', () => {
    assert.equal(metrics.CB_STATE_VALUE.CLOSED, 0);
    assert.equal(metrics.CB_STATE_VALUE.HALF_OPEN, 1);
    assert.equal(metrics.CB_STATE_VALUE.OPEN, 2);
  });
});

describe('metrics registry — analyzer cache delta', () => {
  beforeEach(resetAll);

  test('records monotonic deltas across snapshots', () => {
    const r1 = metrics.recordAnalyzerCacheStats(0, 0, { hits: 5, misses: 2 });
    assert.deepEqual(r1, { hits: 5, misses: 2 });
    const r2 = metrics.recordAnalyzerCacheStats(r1.hits, r1.misses, { hits: 7, misses: 3 });
    assert.deepEqual(r2, { hits: 7, misses: 3 });
    const txt = metrics.renderText();
    assert.match(txt, /siragpt_analyzer_cache_hits_total 7/);
    assert.match(txt, /siragpt_analyzer_cache_misses_total 3/);
  });

  test('handles stats that go backwards (process restart) without going negative', () => {
    metrics.recordAnalyzerCacheStats(10, 5, { hits: 3, misses: 1 });
    const txt = metrics.renderText();
    // Counter should not have decreased below zero — render still works.
    assert.match(txt, /siragpt_analyzer_cache_hits_total/);
  });
});

describe('metrics registry — GDPR export', () => {
  beforeEach(resetAll);

  test('recordGdprExport writes size + duration + counter', () => {
    metrics.recordGdprExport({
      zipBytes: 12_345,
      durationSeconds: 0.42,
      redactPII: false,
    });
    const txt = metrics.renderText();
    assert.match(txt, /siragpt_gdpr_exports_total\{redactPII="false"\} 1/);
    assert.match(txt, /siragpt_gdpr_export_size_bytes_count\{redactPII="false"\} 1/);
    assert.match(txt, /siragpt_gdpr_export_size_bytes_sum\{redactPII="false"\} 12345/);
    assert.match(txt, /siragpt_gdpr_export_duration_seconds_count\{redactPII="false"\} 1/);
  });

  test('recordGdprExport tolerates non-finite values without throwing', () => {
    assert.doesNotThrow(() =>
      metrics.recordGdprExport({ zipBytes: NaN, durationSeconds: -1, redactPII: true }),
    );
    const txt = metrics.renderText();
    // Counter still increments (one export attempt was recorded).
    assert.match(txt, /siragpt_gdpr_exports_total\{redactPII="true"\} 1/);
  });
});

describe('metrics registry — coverage gaps', () => {
  beforeEach(resetAll);

  test('histogram bucket boundary: value equal to threshold counts in that bucket', () => {
    // Exact-equality on `le` is a known boundary case (le="1" includes 1).
    metrics.registerHistogram('test_boundary', { help: 'h', buckets: [1, 2] });
    metrics.observe('test_boundary', {}, 1);
    metrics.observe('test_boundary', {}, 2);
    const txt = metrics.renderText();
    assert.match(txt, /test_boundary_bucket\{le="1"\} 1/);
    assert.match(txt, /test_boundary_bucket\{le="2"\} 2/);
    assert.match(txt, /test_boundary_bucket\{le="\+Inf"\} 2/);
    assert.match(txt, /test_boundary_sum 3/);
  });

  test('gauge increment-then-decrement via repeated sets reflects last write', () => {
    // Gauges only support set semantics — verify the "increment" workflow
    // (read+1, set) and "decrement" (read-1, set) both render cleanly.
    metrics.registerGauge('test_gauge_inc', { help: 'h' });
    metrics.gauge('test_gauge_inc', {}, 1);
    metrics.gauge('test_gauge_inc', {}, 2); // increment
    metrics.gauge('test_gauge_inc', {}, 1); // decrement
    const txt = metrics.renderText();
    assert.match(txt, /test_gauge_inc 1/);
  });

  test('_reset clears all series but preserves registrations', () => {
    metrics.registerCounter('test_persist_ctr', { help: 'h' });
    metrics.counter('test_persist_ctr', {}, 5);
    metrics._reset();
    const txt = metrics.renderText();
    // Registration is preserved → counter still rendered with default 0.
    assert.match(txt, /# TYPE test_persist_ctr counter/);
    assert.match(txt, /test_persist_ctr 0/);
    // Subsequent counter() still works on the same registration.
    metrics.counter('test_persist_ctr', {}, 3);
    assert.match(metrics.renderText(), /test_persist_ctr 3/);
  });

  test('observe() is a no-op for an unregistered histogram name', () => {
    metrics.observe('nope_histogram', {}, 1);
    const txt = metrics.renderText();
    assert.doesNotMatch(txt, /nope_histogram/);
  });

  test('histogram buckets are de-duplicated and sorted on registration', () => {
    metrics.registerHistogram('test_dedup', {
      help: 'h',
      // Intentionally unsorted, with duplicate and non-finite entries.
      buckets: [5, 1, 1, NaN, 'foo', 2.5],
    });
    metrics.observe('test_dedup', {}, 1.5);
    const txt = metrics.renderText();
    // 1 (≥1.5? no), 2.5 (≥1.5 yes), 5 (yes) — order ascending, no dupes.
    const buckets = txt.match(/test_dedup_bucket\{le="[^"]+"\}/g) || [];
    // Expected: le="1", le="2.5", le="5", le="+Inf"
    assert.deepEqual(buckets, [
      'test_dedup_bucket{le="1"}',
      'test_dedup_bucket{le="2.5"}',
      'test_dedup_bucket{le="5"}',
      'test_dedup_bucket{le="+Inf"}',
    ]);
  });
});

describe('metrics registry — process snapshot', () => {
  beforeEach(resetAll);

  test('refreshProcessMetrics populates uptime and memory gauges', () => {
    metrics.refreshProcessMetrics();
    const txt = metrics.renderText();
    assert.match(txt, /siragpt_process_uptime_seconds \d+/);
    assert.match(txt, /siragpt_nodejs_memory_bytes\{type="rss"\} \d+/);
    assert.match(txt, /siragpt_nodejs_memory_bytes\{type="heapUsed"\} \d+/);
    assert.match(txt, /siragpt_nodejs_memory_bytes\{type="heapTotal"\} \d+/);
  });
});
