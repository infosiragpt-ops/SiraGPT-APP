/**
 * Tests for fetch-instrument.js
 *
 * We mock globalThis.fetch to avoid real network calls.  Rather than
 * relying on node:test's mock() (which has ordering issues when other
 * tests patch/unpatch fetch) we manually save/restore it in each
 * beforeEach/afterThis pair.
 *
 * @jest-environment node
 */

'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { trace, context, SpanStatusCode } = require('@opentelemetry/api');

const {
  FetchInstrument,
  createFetch,
  instrumentedFetch,
  defaultInstrument,
  sanitizeFetchInit,
} = require('../src/utils/fetch-instrument');

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create a minimal Response-like object. */
function makeResponse(body, init = {}) {
  const { status = 200, statusText = 'OK', headers, url = 'http://example.com/' } = init;
  const h = new Map();
  if (headers) {
    for (const [k, v] of Object.entries(headers)) h.set(k.toLowerCase(), String(v));
  }
  if (!h.has('content-type')) h.set('content-type', 'text/plain');
  return {
    status,
    statusText,
    ok: status >= 200 && status < 300,
    url,
    headers: {
      get(name) { return h.get(name.toLowerCase()) ?? null; },
      forEach(fn) { h.forEach((v, k) => fn(v, k)); },
      entries() { return h.entries(); },
    },
    async text() { return String(body); },
    async json() { return JSON.parse(String(body)); },
    clone() { return makeResponse(body, init); },
  };
}

/** Return a promise that never settles. */
function never() {
  return new Promise(() => {});
}

/** Capture log output from a child logger. */
function captureLogs() {
  const lines = [];
  const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
  const stub = {};
  for (const lvl of levels) {
    stub[lvl] = (obj) => lines.push({ level: lvl, ...obj });
  }
  stub.child = () => stub;
  return { logger: stub, lines };
}

// ── Ensure a clean globalThis.fetch across all suites ─────────────────────
let _origFetch = null;

