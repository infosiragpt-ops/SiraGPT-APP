/**
 * Tests for the SiraGPT health snapshot CLI helper.
 *
 * Exercises runHealthSnapshot / exitCodeFor / formatText against a mock fetch
 * so no real backend is required. Mirrors the report shape produced by
 * backend/src/services/observability/health-check.js.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  runHealthSnapshot,
  exitCodeFor,
  formatText,
  parseArgs,
} = require('../scripts/health-snapshot');

function jsonResponse(status, body) {
  return { status, json: async () => body };
}

/**
 * Build a fetch mock that resolves per-path responses. `routes` maps a path
 * suffix (e.g. '/health/live') to either a response object or an Error to throw.
 */
function makeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const path = new URL(url).pathname;
    const match = routes[path];
    if (match instanceof Error) throw match;
    if (!match) throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    return match;
  };
  fn.calls = calls;
  return fn;
}

const liveHealthy = () => jsonResponse(200, { status: 'healthy', checks: [{ name: 'process', status: 'healthy', critical: false }] });

describe('runHealthSnapshot', () => {
  it('reports healthy when liveness and composite are both healthy', async () => {
    const fetchImpl = makeFetch({
      '/health/live': liveHealthy(),
      '/health': jsonResponse(200, {
        status: 'healthy',
        checks: [
          { name: 'database', status: 'healthy', critical: true, latency_ms: 3 },
          { name: 'redis', status: 'healthy', critical: true, latency_ms: 1 },
        ],
      }),
    });
    const report = await runHealthSnapshot({ baseUrl: 'http://backend.test', fetchImpl });
    assert.equal(report.status, 'healthy');
    assert.equal(report.reachable, true);
    assert.equal(report.checks.length, 2);
    assert.equal(report.hint, null);
    assert.equal(exitCodeFor(report), 0);
  });

  it('strips trailing slashes from the base URL before probing', async () => {
    const fetchImpl = makeFetch({ '/health/live': liveHealthy(), '/health': jsonResponse(200, { status: 'healthy', checks: [] }) });
    await runHealthSnapshot({ baseUrl: 'http://backend.test///', fetchImpl });
    assert.deepEqual(fetchImpl.calls.sort(), [
      'http://backend.test/health',
      'http://backend.test/health/live',
    ]);
  });

  it('surfaces a warm-up hint when live is up but a critical check is unhealthy', async () => {
    const fetchImpl = makeFetch({
      '/health/live': liveHealthy(),
      '/health': jsonResponse(503, {
        status: 'unhealthy',
        checks: [{ name: 'database', status: 'unhealthy', critical: true, latency_ms: 2000 }],
      }),
    });
    const report = await runHealthSnapshot({ baseUrl: 'http://backend.test', fetchImpl });
    assert.equal(report.status, 'unhealthy');
    assert.equal(report.live.ok, true);
    assert.match(report.hint, /warm-up window/i);
    assert.equal(exitCodeFor(report), 1);
  });

  it('reports degraded and exits 0 unless --strict', async () => {
    const fetchImpl = makeFetch({
      '/health/live': liveHealthy(),
      '/health': jsonResponse(200, { status: 'degraded', checks: [{ name: 'queue', status: 'degraded', critical: false }] }),
    });
    const report = await runHealthSnapshot({ baseUrl: 'http://backend.test', fetchImpl });
    assert.equal(report.status, 'degraded');
    assert.equal(exitCodeFor(report), 0);
    assert.equal(exitCodeFor(report, { strict: true }), 1);
  });

  it('reports unreachable and exit code 2 when nothing answers', async () => {
    const fetchImpl = makeFetch({});
    const report = await runHealthSnapshot({ baseUrl: 'http://backend.test', fetchImpl });
    assert.equal(report.status, 'unreachable');
    assert.equal(report.reachable, false);
    assert.equal(exitCodeFor(report), 2);
    assert.match(report.hint, /No response/i);
  });

  it('fails hard (unhealthy, exit 1) when liveness answers but /health is unreachable', async () => {
    const fetchImpl = makeFetch({ '/health/live': liveHealthy() });
    const report = await runHealthSnapshot({ baseUrl: 'http://backend.test', fetchImpl });
    assert.equal(report.status, 'unhealthy');
    assert.equal(report.full.ok, false);
    assert.equal(exitCodeFor(report), 1);
    assert.match(report.hint, /did not return a report/i);
  });

  it('fails hard when /health times out (aborts) even though liveness is up', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchImpl = makeFetch({ '/health/live': liveHealthy(), '/health': abort });
    const report = await runHealthSnapshot({ baseUrl: 'http://backend.test', timeoutMs: 1234, fetchImpl });
    assert.equal(report.status, 'unhealthy');
    assert.equal(report.full.ok, false);
    assert.match(report.full.error, /timeout after 1234ms/);
    assert.equal(exitCodeFor(report), 1);
    assert.equal(report.hint && /warm-up/i.test(report.hint), false);
  });

  it('treats an HTTP 5xx with invalid JSON as unknown (exit 1), not a false green', async () => {
    const badJson = { status: 500, json: async () => { throw new Error('not json'); } };
    const fetchImpl = makeFetch({ '/health/live': liveHealthy(), '/health': badJson });
    const report = await runHealthSnapshot({ baseUrl: 'http://backend.test', fetchImpl });
    assert.equal(report.full.ok, true);
    assert.equal(report.full.httpStatus, 500);
    assert.equal(report.status, 'unknown');
    assert.equal(exitCodeFor(report), 1);
  });
});

describe('formatText', () => {
  it('renders status, target and checks; details only when verbose', async () => {
    const fetchImpl = makeFetch({
      '/health/live': liveHealthy(),
      '/health': jsonResponse(200, {
        status: 'healthy',
        checks: [{ name: 'database', status: 'healthy', critical: true, latency_ms: 5, details: { pool: 4 } }],
      }),
    });
    const report = await runHealthSnapshot({ baseUrl: 'http://backend.test', fetchImpl });
    const plain = formatText(report);
    assert.match(plain, /Status: HEALTHY/);
    assert.match(plain, /Target: http:\/\/backend\.test/);
    assert.match(plain, /database \(critical\)/);
    assert.doesNotMatch(plain, /"pool"/);
    assert.match(formatText(report, { verbose: true }), /"pool":4/);
  });
});

describe('parseArgs', () => {
  it('parses flags and rejects unknown args / bad timeouts', () => {
    const args = parseArgs(['--url', 'http://x.test', '--json', '--strict', '--timeout', '2500', '--verbose']);
    assert.equal(args.baseUrl, 'http://x.test');
    assert.equal(args.json, true);
    assert.equal(args.strict, true);
    assert.equal(args.verbose, true);
    assert.equal(args.timeoutMs, 2500);
    assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
    assert.throws(() => parseArgs(['--timeout', '0']), /positive number/);
  });
});
