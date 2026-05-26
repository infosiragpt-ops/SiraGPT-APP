/**
 * Tests for the synthetic ping probe + sampler.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  createSyntheticPingProbe,
  SyntheticPingSampler,
} = require('../src/health/probes/synthetic-ping');

function fakeResponse({ status = 200, body = { usage: { total_tokens: 2 } } } = {}) {
  return {
    status,
    json: async () => body,
  };
}

function makeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler({ url, init });
  };
  fn.calls = calls;
  return fn;
}

describe('createSyntheticPingProbe', () => {
  it('issues a POST chat completion request with bearer auth', async () => {
    const fetchImpl = makeFetch(() => fakeResponse({ status: 200 }));
    const probe = createSyntheticPingProbe({
      apiKey: 'sk-test',
      baseUrl: 'https://example.test/v1',
      model: 'mini-test',
      ttlMs: 0,
      fetchImpl,
    });

    const r = await probe.run();
    assert.equal(r.status, 'pass');
    assert.equal(fetchImpl.calls.length, 1);

    const { url, init } = fetchImpl.calls[0];
    assert.equal(url, 'https://example.test/v1/chat/completions');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.authorization, 'Bearer sk-test');
    assert.equal(init.headers['content-type'], 'application/json');

    const body = JSON.parse(init.body);
    assert.equal(body.model, 'mini-test');
    assert.equal(body.max_tokens, 1);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'ping' }]);

    assert.equal(r.details.model, 'mini-test');
    assert.equal(r.details.httpStatus, 200);
    assert.equal(r.details.tokens, 2);
    assert.ok(Number.isFinite(r.details.driverElapsedMs));
  });

  it('returns warn (not fail) when apiKey missing', async () => {
    const fetchImpl = makeFetch(() => fakeResponse());
    const probe = createSyntheticPingProbe({
      apiKey: undefined,
      ttlMs: 0,
      fetchImpl,
    });
    const r = await probe.run();
    assert.equal(r.status, 'warn');
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(r.details.skipped, true);
  });

  it('classifies 401 as warn (reachable but unauthorized)', async () => {
    const fetchImpl = makeFetch(() => fakeResponse({ status: 401, body: {} }));
    const probe = createSyntheticPingProbe({ apiKey: 'sk', ttlMs: 0, fetchImpl });
    const r = await probe.run();
    assert.equal(r.status, 'warn');
    assert.equal(r.details.httpStatus, 401);
  });

  it('classifies 429 and 5xx as fail', async () => {
    for (const status of [429, 500, 502, 503]) {
      const fetchImpl = makeFetch(() => fakeResponse({ status, body: {} }));
      const probe = createSyntheticPingProbe({ apiKey: 'sk', ttlMs: 0, fetchImpl });
      const r = await probe.run();
      assert.equal(r.status, 'fail', `expected fail for ${status}`);
      assert.equal(r.details.httpStatus, status);
    }
  });

  it('records latency in history', async () => {
    let n = 0;
    const fetchImpl = makeFetch(async () => {
      n += 1;
      // Simulate variable latency.
      await new Promise((r) => setTimeout(r, n * 5));
      return fakeResponse({ status: 200 });
    });
    const probe = createSyntheticPingProbe({ apiKey: 'sk', ttlMs: 0, fetchImpl });
    await probe.run();
    await probe.run();
    await probe.run();
    const hist = probe.getHistory();
    assert.equal(hist.length, 3);
    for (const e of hist) {
      assert.equal(e.status, 'pass');
      assert.ok(e.elapsedMs >= 0);
    }
  });
});

describe('SyntheticPingSampler', () => {
  it('rejects bad construction', () => {
    assert.throws(() => new SyntheticPingSampler({}), /probe/);
    assert.throws(
      () => new SyntheticPingSampler({ probe: { run: () => {} }, intervalMs: 100 }),
      /intervalMs/,
    );
  });

  it('drives the probe on its interval and exposes latency stats', async () => {
    const fetchImpl = makeFetch(() => fakeResponse({ status: 200 }));
    const probe = createSyntheticPingProbe({ apiKey: 'sk', ttlMs: 0, fetchImpl });

    // Mock setInterval/clearInterval so we can drive ticks deterministically.
    let registered = null;
    const fakeSet = (fn, _ms) => { registered = { fn }; return registered; };
    const fakeClear = (h) => { if (registered === h) registered = null; };

    const sampler = new SyntheticPingSampler({
      probe,
      intervalMs: 60_000,
      setIntervalImpl: fakeSet,
      clearIntervalImpl: fakeClear,
    });
    assert.equal(sampler.running, false);

    sampler.start();
    assert.equal(sampler.running, true);
    assert.ok(registered, 'expected interval to register');

    // Drive 3 synthetic ticks.
    await registered.fn();
    await registered.fn();
    await registered.fn();

    assert.equal(sampler.sampleCount, 3);
    assert.equal(fetchImpl.calls.length, 3);

    const stats = sampler.getLatencyStats();
    assert.equal(stats.name, 'synthetic-ping');
    assert.equal(stats.samples, 3);
    assert.equal(stats.byStatus.pass, 3);
    assert.ok(stats.lastTimestamp);
    assert.ok(stats.p50 != null);
    assert.ok(stats.p95 != null);
    assert.ok(stats.p99 != null);
    assert.ok(stats.minMs != null);
    assert.ok(stats.maxMs != null);
    assert.ok(stats.avgMs != null);

    sampler.stop();
    assert.equal(sampler.running, false);
    assert.equal(registered, null);
  });

  it('sampleOnce dedupes concurrent ticks', async () => {
    let inflight = 0;
    let maxConcurrent = 0;
    const fetchImpl = makeFetch(async () => {
      inflight += 1;
      maxConcurrent = Math.max(maxConcurrent, inflight);
      await new Promise((r) => setTimeout(r, 20));
      inflight -= 1;
      return fakeResponse({ status: 200 });
    });
    const probe = createSyntheticPingProbe({ apiKey: 'sk', ttlMs: 0, fetchImpl });
    const sampler = new SyntheticPingSampler({ probe, intervalMs: 60_000 });

    const [a, b, c] = await Promise.all([
      sampler.sampleOnce(),
      sampler.sampleOnce(),
      sampler.sampleOnce(),
    ]);
    assert.ok(a && b && c);
    assert.equal(maxConcurrent, 1, 'sampler must serialize concurrent ticks');
    // sampleCount is incremented once per shared inflight resolve.
    assert.ok(sampler.sampleCount >= 1);
  });

  it('runImmediately fires a sample at start()', async () => {
    const fetchImpl = makeFetch(() => fakeResponse({ status: 200 }));
    const probe = createSyntheticPingProbe({ apiKey: 'sk', ttlMs: 0, fetchImpl });
    const fakeSet = () => ({});
    const fakeClear = () => {};
    const sampler = new SyntheticPingSampler({
      probe,
      intervalMs: 60_000,
      setIntervalImpl: fakeSet,
      clearIntervalImpl: fakeClear,
    });
    sampler.start({ runImmediately: true });
    // Allow the inflight tick to settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(fetchImpl.calls.length, 1);
    sampler.stop();
  });

  it('onError is invoked when probe.run rejects', async () => {
    const errors = [];
    const probe = {
      name: 'np',
      run: async () => { throw new Error('boom'); },
      getHistory: () => [],
    };
    const fakeSet = () => ({});
    const fakeClear = () => {};
    const sampler = new SyntheticPingSampler({
      probe,
      intervalMs: 60_000,
      setIntervalImpl: fakeSet,
      clearIntervalImpl: fakeClear,
      onError: (e) => errors.push(e.message),
    });
    await sampler.sampleOnce();
    assert.deepEqual(errors, ['boom']);
  });
});
