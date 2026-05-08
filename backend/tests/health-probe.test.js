/**
 * Tests for the health-probe module.
 *
 * @jest-environment node
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  Probe,
  HealthRegistry,
  aggregate,
  STATUS,
  CATEGORY,
  OVERALL,
  createDbProbe,
  createRedisProbe,
  createDiskProbe,
  createMemoryProbe,
  createOpenAIProbe,
} = require('../src/health');

const delay = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

// ── Probe core ─────────────────────────────────────────────────────────────

describe('Probe', () => {
  it('rejects invalid construction', () => {
    assert.throws(() => new Probe({}), /name/);
    assert.throws(() => new Probe({ name: 'x' }), /check/);
    assert.throws(() => new Probe({ name: 'x', check: () => {}, category: 'nope' }), /category/);
    assert.throws(() => new Probe({ name: 'x', check: () => {}, timeoutMs: 0 }), /timeoutMs/);
    assert.throws(() => new Probe({ name: 'x', check: () => {}, ttlMs: -1 }), /ttlMs/);
  });

  it('passes when check returns success', async () => {
    const p = new Probe({ name: 'ok', check: async () => 'fine', ttlMs: 0 });
    const r = await p.run();
    assert.equal(r.status, STATUS.PASS);
    assert.equal(r.name, 'ok');
    assert.equal(r.category, CATEGORY.CRITICAL);
    assert.equal(r.details, 'fine');
    assert.equal(r.cached, false);
    assert.ok(r.elapsedMs >= 0);
  });

  it('honors structured return value', async () => {
    const p = new Probe({
      name: 'x',
      ttlMs: 0,
      check: async () => ({ status: 'warn', details: { lag: 42 }, message: 'slow' }),
    });
    const r = await p.run();
    assert.equal(r.status, STATUS.WARN);
    assert.equal(r.message, 'slow');
    assert.deepEqual(r.details, { lag: 42 });
  });

  it('captures thrown errors as fail', async () => {
    const p = new Probe({
      name: 'boom',
      ttlMs: 0,
      check: async () => { const e = new Error('nope'); e.code = 'EBOOM'; throw e; },
    });
    const r = await p.run();
    assert.equal(r.status, STATUS.FAIL);
    assert.equal(r.error, 'nope');
    assert.equal(r.code, 'EBOOM');
  });

  it('marks slow probes as timeout', async () => {
    const p = new Probe({
      name: 'slow',
      timeoutMs: 30,
      ttlMs: 0,
      check: () => delay(500, 'too late'),
    });
    const r = await p.run();
    assert.equal(r.status, STATUS.TIMEOUT);
    assert.match(r.error, /timed out/);
    assert.ok(r.elapsedMs >= 30);
  });

  it('caches results within TTL and returns cached:true', async () => {
    let calls = 0;
    const p = new Probe({
      name: 'cached',
      ttlMs: 1000,
      check: async () => { calls += 1; return 'v' + calls; },
    });
    const a = await p.run();
    const b = await p.run();
    assert.equal(calls, 1);
    assert.equal(a.cached, false);
    assert.equal(b.cached, true);
    assert.equal(b.details, 'v1');
  });

  it('bypasses cache when requested', async () => {
    let calls = 0;
    const p = new Probe({ name: 'bp', ttlMs: 60_000, check: async () => { calls += 1; return calls; } });
    await p.run();
    await p.run({ bypassCache: true });
    assert.equal(calls, 2);
  });

  it('invalidate() drops the cached value', async () => {
    let calls = 0;
    const p = new Probe({ name: 'inv', ttlMs: 60_000, check: async () => { calls += 1; return calls; } });
    await p.run();
    p.invalidate();
    await p.run();
    assert.equal(calls, 2);
  });

  it('de-duplicates concurrent runs', async () => {
    let calls = 0;
    const p = new Probe({
      name: 'dedup',
      ttlMs: 0,
      check: async () => { calls += 1; await delay(20); return calls; },
    });
    const [a, b, c] = await Promise.all([p.run(), p.run(), p.run()]);
    assert.equal(calls, 1);
    assert.deepEqual([a.details, b.details, c.details], [1, 1, 1]);
  });
});

// ── Aggregation ────────────────────────────────────────────────────────────

describe('aggregate()', () => {
  it('returns ok when all pass', () => {
    const r = aggregate([
      { status: STATUS.PASS, category: CATEGORY.CRITICAL },
      { status: STATUS.PASS, category: CATEGORY.DEGRADED },
    ]);
    assert.equal(r, OVERALL.OK);
  });

  it('returns degraded on degraded failure or warn', () => {
    assert.equal(
      aggregate([{ status: STATUS.FAIL, category: CATEGORY.DEGRADED }]),
      OVERALL.DEGRADED
    );
    assert.equal(
      aggregate([{ status: STATUS.WARN, category: CATEGORY.CRITICAL }]),
      OVERALL.DEGRADED
    );
  });

  it('returns down on any critical failure or timeout', () => {
    assert.equal(
      aggregate([
        { status: STATUS.PASS, category: CATEGORY.DEGRADED },
        { status: STATUS.TIMEOUT, category: CATEGORY.CRITICAL },
      ]),
      OVERALL.DOWN
    );
  });
});

// ── HealthRegistry ─────────────────────────────────────────────────────────

describe('HealthRegistry', () => {
  it('registers, lists and removes probes', () => {
    const reg = new HealthRegistry();
    reg.add({ name: 'a', check: async () => 1 });
    reg.add(new Probe({ name: 'b', check: async () => 2 }));
    assert.equal(reg.list().length, 2);
    assert.ok(reg.get('a') instanceof Probe);
    assert.equal(reg.remove('a'), true);
    assert.equal(reg.list().length, 1);
  });

  it('rejects duplicate names', () => {
    const reg = new HealthRegistry();
    reg.add({ name: 'dup', check: async () => 1 });
    assert.throws(() => reg.add({ name: 'dup', check: async () => 1 }), /already registered/);
  });

  it('runAll aggregates results to ok', async () => {
    const reg = new HealthRegistry();
    reg.add({ name: 'a', ttlMs: 0, check: async () => 1 });
    reg.add({ name: 'b', ttlMs: 0, category: CATEGORY.DEGRADED, check: async () => 2 });
    const r = await reg.runAll();
    assert.equal(r.status, OVERALL.OK);
    assert.equal(r.httpStatus, 200);
    assert.equal(r.probes.length, 2);
    assert.ok(r.timestamp);
    assert.ok(typeof r.uptimeMs === 'number');
  });

  it('runAll downs the service on a critical failure', async () => {
    const reg = new HealthRegistry();
    reg.add({ name: 'good', ttlMs: 0, check: async () => 'ok' });
    reg.add({ name: 'bad', ttlMs: 0, check: async () => { throw new Error('x'); } });
    const r = await reg.runAll();
    assert.equal(r.status, OVERALL.DOWN);
    assert.equal(r.httpStatus, 503);
  });

  it('runAll filters by category', async () => {
    const reg = new HealthRegistry();
    reg.add({ name: 'crit', ttlMs: 0, check: async () => 1 });
    reg.add({ name: 'deg', ttlMs: 0, category: CATEGORY.DEGRADED, check: async () => 2 });
    const r = await reg.runAll({ category: CATEGORY.DEGRADED });
    assert.equal(r.probes.length, 1);
    assert.equal(r.probes[0].name, 'deg');
  });

  it('liveHandler always returns 200 ok', async () => {
    const reg = new HealthRegistry();
    reg.add({ name: 'bad', ttlMs: 0, check: async () => { throw new Error('x'); } });
    const handler = reg.liveHandler();
    const res = mockRes();
    await handler({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, OVERALL.OK);
    assert.equal(res.body.pid, process.pid);
  });

  it('readyHandler returns 503 when a critical probe fails', async () => {
    const reg = new HealthRegistry();
    reg.add({ name: 'db', ttlMs: 0, check: async () => { throw new Error('down'); } });
    const handler = reg.readyHandler();
    const res = mockRes();
    await handler({}, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.status, OVERALL.DOWN);
    assert.ok(Array.isArray(res.body.probes));
  });

  it('mount registers Express GET routes', () => {
    const calls = [];
    const app = { get: (path, fn) => { calls.push({ path, fn }); } };
    const reg = new HealthRegistry();
    reg.mount(app);
    assert.deepEqual(calls.map((c) => c.path), [
      '/internal/health/live',
      '/internal/health/ready',
      '/internal/health/history',
    ]);
    for (const c of calls) assert.equal(typeof c.fn, 'function');
  });
});

// ── Built-in probe factories ───────────────────────────────────────────────

describe('createDbProbe', () => {
  it('wraps a Prisma-like client successfully', async () => {
    const prisma = {
      $queryRaw: async () => [{ ok: 1 }],
    };
    const p = createDbProbe({ prisma, ttlMs: 0 });
    const r = await p.run();
    assert.equal(r.status, STATUS.PASS);
    assert.equal(r.name, 'database');
    assert.equal(r.category, CATEGORY.CRITICAL);
  });

  it('warns when SELECT 1 returns unexpected shape', async () => {
    const prisma = { $queryRaw: async () => [{ ok: 'weird' }] };
    const p = createDbProbe({ prisma, ttlMs: 0 });
    const r = await p.run();
    assert.equal(r.status, STATUS.WARN);
  });

  it('fails when the client throws', async () => {
    const prisma = { $queryRaw: async () => { throw new Error('econn'); } };
    const p = createDbProbe({ prisma, ttlMs: 0 });
    const r = await p.run();
    assert.equal(r.status, STATUS.FAIL);
    assert.equal(r.error, 'econn');
  });

  it('rejects an invalid client', () => {
    assert.throws(() => createDbProbe({}), /Prisma client/);
  });
});

describe('createRedisProbe', () => {
  it('passes on PONG', async () => {
    const client = { ping: async () => 'PONG' };
    const r = await createRedisProbe({ client, ttlMs: 0 }).run();
    assert.equal(r.status, STATUS.PASS);
    assert.equal(r.category, CATEGORY.DEGRADED);
  });

  it('warns on unexpected reply', async () => {
    const client = { ping: async () => 'NOPE' };
    const r = await createRedisProbe({ client, ttlMs: 0 }).run();
    assert.equal(r.status, STATUS.WARN);
  });

  it('fails when ping rejects', async () => {
    const client = { ping: async () => { throw new Error('connrefused'); } };
    const r = await createRedisProbe({ client, ttlMs: 0 }).run();
    assert.equal(r.status, STATUS.FAIL);
  });

  it('rejects clients without ping()', () => {
    assert.throws(() => createRedisProbe({ client: {} }), /Redis client/);
  });
});

describe('createDiskProbe', () => {
  it('passes when usage is below thresholds', async () => {
    const fakeStat = async () => ({ blocks: 1000, bsize: 1, bavail: 800 });
    const r = await createDiskProbe({
      statfs: fakeStat, ttlMs: 0, warnPct: 0.85, failPct: 0.95,
    }).run();
    assert.equal(r.status, STATUS.PASS);
    assert.equal(r.details.usedPct, 0.2);
  });

  it('warns above warnPct', async () => {
    const fakeStat = async () => ({ blocks: 100, bsize: 1, bavail: 10 });
    const r = await createDiskProbe({
      statfs: fakeStat, ttlMs: 0, warnPct: 0.85, failPct: 0.95,
    }).run();
    assert.equal(r.status, STATUS.WARN);
  });

  it('fails above failPct', async () => {
    const fakeStat = async () => ({ blocks: 100, bsize: 1, bavail: 2 });
    const r = await createDiskProbe({
      statfs: fakeStat, ttlMs: 0, warnPct: 0.85, failPct: 0.95,
    }).run();
    assert.equal(r.status, STATUS.FAIL);
  });
});

describe('createMemoryProbe', () => {
  it('classifies usage by RSS thresholds', async () => {
    const probe = createMemoryProbe({
      ttlMs: 0,
      warnRssBytes: 100,
      failRssBytes: 200,
      memoryUsage: () => ({ rss: 50, heapUsed: 1, heapTotal: 2, external: 0, arrayBuffers: 0 }),
    });
    assert.equal((await probe.run()).status, STATUS.PASS);

    const probe2 = createMemoryProbe({
      ttlMs: 0,
      warnRssBytes: 100,
      failRssBytes: 200,
      memoryUsage: () => ({ rss: 150, heapUsed: 1, heapTotal: 2, external: 0, arrayBuffers: 0 }),
    });
    assert.equal((await probe2.run()).status, STATUS.WARN);

    const probe3 = createMemoryProbe({
      ttlMs: 0,
      warnRssBytes: 100,
      failRssBytes: 200,
      memoryUsage: () => ({ rss: 250, heapUsed: 1, heapTotal: 2, external: 0, arrayBuffers: 0 }),
    });
    assert.equal((await probe3.run()).status, STATUS.FAIL);
  });
});

describe('createOpenAIProbe', () => {
  it('passes on reachable host (any HTTP code)', async () => {
    const fetchImpl = async () => ({ status: 401 });
    const r = await createOpenAIProbe({ fetchImpl, ttlMs: 0 }).run();
    assert.equal(r.status, STATUS.PASS);
    assert.equal(r.details.httpStatus, 401);
  });

  it('fails when fetch rejects', async () => {
    const fetchImpl = async () => { throw new Error('dns'); };
    const r = await createOpenAIProbe({ fetchImpl, ttlMs: 0, timeoutMs: 100 }).run();
    assert.equal(r.status, STATUS.FAIL);
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
