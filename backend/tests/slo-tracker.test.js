'use strict';

const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { describe, test, beforeEach } = require('node:test');

const utilityMetrics = require('../src/utils/metrics');
const sloTracker = require('../src/services/slo-tracker');

beforeEach(() => {
  sloTracker.reset();
  for (const [name, family] of utilityMetrics.registry) {
    if (name.startsWith('siragpt_slo_')) family.series.clear();
  }
});

describe('slo-tracker — targets', () => {
  test('exposes the four canonical SLO targets', () => {
    const t = sloTracker.slos();
    assert.equal(t.latency_p995_under_500ms, 0.995);
    assert.equal(t.latency_p99_under_2s, 0.99);
    assert.equal(t.error_rate_max, 0.01);
    assert.equal(t.availability, 0.999);
  });

  test('route-state limit has a bounded configurable default', () => {
    assert.equal(typeof sloTracker.resolveRouteStateLimit, 'function');
    assert.equal(sloTracker.resolveRouteStateLimit(undefined), 128);
    assert.equal(
      sloTracker.SLO_ROUTE_STATE_LIMIT,
      sloTracker.resolveRouteStateLimit(process.env.SIRAGPT_SLO_MAX_ROUTE_STATES),
    );
    assert.equal(sloTracker.resolveRouteStateLimit('invalid'), 128);
    assert.equal(sloTracker.resolveRouteStateLimit(64), 64);
    assert.equal(sloTracker.resolveRouteStateLimit(-50), 1);
    assert.equal(sloTracker.resolveRouteStateLimit(50_000), 2_000);
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

  test('hundreds of opaque project IDs fold state and Prometheus series into __other__', () => {
    const mw = sloTracker.middleware();
    const requestCount = sloTracker.SLO_ROUTE_STATE_LIMIT + 272;

    for (let i = 0; i < requestCount; i += 1) {
      const finishHandlers = [];
      const projectId = `project-${randomBytes(12).toString('base64url')}`;
      mw(
        {
          baseUrl: `/api/projects/${projectId}`,
          route: { path: '/runs/:runId' },
        },
        {
          statusCode: 200,
          on(event, handler) {
            if (event === 'finish') finishHandlers.push(handler);
          },
        },
        () => {},
      );
      finishHandlers.forEach((handler) => handler());
    }

    const stats = sloTracker.getEndpointStats();
    assert.equal(stats.length, sloTracker.SLO_ROUTE_STATE_LIMIT);
    const overflow = sloTracker.getEndpointStats('__other__');
    assert.ok(overflow);
    assert.equal(
      overflow.total,
      requestCount - (sloTracker.SLO_ROUTE_STATE_LIMIT - 1),
    );

    const totalFamily = utilityMetrics.registry.get('siragpt_slo_requests_total');
    const gaugeFamily = utilityMetrics.registry.get('siragpt_slo_endpoint_meets_target');
    assert.ok(totalFamily.series.size <= sloTracker.SLO_ROUTE_STATE_LIMIT);
    assert.ok(gaugeFamily.series.size <= sloTracker.SLO_ROUTE_STATE_LIMIT * 4);
    assert.equal(totalFamily.series.get('route=__other__'), overflow.total);

    const exposition = utilityMetrics.renderText();
    const totalSamples = exposition.match(/^siragpt_slo_requests_total\{/gm) || [];
    const gaugeSamples = exposition.match(/^siragpt_slo_endpoint_meets_target\{/gm) || [];
    assert.ok(totalSamples.length <= sloTracker.SLO_ROUTE_STATE_LIMIT);
    assert.ok(gaugeSamples.length <= sloTracker.SLO_ROUTE_STATE_LIMIT * 4);
    assert.match(exposition, /^siragpt_slo_requests_total\{route="__other__"\} \d+$/m);
  });
});

describe('slo-tracker — middleware', () => {
  test('uses literal unmatched instead of raw req.path when no route matched', async () => {
    const mw = sloTracker.middleware();
    const finishHandlers = [];
    const fakeReq = { path: '/api/users/user-123', baseUrl: '', route: null };
    const fakeRes = {
      statusCode: 200,
      on(evt, fn) { if (evt === 'finish') finishHandlers.push(fn); },
    };
    let nextCalled = false;
    mw(fakeReq, fakeRes, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    // Trigger finish synchronously — duration will be ~0ms but still counted.
    finishHandlers.forEach((fn) => fn());
    const s = sloTracker.getEndpointStats('unmatched');
    assert.equal(s.total, 1);
    assert.equal(s.errors, 0);
    assert.equal(s.fast, 1);
    assert.equal(sloTracker.getEndpointStats('/api/users/user-123'), null);
  });

  test('uses the matched Express route template when available', () => {
    const mw = sloTracker.middleware();
    const finishHandlers = [];
    const fakeReq = { path: '/api/users/user-123', baseUrl: '/api/users', route: { path: '/:id' } };
    const fakeRes = {
      statusCode: 200,
      on(evt, fn) { if (evt === 'finish') finishHandlers.push(fn); },
    };

    mw(fakeReq, fakeRes, () => {});
    finishHandlers.forEach((fn) => fn());
    assert.equal(sloTracker.getEndpointStats('/api/users/:id').total, 1);
    assert.equal(sloTracker.getEndpointStats('/api/users/user-123'), null);
  });

  test('hundreds of UUID project mounts collapse to one matched route label', () => {
    const mw = sloTracker.middleware();
    const requestCount = 300;

    for (let i = 0; i < requestCount; i += 1) {
      const finishHandlers = [];
      mw(
        {
          baseUrl: `/api/projects/${randomUUID()}`,
          route: { path: '/runs/:runId' },
        },
        {
          statusCode: 200,
          on(event, handler) {
            if (event === 'finish') finishHandlers.push(handler);
          },
        },
        () => {},
      );
      finishHandlers.forEach((handler) => handler());
    }

    const stats = sloTracker.getEndpointStats();
    assert.equal(stats.length, 1);
    assert.equal(
      stats[0].route,
      sloTracker.SLO_ROUTE_STATE_LIMIT === 1
        ? sloTracker.SLO_OVERFLOW_ROUTE
        : '/api/projects/:id/runs/:runId',
    );
    assert.equal(stats[0].total, requestCount);

    const totalFamily = utilityMetrics.registry.get('siragpt_slo_requests_total');
    const gaugeFamily = utilityMetrics.registry.get('siragpt_slo_endpoint_meets_target');
    assert.equal(totalFamily.series.size, 1);
    assert.equal(gaugeFamily.series.size, 4);
  });

  test('does not instrument any metrics alias, including query and trailing slash forms', () => {
    const mw = sloTracker.middleware();
    for (const url of [
      '/metrics?source=prometheus',
      '/internal/metrics/',
      '/api/se-agents/metrics/?source=prometheus',
    ]) {
      const finishHandlers = [];
      let nextCalled = false;
      mw(
        { url },
        {
          statusCode: 200,
          on(evt, fn) { if (evt === 'finish') finishHandlers.push(fn); },
        },
        () => { nextCalled = true; },
      );
      assert.equal(nextCalled, true);
      assert.equal(finishHandlers.length, 0, `${url} attached a finish listener`);
    }
    assert.deepEqual(sloTracker.getEndpointStats(), []);
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
