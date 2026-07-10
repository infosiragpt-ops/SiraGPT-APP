/**
 * Tests for backend/src/middleware/red-metrics.js
 *
 * Drives the middleware with synthetic Express-like request/response
 * objects so we don't need to spin up a real HTTP server.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const metrics = require('../src/services/agents/metrics');
const {
  redMetricsMiddleware,
  routeLabel,
  statusClass,
  RED_REQUESTS_TOTAL,
  RED_ERRORS_TOTAL,
  RED_DURATION,
} = require('../src/middleware/red-metrics');

function makeReq({ method = 'GET', baseUrl = '', route, path, originalUrl } = {}) {
  return { method, baseUrl, route, path, originalUrl };
}

function makeRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.writableEnded = false;
  return res;
}

function findSeries(name, predicate) {
  const m = metrics.registry.get(name);
  if (!m) return null;
  for (const [k, v] of m.series) {
    if (predicate(k)) return { key: k, value: v };
  }
  return null;
}

describe('red-metrics middleware', () => {
  beforeEach(() => {
    metrics._reset();
  });

  it('routeLabel returns matched pattern + baseUrl', () => {
    assert.equal(
      routeLabel({ baseUrl: '/api/users', route: { path: '/:id' } }),
      '/api/users/:id',
    );
    assert.equal(routeLabel({ baseUrl: '', route: undefined }), 'unmatched');
  });

  it('statusClass buckets correctly', () => {
    assert.equal(statusClass(200), '2xx');
    assert.equal(statusClass(301), '3xx');
    assert.equal(statusClass(404), '4xx');
    assert.equal(statusClass(500), '5xx');
    assert.equal(statusClass(0), 'unknown');
  });

  it('records counter + histogram on finish (2xx)', () => {
    const req = makeReq({ baseUrl: '/api', route: { path: '/ping' } });
    const res = makeRes();
    redMetricsMiddleware(req, res, () => {});
    res.statusCode = 204;
    res.writableEnded = true;
    res.emit('finish');

    const totalSeries = findSeries(RED_REQUESTS_TOTAL, (k) =>
      k.includes('route=/api/ping') && k.includes('status_class=2xx'),
    );
    assert.ok(totalSeries, 'expected http_requests_total series for 2xx');
    assert.equal(totalSeries.value, 1);

    const histSeries = findSeries(RED_DURATION, (k) => k.includes('route=/api/ping'));
    assert.ok(histSeries, 'expected duration histogram series');
    assert.equal(histSeries.value.count, 1);
    assert.ok(histSeries.value.sum >= 0);

    const errSeries = findSeries(RED_ERRORS_TOTAL, () => true);
    assert.equal(errSeries, null, '2xx must not increment error counter');
  });

  it('counts 5xx as error', () => {
    const req = makeReq({ baseUrl: '/api', route: { path: '/boom' } });
    const res = makeRes();
    redMetricsMiddleware(req, res, () => {});
    res.statusCode = 503;
    res.writableEnded = true;
    res.emit('finish');

    const errSeries = findSeries(RED_ERRORS_TOTAL, (k) =>
      k.includes('status_class=5xx'),
    );
    assert.ok(errSeries, 'expected 5xx error series');
    assert.equal(errSeries.value, 1);
  });

  it('counts aborted connections as errors with status_class=aborted', () => {
    const req = makeReq({ baseUrl: '', route: { path: '/stream' } });
    const res = makeRes();
    redMetricsMiddleware(req, res, () => {});
    // Simulate client aborting before response is finished.
    res.writableEnded = false;
    res.emit('close');

    const abortedReq = findSeries(RED_REQUESTS_TOTAL, (k) =>
      k.includes('status_class=aborted'),
    );
    assert.ok(abortedReq, 'expected aborted request series');
    const abortedErr = findSeries(RED_ERRORS_TOTAL, (k) =>
      k.includes('status_class=aborted'),
    );
    assert.ok(abortedErr, 'expected aborted error series');
  });

  it('does not double-record when finish + close both fire', () => {
    const req = makeReq({ baseUrl: '/api', route: { path: '/once' } });
    const res = makeRes();
    redMetricsMiddleware(req, res, () => {});
    res.statusCode = 200;
    res.writableEnded = true;
    res.emit('finish');
    res.emit('close');

    const series = findSeries(RED_REQUESTS_TOTAL, (k) => k.includes('route=/api/once'));
    assert.equal(series.value, 1);
  });

  it('falls back to "unmatched" when no Express route matched', () => {
    const req = makeReq({ baseUrl: '', route: undefined });
    const res = makeRes();
    redMetricsMiddleware(req, res, () => {});
    res.statusCode = 404;
    res.writableEnded = true;
    res.emit('finish');

    const series = findSeries(RED_REQUESTS_TOTAL, (k) => k.includes('route=unmatched'));
    assert.ok(series);
  });

  it('excludes every shared metrics alias from RED instrumentation', () => {
    for (const path of ['/metrics', '/internal/metrics', '/api/se-agents/metrics']) {
      const req = makeReq({ path, originalUrl: path, route: { path } });
      const res = makeRes();
      let nextCalled = false;

      redMetricsMiddleware(req, res, () => { nextCalled = true; });
      assert.equal(nextCalled, true);
      assert.equal(res.listenerCount('finish'), 0, `${path} attached a finish listener`);
      assert.equal(res.listenerCount('close'), 0, `${path} attached a close listener`);
    }

    assert.equal(findSeries(RED_REQUESTS_TOTAL, () => true), null);
    assert.equal(findSeries(RED_DURATION, () => true), null);
  });
});
