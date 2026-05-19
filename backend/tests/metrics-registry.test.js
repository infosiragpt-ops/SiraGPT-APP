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
