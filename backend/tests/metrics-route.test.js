'use strict';

// F5 PR18 — Unit tests for /metrics endpoint.

const test = require('node:test');
const assert = require('node:assert/strict');

function freshRequire() {
  const fullPath = require.resolve('../src/routes/metrics');
  delete require.cache[fullPath];
  return require('../src/routes/metrics');
}

test('formatExposition: emits Prometheus 0.0.4 format with required metrics', () => {
  const { formatExposition } = freshRequire();
  const text = formatExposition();
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

test('checkAuth: open when METRICS_TOKEN unset', () => {
  const { checkAuth } = freshRequire();
  const orig = process.env.METRICS_TOKEN;
  delete process.env.METRICS_TOKEN;
  const req = { get: () => undefined };
  assert.deepEqual(checkAuth(req), { ok: true });
  if (orig) process.env.METRICS_TOKEN = orig;
});

test('checkAuth: rejects missing/wrong Bearer when METRICS_TOKEN set', () => {
  const { checkAuth } = freshRequire();
  const orig = process.env.METRICS_TOKEN;
  process.env.METRICS_TOKEN = 'secret-xyz';
  try {
    assert.equal(checkAuth({ get: () => undefined }).ok, false);
    assert.equal(checkAuth({ get: () => 'Bearer wrong' }).ok, false);
    assert.equal(checkAuth({ get: () => 'Basic abc' }).ok, false);
    assert.equal(checkAuth({ get: () => 'Bearer secret-xyz' }).ok, true);
  } finally {
    if (orig === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = orig;
  }
});

test('router: exposes a single GET / handler', () => {
  const router = freshRequire();
  assert.equal(typeof router, 'function');
  const gets = router.stack.filter((l) => l.route?.methods?.get);
  assert.equal(gets.length, 1);
});

test('formatExposition: ends with a newline (Prometheus parser requirement)', () => {
  const { formatExposition } = freshRequire();
  const text = formatExposition();
  assert.ok(text.endsWith('\n'));
});

test('formatExposition: includes FlashGPT/free-ia fallback counters', () => {
  const { formatExposition } = freshRequire();
  const text = formatExposition();
  assert.ok(/sira_free_ia_fallback_total/.test(text),
    'free-ia counters must be scrapeable from the main /metrics endpoint');
});
