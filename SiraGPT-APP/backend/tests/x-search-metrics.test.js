/**
 * Unit tests for services/x-search-metrics.js — the tiny in-memory counter
 * backing the /api/x-search/metrics + /metrics.prom endpoints.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const m = require('../src/services/x-search-metrics');

beforeEach(() => m.reset());

test('recordSearch increments searches and accumulates posts', () => {
  m.recordSearch({ resultCount: 3 });
  m.recordSearch({ resultCount: 2 });
  const s = m.snapshot();
  assert.equal(s.searches, 2);
  assert.equal(s.posts, 5);
  assert.equal(s.lastEventAt !== null, true);
});

test('recordError increments errors + per-code counts and topErrorCodes sorts them', () => {
  m.recordError({ code: 'http_500' });
  m.recordError({ code: 'http_500' });
  m.recordError({ code: 'timeout' });
  const s = m.snapshot();
  assert.equal(s.errors, 3);
  assert.equal(s.topErrorCodes[0].code, 'http_500');
  assert.equal(s.topErrorCodes[0].count, 2);
});

test('recordUnconfigured is tracked separately and does not affect successRate', () => {
  m.recordUnconfigured();
  m.recordSearch({ resultCount: 1 });
  const s = m.snapshot();
  assert.equal(s.unconfigured, 1);
  assert.equal(s.successRate, 1); // unconfigured is not an error
});

test('successRate reflects searches vs errors', () => {
  m.recordSearch({ resultCount: 1 });
  m.recordSearch({ resultCount: 1 });
  m.recordSearch({ resultCount: 1 });
  m.recordError({ code: 'network' });
  assert.equal(m.snapshot().successRate, 0.75);
});

test('successRate is null with no traffic', () => {
  assert.equal(m.snapshot().successRate, null);
});

test('toPrometheusText emits the expected metric families and escapes labels', () => {
  m.recordSearch({ resultCount: 4 });
  m.recordError({ code: 'http_429' });
  const text = m.toPrometheusText();
  assert.match(text, /# TYPE sira_x_search_total counter/);
  assert.match(text, /sira_x_search_total 1/);
  assert.match(text, /sira_x_search_posts_total 4/);
  assert.match(text, /sira_x_search_errors_total 1/);
  assert.match(text, /sira_x_search_error_code_total\{code="http_429"\} 1/);
  assert.equal(text.endsWith('\n'), true);
});

test('reset zeroes all counters', () => {
  m.recordSearch({ resultCount: 9 });
  m.recordError({ code: 'x' });
  m.recordUnconfigured();
  m.reset();
  const s = m.snapshot();
  assert.deepEqual(
    { searches: s.searches, posts: s.posts, errors: s.errors, unconfigured: s.unconfigured, last: s.lastEventAt },
    { searches: 0, posts: 0, errors: 0, unconfigured: 0, last: null },
  );
});
