'use strict';

// F5 PR18 — Unit tests for /metrics endpoint.

const test = require('node:test');
const assert = require('node:assert/strict');

function freshRequire() {
  const fullPath = require.resolve('../src/routes/metrics');
  delete require.cache[fullPath];
  return require('../src/routes/metrics');
}

function processFormatter() {
  return require('../src/services/observability/process-metrics-exposition');
}

test('formatExposition: emits Prometheus 0.0.4 format with required metrics', () => {
  const { formatProcessMetricsExposition } = processFormatter();
  const text = formatProcessMetricsExposition();
  // Required metrics + their TYPE lines
  for (const name of [
    'siragpt_build_info',
    'siragpt_uptime_seconds',
    'siragpt_memory_rss_bytes',
    'siragpt_memory_heap_total_bytes',
    'siragpt_memory_heap_used_bytes',
    'siragpt_event_loop_lag_ms',
  ]) {
    assert.match(text, new RegExp(`^# HELP ${name} `, 'm'), `missing HELP for ${name}`);
    assert.match(text, new RegExp(`^# TYPE ${name} gauge`, 'm'), `missing TYPE for ${name}`);
  }
  // build_info has a label
  assert.match(text, /siragpt_build_info\{version="[^"]+"\} 1/);
  // uptime is a non-negative float
  assert.match(text, /siragpt_uptime_seconds \d+(\.\d+)?/);
});

test('router: delegates its compatibility path to the shared protected handler', () => {
  const router = freshRequire();
  const { metricsHandler } = require('../src/services/observability/metrics-exposition');
  assert.equal(typeof router, 'function');
  const gets = router.stack.filter((l) => l.route?.methods?.get);
  assert.equal(gets.length, 1);
  assert.equal(gets[0].route.path, '/');
  assert.equal(gets[0].route.stack.at(-1).handle, metricsHandler);
});

test('formatExposition: ends with a newline (Prometheus parser requirement)', () => {
  const { formatProcessMetricsExposition } = processFormatter();
  const text = formatProcessMetricsExposition();
  assert.ok(text.endsWith('\n'));
});

test('formatExposition: includes FlashGPT/free-ia fallback counters', () => {
  const { formatProcessMetricsExposition } = processFormatter();
  const text = formatProcessMetricsExposition();
  assert.ok(/sira_free_ia_fallback_total/.test(text),
    'free-ia counters must be scrapeable from the main /metrics endpoint');
});

test('process formatter propagates cognitive exporter failures', () => {
  const { formatProcessMetricsExposition } = processFormatter();
  assert.throws(
    () => formatProcessMetricsExposition({
      cognitiveMetrics: { toPrometheusText() { throw new Error('cognitive export failed'); } },
      freeIaMetrics: { toPrometheusText: () => '# HELP free ok\n# TYPE free counter\nfree 0\n' },
    }),
    /cognitive export failed/,
  );
});

test('process formatter propagates Free-IA exporter failures', () => {
  const { formatProcessMetricsExposition } = processFormatter();
  assert.throws(
    () => formatProcessMetricsExposition({
      cognitiveMetrics: { toPrometheusText: () => '# HELP cognitive ok\n# TYPE cognitive counter\ncognitive 0\n' },
      freeIaMetrics: { toPrometheusText() { throw new Error('free-ia export failed'); } },
    }),
    /free-ia export failed/,
  );
});