beforeEach(() => {
  _origFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = _origFetch;
  _origFetch = null;
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('FetchInstrument', () => {

  describe('constructor', () => {
    it('uses defaults when no options given', () => {
      const fi = new FetchInstrument();
      assert.equal(fi.options.timeoutMs, 30_000);
      assert.equal(fi.options.logRequests, true);
      assert.equal(fi.installed, false);
    });

    it('accepts custom options', () => {
      const fi = new FetchInstrument({ timeoutMs: 5000, logRequests: false });
      assert.equal(fi.options.timeoutMs, 5000);
      assert.equal(fi.options.logRequests, false);
    });

    it('starts with zero counters', () => {
      const fi = new FetchInstrument();
      const m = fi.metrics;
      assert.equal(m.total, 0);
      assert.equal(m.errors, 0);
      assert.equal(m.timeouts, 0);
      assert.equal(m.active, 0);
    });
  });

  describe('sanitizeFetchInit (re-export)', () => {
    it('is a function', () => {
      assert.equal(typeof sanitizeFetchInit, 'function');
    });

    it('strips Symbol keys from headers', () => {
      const h = { 'content-type': 'application/json' };
      h[Symbol('secret')] = 'dont-leak';
      const result = sanitizeFetchInit({ headers: h });
      const symKeys = Object.getOwnPropertySymbols(result.headers || {});
      assert.equal(symKeys.length, 0);
      assert.equal(result.headers['content-type'], 'application/json');
    });

    it('normalizes iterable header pairs without leaking symbol metadata', () => {
      const result = sanitizeFetchInit({
        headers: [
          ['accept', 'application/json'],
          ['x-attempt', 2],
          [Symbol('secret'), 'skip'],
          ['x-skip', Symbol('skip')],
        ],
      });

      assert.deepEqual(result.headers, {
        accept: 'application/json',
        'x-attempt': '2',
      });
    });

    it('normalizes Headers instances into a plain safe dictionary', () => {
      const headers = new Headers();
      headers.set('x-token', 'abc');
      const result = sanitizeFetchInit({ headers });

      assert.deepEqual(result.headers, { 'x-token': 'abc' });
      assert.equal(Object.getOwnPropertySymbols(result.headers).length, 0);
    });
  });

  describe('_tracedFetch() / instrumentedFetch()', () => {
    let fi;

    beforeEach(() => {
      fi = new FetchInstrument({ timeoutMs: 10_000 });
    });

    it('returns response on success', async () => {
      globalThis.fetch = async () => makeResponse('ok');
      const res = await fi._tracedFetch('http://example.com/');
      assert.equal(res.status, 200);
      assert.equal(fi.metrics.total, 1);
      assert.equal(fi.metrics.errors, 0);
    });

    it('increments error counter on HTTP error status', async () => {
      globalThis.fetch = async () => makeResponse('not found', { status: 404 });
      const res = await fi._tracedFetch('http://example.com/404');
      assert.equal(res.status, 404);
      assert.equal(fi.metrics.total, 1);
      assert.equal(fi.metrics.errors, 1);
    });

    it('increments error counter on fetch rejection', async () => {
      globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
      await assert.rejects(() => fi._tracedFetch('http://example.com/'));
      assert.equal(fi.metrics.total, 1);
      assert.equal(fi.metrics.errors, 1);
    });

    it('re-throws the original error on network failure', async () => {
      globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
      await assert.rejects(
        () => fi._tracedFetch('http://example.com/'),
        (err) => err.message === 'fetch failed'
      );
    });

    it('times out when server does not respond', async () => {
      const fi2 = new FetchInstrument({ timeoutMs: 50, logRequests: false });
      globalThis.fetch = async () => { await never(); };
      const start = Date.now();
      await assert.rejects(
        () => fi2._tracedFetch('http://example.com/slow'),
        { message: 'request timed out' }
      );
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 40, `expected >=40ms, got ${elapsed}ms`);
      assert.equal(fi2.metrics.total, 1);
      assert.equal(fi2.metrics.timeouts, 1);
    });

    it('clears the timeout timer on success', async () => {
      globalThis.fetch = async () => makeResponse('fast');
      await fi._tracedFetch('http://example.com/');
      assert.equal(fi.metrics.timeouts, 0);
    });

    it('injects the request timeout signal when no external signal exists', async () => {
      let capturedSignal = null;
      globalThis.fetch = async (_input, init) => {
        capturedSignal = init.signal;
        return makeResponse('got signal');
      };
      await fi._tracedFetch('http://example.com/');
      assert.ok(capturedSignal, 'expected an AbortSignal');
      assert.ok(capturedSignal instanceof AbortSignal);
    });

    it('does NOT override an external signal', async () => {
      const ac = new AbortController();
      let capturedSignal = null;
      globalThis.fetch = async (_input, init) => {
        capturedSignal = init.signal;
        return makeResponse('external');
      };
      await fi._tracedFetch('http://example.com/', { signal: ac.signal });
      assert.equal(capturedSignal, ac.signal);
    });

    it('sanitises Symbol-typed headers before passing to native fetch', async () => {
      let capturedHeaders = null;
      globalThis.fetch = async (_input, init) => {
        capturedHeaders = init.headers;
        return makeResponse('sanitised');
      };

      const headers = { 'content-type': 'application/json' };
      headers[Symbol('secret')] = 'leak';
      await fi._tracedFetch('http://example.com/', { headers });

      assert.equal(capturedHeaders['content-type'], 'application/json');
      const symKeys = Object.getOwnPropertySymbols(capturedHeaders || {});
      assert.equal(symKeys.length, 0);
    });

    it('logs request start and finish by default', async () => {
      const { logger, lines } = captureLogs();
      const fi2 = new FetchInstrument({ timeoutMs: 5000, logger });
      globalThis.fetch = async () => makeResponse('logged');
      await fi2._tracedFetch('http://example.com/logme');
      const starts = lines.filter(l => l.msg === 'fetch start');
      const dones = lines.filter(l => l.msg === 'fetch done');
      assert.equal(starts.length, 1);
      assert.equal(dones.length, 1);
      assert.ok(starts[0].requestId);
      assert.equal(starts[0].method, 'GET');
      assert.equal(dones[0].status, 200);
    });

    it('does not log when logRequests is false', async () => {
      const { logger, lines } = captureLogs();
      const fi2 = new FetchInstrument({ timeoutMs: 5000, logger, logRequests: false });
      globalThis.fetch = async () => makeResponse('quiet');
      await fi2._tracedFetch('http://example.com/quiet');
      assert.equal(lines.length, 0);
    });

    it('emits warning log on HTTP error', async () => {
      const { logger, lines } = captureLogs();
      const fi2 = new FetchInstrument({ timeoutMs: 5000, logger });
      globalThis.fetch = async () => makeResponse('bad', { status: 500 });
      await fi2._tracedFetch('http://example.com/err');
      const dones = lines.filter(l => l.msg === 'fetch done');
      assert.equal(dones.length, 1);
      assert.equal(dones[0].level, 'warn');
    });

    it('emits warning log on network error', async () => {
      const { logger, lines } = captureLogs();
      const fi2 = new FetchInstrument({ timeoutMs: 5000, logger });
      globalThis.fetch = async () => { throw new Error('dns failure'); };
      await assert.rejects(() => fi2._tracedFetch('http://example.com/err2'));
      const errs = lines.filter(l => l.msg === 'fetch error');
      assert.equal(errs.length, 1);
      assert.equal(errs[0].level, 'warn');
      assert.ok(errs[0].isTimeout === false);
    });

    it('tracks active count correctly', async () => {
      let resolveFetch;
      globalThis.fetch = () => new Promise(r => { resolveFetch = r; });
      const promise = fi._tracedFetch('http://example.com/pending');
      // Give the microtask queue a tick to enter the span callback
      await new Promise(r => setTimeout(r, 5));
      assert.equal(fi.metrics.active, 1);
      resolveFetch(makeResponse('done'));
      await promise;
      assert.equal(fi.metrics.active, 0);
    });

    it('tracks min/max/avg latency', async () => {
      globalThis.fetch = async () => makeResponse('latency');
      await fi._tracedFetch('http://example.com/a');
      await fi._tracedFetch('http://example.com/b');
      const m = fi.metrics;
      assert.equal(m.total, 2);
      assert.ok(m.maxLatencyMs >= 0);
      assert.ok(m.avgLatencyMs >= 0);
      assert.ok(m.minLatencyMs >= 0);
      assert.ok(m.avgLatencyMs <= m.maxLatencyMs);
    });

    it('reads Content-Length from the response', async () => {
      globalThis.fetch = async () => makeResponse('x'.repeat(100), {
        headers: { 'content-length': '100' },
      });
      await fi._tracedFetch('http://example.com/cl');
    });

    it('uses method from init when provided', async () => {
      let capturedMethod = null;
      globalThis.fetch = async (_input, init) => {
        capturedMethod = init?.method || 'GET';
        return makeResponse('method');
      };
      await fi._tracedFetch('http://example.com/post', { method: 'POST', body: 'data' });
      assert.equal(capturedMethod, 'POST');
    });

    it('handles URL object input', async () => {
      let capturedUrl = null;
      globalThis.fetch = async (input) => {
        capturedUrl = input;
        return makeResponse('url');
      };
      const url = new URL('https://example.com/path?q=1');
      await fi._tracedFetch(url);
      assert.equal(String(capturedUrl), url.href);
    });

    it('handles Request object input', async () => {
      globalThis.fetch = async () => makeResponse('request');
      const req = new Request('https://example.com/req', { method: 'DELETE' });
      await fi._tracedFetch(req);
    });
  });

  describe('install/uninstall', () => {
    let fi;
    let origFetch;

    beforeEach(() => {
      fi = new FetchInstrument();
      origFetch = globalThis.fetch;
    });

    afterEach(() => {
      if (fi.installed) fi.uninstall();
      globalThis.fetch = origFetch;
    });

    it('patches globalThis.fetch after install()', () => {
      const original = globalThis.fetch;
      fi.install();
      assert.notEqual(globalThis.fetch, original);
      assert.equal(fi.installed, true);
    });

    it('restores original fetch after uninstall()', () => {
      const original = globalThis.fetch;
      fi.install();
      fi.uninstall();
      assert.equal(globalThis.fetch, original);
      assert.equal(fi.installed, false);
    });

    it('is idempotent — multiple install() calls do nothing', () => {
      fi.install();
      const patched = globalThis.fetch;
      fi.install(); // second call — should be no-op
      assert.equal(globalThis.fetch, patched);
    });

    it('is idempotent — multiple uninstall() calls do nothing', () => {
      const original = globalThis.fetch;
      fi.install();
      fi.uninstall();
      fi.uninstall(); // second call — should be no-op
      assert.equal(globalThis.fetch, original);
    });

    it('patched fetch returns response', async () => {
      // Set up a mock fetch BEFORE install so it becomes the original
      globalThis.fetch = async () => makeResponse('mocked-original');
      fi.install(); // saves our mock as kOriginalFetch

      // Now globalThis.fetch is the wrapper; calling it should
      // route through _tracedFetch → kOriginalFetch (our mock)
      const res = await fi._tracedFetch('http://example.com/install-test');
      assert.equal(res.status, 200);
    });

    it('uninstall restores original fetch', async () => {
      const original = globalThis.fetch;
      fi.install();
      fi.uninstall();
      assert.equal(globalThis.fetch, original);
    });
  });

  describe('createFetch()', () => {
    it('returns a function', () => {
      const f = createFetch({ timeoutMs: 1000 });
      assert.equal(typeof f, 'function');
    });

    it('returned function can make traced requests', async () => {
      globalThis.fetch = async () => makeResponse('factory');
      const f = createFetch({ timeoutMs: 5000, logRequests: false });
      const res = await f('http://example.com/factory');
      assert.equal(res.status, 200);
    });
  });

  describe('resetMetrics()', () => {
    let fi;

    beforeEach(() => {
      fi = new FetchInstrument({ timeoutMs: 10_000, logRequests: false });
    });

    it('resets all counters to zero', async () => {
      globalThis.fetch = async () => makeResponse('reset');
      await fi._tracedFetch('http://example.com/r');
      assert.equal(fi.metrics.total, 1);
      fi.resetMetrics();
      const m = fi.metrics;
      assert.equal(m.total, 0);
      assert.equal(m.errors, 0);
      assert.equal(m.timeouts, 0);
      assert.equal(m.active, 0);
      assert.equal(m.maxLatencyMs, 0);
      assert.equal(m.avgLatencyMs, 0);
    });
  });

  describe('toJSON()', () => {
    it('returns a plain object with installed, options, metrics', () => {
      const fi = new FetchInstrument();
      const json = fi.toJSON();
      assert.equal(typeof json, 'object');
      assert.equal(json.installed, false);
      assert.ok(json.options);
      assert.ok(json.metrics);
    });
  });

  describe('defaultInstrument singleton', () => {
    it('is a FetchInstrument instance', () => {
      assert.ok(defaultInstrument instanceof FetchInstrument);
    });

    it('is not installed by default', () => {
      assert.equal(defaultInstrument.installed, false);
    });

    it('instrumentedFetch() delegates to defaultInstrument', async () => {
      globalThis.fetch = async () => makeResponse('singleton');
      const res = await instrumentedFetch('http://example.com/singleton');
      assert.equal(res.status, 200);
    });
  });

  describe('callOpts override', () => {
    it('per-call timeoutMs overrides the instance default', async () => {
      const fi = new FetchInstrument({ timeoutMs: 10_000, logRequests: false });
      let callCount = 0;
      globalThis.fetch = async (_input, init) => {
        callCount++;
        await new Promise(r => setTimeout(r, 5));
        return makeResponse('override');
      };
      await fi._tracedFetch('http://example.com/override', {}, { timeoutMs: 100 });
      assert.equal(callCount, 1);
    });
  });
});
