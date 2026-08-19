'use strict';

const assert = require('node:assert/strict');
const { describe, test, beforeEach } = require('node:test');

const sloTracker = require('../src/services/slo-tracker');

beforeEach(() => {
  sloTracker.reset();
});

describe('slo-tracker — targets', () => {
  test('exposes the four canonical SLO targets', () => {
    const t = sloTracker.slos();
    assert.equal(t.latency_p995_under_500ms, 0.995);
    assert.equal(t.latency_p99_under_2s, 0.99);
    assert.equal(t.error_rate_max, 0.01);
    assert.equal(t.availability, 0.999);
  });
});

describe('slo-tracker — record + stats', () => {
  test('counts fast/acceptable/error correctly', () => {
    sloTracker.record({ route: '/api/x', statusCode: 200, durationMs: 100 });
    sloTracker.record({ route: '/api/x', statusCode: 200, durationMs: 1500 });
    sloTracker.record({ route: '/api/x', statusCode: 500, durationMs: 50 });
    const s = sloTracker.getEndpointStats('/api/x');
    assert.equal(s.total, 3);
    assert.equal(s.fast, 2);          // 100 + 50 ms
    assert.equal(s.acceptable, 3);     // all under 2s
    assert.equal(s.errors, 1);
    assert.equal(s.available, 2);
  });

  test('error_rate and availability ratios', () => {
    for (let i = 0; i < 99; i += 1) {
      sloTracker.record({ route: '/api/y', statusCode: 200, durationMs: 10 });
    }
    sloTracker.record({ route: '/api/y', statusCode: 500, durationMs: 10 });
    const s = sloTracker.getEndpointStats('/api/y');
    assert.equal(s.total, 100);
    assert.equal(s.errors, 1);
    assert.equal(s.error_rate.toFixed(2), '0.01');
    assert.equal(s.availability.toFixed(2), '0.99');
  });

  test('meets-target flags reflect SLO compliance', () => {
    // 1000 fast successes → meets all targets
    for (let i = 0; i < 1000; i += 1) {
      sloTracker.record({ route: '/api/z', statusCode: 200, durationMs: 50 });
    }
    const s = sloTracker.getEndpointStats('/api/z');
    assert.equal(s.meets.latency_p995, true);
    assert.equal(s.meets.latency_p99, true);
    assert.equal(s.meets.error_rate, true);
    assert.equal(s.meets.availability, true);
  });

  test('getEndpointStats() returns array when no route given', () => {
    sloTracker.record({ route: '/a', statusCode: 200, durationMs: 1 });
    sloTracker.record({ route: '/b', statusCode: 200, durationMs: 1 });
    const all = sloTracker.getEndpointStats();
    assert.ok(Array.isArray(all));
    assert.equal(all.length, 2);
  });

  test('unknown route returns null', () => {
    assert.equal(sloTracker.getEndpointStats('/never'), null);
  });
});

describe('slo-tracker — middleware', () => {
  test('records on response finish', async () => {
    const mw = sloTracker.middleware();
    const finishHandlers = [];
    const fakeReq = { path: '/api/foo', baseUrl: '', route: null };
    const fakeRes = {
      statusCode: 200,
      on(evt, fn) { if (evt === 'finish') finishHandlers.push(fn); },
    };
    let nextCalled = false;
    mw(fakeReq, fakeRes, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    // Trigger finish synchronously — duration will be ~0ms but still counted.
    finishHandlers.forEach((fn) => fn());
    const s = sloTracker.getEndpointStats('/api/foo');
    assert.equal(s.total, 1);
    assert.equal(s.errors, 0);
    assert.equal(s.fast, 1);
  });

  test('middleware never throws on bad req', () => {
    const mw = sloTracker.middleware();
    const finishHandlers = [];
    let nextCalled = false;
    mw(
      {}, // empty req
      { on(evt, fn) { if (evt === 'finish') finishHandlers.push(fn); }, statusCode: 500 },
      () => { nextCalled = true; },
    );
    assert.equal(nextCalled, true);
    // Should not throw.
    finishHandlers.forEach((fn) => fn());
  });
});
