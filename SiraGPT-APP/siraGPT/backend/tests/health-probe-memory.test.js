'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryProbe } = require('../src/health/probes/memory');

function fakeMemoryUsage({ rss, heapUsed = 1, heapTotal = 1, external = 0, arrayBuffers = 0 }) {
  return () => ({ rss, heapUsed, heapTotal, external, arrayBuffers });
}

test('exports createMemoryProbe', () => {
  assert.equal(typeof createMemoryProbe, 'function');
});

test('returns "pass" when RSS is below warnRssBytes', async () => {
  const probe = createMemoryProbe({
    memoryUsage: fakeMemoryUsage({ rss: 100 * 1024 * 1024 }), // 100 MiB
  });
  const result = await probe.run();
  assert.equal(result.status, 'pass');
});

test('returns "warn" when RSS crosses warnRssBytes but stays below failRssBytes', async () => {
  const probe = createMemoryProbe({
    memoryUsage: fakeMemoryUsage({ rss: 2 * 1024 * 1024 * 1024 }), // 2 GiB
  });
  const result = await probe.run();
  assert.equal(result.status, 'warn');
});

test('returns "fail" when RSS crosses failRssBytes', async () => {
  const probe = createMemoryProbe({
    memoryUsage: fakeMemoryUsage({ rss: 4 * 1024 * 1024 * 1024 }), // 4 GiB
  });
  const result = await probe.run();
  assert.equal(result.status, 'fail');
});

test('respects custom warnRssBytes + failRssBytes thresholds', async () => {
  const probe = createMemoryProbe({
    warnRssBytes: 100,
    failRssBytes: 200,
    memoryUsage: fakeMemoryUsage({ rss: 150 }),
  });
  const result = await probe.run();
  assert.equal(result.status, 'warn');
});

test('details include rss + heapUsed + heapTotal + external + arrayBuffers', async () => {
  const probe = createMemoryProbe({
    memoryUsage: fakeMemoryUsage({
      rss: 100, heapUsed: 50, heapTotal: 75, external: 10, arrayBuffers: 5,
    }),
  });
  const result = await probe.run();
  assert.equal(result.details.rss, 100);
  assert.equal(result.details.heapUsed, 50);
  assert.equal(result.details.heapTotal, 75);
  assert.equal(result.details.external, 10);
  assert.equal(result.details.arrayBuffers, 5);
});

test('details echo the configured warnRssBytes + failRssBytes', async () => {
  const probe = createMemoryProbe({
    warnRssBytes: 9999,
    failRssBytes: 99999,
    memoryUsage: fakeMemoryUsage({ rss: 0 }),
  });
  const result = await probe.run();
  assert.equal(result.details.warnRssBytes, 9999);
  assert.equal(result.details.failRssBytes, 99999);
});

test('probe.name defaults to "memory" and can be overridden', () => {
  const a = createMemoryProbe({ memoryUsage: fakeMemoryUsage({ rss: 0 }) });
  const b = createMemoryProbe({ name: 'mem-worker', memoryUsage: fakeMemoryUsage({ rss: 0 }) });
  assert.equal(a.name, 'memory');
  assert.equal(b.name, 'mem-worker');
});

test('default memoryUsage falls back to process.memoryUsage when none supplied', async () => {
  const probe = createMemoryProbe(); // uses real process.memoryUsage
  const result = await probe.run();
  // Whatever the runtime status, the details must be populated from real numbers.
  assert.equal(typeof result.details.rss, 'number');
  assert.ok(result.details.rss > 0);
  assert.equal(typeof result.details.heapTotal, 'number');
});

test('default thresholds: ~1.5 GiB warn, ~3 GiB fail', async () => {
  // 1 GiB → pass; 2 GiB → warn; 4 GiB → fail
  for (const [rss, expected] of [
    [1 * 1024 ** 3, 'pass'],
    [2 * 1024 ** 3, 'warn'],
    [4 * 1024 ** 3, 'fail'],
  ]) {
    const probe = createMemoryProbe({ memoryUsage: fakeMemoryUsage({ rss }) });
    const result = await probe.run();
    assert.equal(result.status, expected, `rss=${rss} expected ${expected}, got ${result.status}`);
  }
});
