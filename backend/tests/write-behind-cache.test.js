'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const shutdownRegistry = require('../src/utils/shutdown');

const {
  createWriteBehindCache,
  mergeData,
  stableStringify,
  keyFor,
  toPrismaData,
} = require('../src/services/write-behind-cache');

function loadFreshAuthWithWriteBehindFactory(factory) {
  const authPath = require.resolve('../src/middleware/auth');
  const writeBehindModule = require('../src/services/write-behind-cache');
  const originalFactory = writeBehindModule.createWriteBehindCache;

  writeBehindModule.createWriteBehindCache = factory;
  delete require.cache[authPath];
  try {
    return {
      auth: require(authPath),
      cleanup() {
        delete require.cache[authPath];
      },
    };
  } finally {
    writeBehindModule.createWriteBehindCache = originalFactory;
  }
}

function fakePrisma() {
  const calls = [];
  const user = {
    update: async ({ where, data }) => { calls.push({ model: 'user', where, data }); return { id: where.id, ...data }; },
  };
  const broken = {
    update: async () => { const e = new Error('not found'); e.code = 'P2025'; throw e; },
  };
  return { user, broken, _calls: calls };
}

test('stableStringify is order-insensitive', () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  assert.equal(stableStringify(null), 'null');
  assert.equal(stableStringify([1, 2]), '[1,2]');
  assert.equal(stableStringify(new Date('2026-05-22T00:00:00Z')), '"2026-05-22T00:00:00.000Z"');
  assert.equal(stableStringify({ id: 1n }), '{"id":"1n"}');
  const circular = { id: 'x' };
  circular.self = circular;
  assert.equal(stableStringify(circular), '{"id":"x","self":"[circular]"}');
});

test('keyFor produces deterministic keys', () => {
  assert.equal(keyFor('user', { id: 'a' }), keyFor('user', { id: 'a' }));
  assert.notEqual(keyFor('user', { id: 'a' }), keyFor('user', { id: 'b' }));
  assert.notEqual(
    keyFor('user', { updatedAt: new Date('2026-01-01T00:00:00Z') }),
    keyFor('user', { updatedAt: new Date('2026-01-02T00:00:00Z') }),
  );
});

test('mergeData overwrites scalars and accumulates increments', () => {
  const merged = mergeData(
    { a: 1, b: { __increment: 2 } },
    { a: 9, b: { __increment: 3 }, c: 'new' },
  );
  assert.equal(merged.a, 9);
  assert.deepEqual(merged.b, { __increment: 5 });
  assert.equal(merged.c, 'new');
});

test('toPrismaData converts increment markers', () => {
  assert.deepEqual(
    toPrismaData({ name: 'x', count: { __increment: 3 } }),
    { name: 'x', count: { increment: 3 } },
  );
});

test('queueWrite coalesces by (model, where) and last-write-wins', () => {
  const prisma = fakePrisma();
  const wbc = createWriteBehindCache({ prisma, flushIntervalMs: 0 });
  wbc.queueWrite('user', { id: 'a' }, { lastActiveAt: 100 });
  wbc.queueWrite('user', { id: 'a' }, { lastActiveAt: 200 });
  wbc.queueWrite('user', { id: 'b' }, { lastActiveAt: 50 });
  assert.equal(wbc.size(), 2);
  assert.deepEqual(wbc.getPending('user', { id: 'a' }), { lastActiveAt: 200 });
});

test('flushIntervalMs: 0 disables interval-driven flushing for deterministic callers', async () => {
  const prisma = fakePrisma();
  const wbc = createWriteBehindCache({ prisma, flushIntervalMs: 0, flushThreshold: 100 });
  wbc.queueWrite('user', { id: 'manual-only' }, { lastActiveAt: 1 });

  await new Promise((r) => setTimeout(r, 20));

  assert.equal(wbc.stats().flushIntervalMs, 0);
  assert.equal(wbc.size(), 1);
  assert.equal(prisma._calls.length, 0);
  const result = await wbc.flushNow();
  assert.equal(result.flushed, 1);
});

test('flushNow batches per model and calls prisma.update', async () => {
  const prisma = fakePrisma();
  const wbc = createWriteBehindCache({ prisma, flushIntervalMs: 0 });
  wbc.queueWrite('user', { id: 'a' }, { lastActiveAt: 1 });
  wbc.queueWrite('user', { id: 'b' }, { apiUsage: { __increment: 1 } });
  const r = await wbc.flushNow();
  assert.equal(r.flushed, 2);
  assert.equal(prisma._calls.length, 2);
  // Verify increment translation
  const incCall = prisma._calls.find((c) => c.where.id === 'b');
  assert.deepEqual(incCall.data.apiUsage, { increment: 1 });
});

test('flushNow tolerates P2025 (row not found) without throwing', async () => {
  const prisma = fakePrisma();
  const wbc = createWriteBehindCache({ prisma, flushIntervalMs: 0 });
  wbc.queueWrite('broken', { id: 'x' }, { foo: 1 });
  const r = await wbc.flushNow();
  assert.equal(r.flushed, 0);
});

test('threshold triggers an async flush', async () => {
  const prisma = fakePrisma();
  const wbc = createWriteBehindCache({ prisma, flushIntervalMs: 0, flushThreshold: 3 });
  wbc.queueWrite('user', { id: '1' }, { lastActiveAt: 1 });
  wbc.queueWrite('user', { id: '2' }, { lastActiveAt: 1 });
  wbc.queueWrite('user', { id: '3' }, { lastActiveAt: 1 });
  // Give the microtask + flush a chance to run.
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(prisma._calls.length >= 1);
});

test('shutdown drains pending and stops timer', async () => {
  const prisma = fakePrisma();
  const wbc = createWriteBehindCache({ prisma, flushIntervalMs: 5000 });
  wbc.queueWrite('user', { id: 'z' }, { lastActiveAt: 99 });
  const r = await wbc.shutdown();
  assert.equal(r.flushed, 1);
  assert.equal(wbc.size(), 0);
});

test('shutdown waits for an active flush before resolving', async (t) => {
  let markStarted;
  let releaseUpdate;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const updateReleased = new Promise((resolve) => { releaseUpdate = resolve; });
  t.after(() => releaseUpdate());

  const prisma = {
    user: {
      update: async ({ where, data }) => {
        markStarted();
        await updateReleased;
        return { id: where.id, ...data };
      },
    },
  };
  const wbc = createWriteBehindCache({ prisma, flushIntervalMs: 0 });
  wbc.queueWrite('user', { id: 'active' }, { lastActiveAt: 1 });
  const activeFlush = wbc.flushNow();
  await started;

  let shutdownSettled = false;
  const stopping = wbc.shutdown().then((result) => {
    shutdownSettled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(shutdownSettled, false);
  releaseUpdate();
  const [flushResult, shutdownResult] = await Promise.all([activeFlush, stopping]);
  assert.equal(flushResult.flushed, 1);
  assert.equal(shutdownResult.flushed, 1);
  assert.equal(wbc.size(), 0);
});

test('shutdown drains transient retries until pending writes succeed', async () => {
  let calls = 0;
  const prisma = {
    user: {
      update: async ({ where, data }) => {
        calls += 1;
        if (calls === 1) throw new Error('temporary database outage');
        return { id: where.id, ...data };
      },
    },
  };
  const wbc = createWriteBehindCache({
    prisma,
    flushIntervalMs: 0,
    maxRetries: 3,
    shutdownMaxDrainAttempts: 3,
  });
  wbc.queueWrite('user', { id: 'retry-on-shutdown' }, { lastActiveAt: 2 });

  const result = await wbc.shutdown();

  assert.equal(result.flushed, 1);
  assert.equal(result.retried, 1);
  assert.equal(calls, 2);
  assert.equal(wbc.size(), 0);
});

test('shutdown rejects and reports writes left after bounded drain attempts', async () => {
  let calls = 0;
  const errors = [];
  const prisma = {
    user: {
      update: async () => {
        calls += 1;
        throw new Error('database remains unavailable');
      },
    },
  };
  const wbc = createWriteBehindCache({
    prisma,
    flushIntervalMs: 0,
    maxRetries: 1,
    shutdownMaxDrainAttempts: 2,
    onError: (...args) => errors.push(args),
  });
  wbc.queueWrite('user', { id: 'still-pending' }, { lastActiveAt: 3 });

  await assert.rejects(
    wbc.shutdown(),
    (error) => {
      assert.equal(error.code, 'WRITE_BEHIND_SHUTDOWN_INCOMPLETE');
      assert.equal(error.pending, 1);
      return true;
    },
  );

  assert.equal(calls, 2);
  assert.equal(wbc.size(), 1);
  assert.ok(errors.some(([stage]) => stage === 'shutdown_incomplete'));
});

test('shutdown rejects writes queued after shutdown begins', async () => {
  const wbc = createWriteBehindCache({ prisma: fakePrisma(), flushIntervalMs: 0 });
  const stopping = wbc.shutdown();

  assert.throws(
    () => wbc.queueWrite('user', { id: 'too-late' }, { lastActiveAt: 4 }),
    /shutting down/,
  );
  await stopping;
  assert.equal(wbc.size(), 0);
});

test('unknown model is skipped silently', async () => {
  const prisma = fakePrisma();
  const wbc = createWriteBehindCache({ prisma, flushIntervalMs: 0 });
  wbc.queueWrite('nope', { id: 'a' }, { foo: 1 });
  const r = await wbc.flushNow();
  assert.equal(r.flushed, 0);
  const stats = wbc.stats();
  assert.equal(stats.totalDropped, 1);
});

test('redis mirror is fire-and-forget', async () => {
  const prisma = fakePrisma();
  const redisCalls = [];
  const redis = {
    hset: async (...args) => { redisCalls.push(['hset', args]); },
    hdel: async (...args) => { redisCalls.push(['hdel', args]); },
    hgetall: async () => ({}),
  };
  const wbc = createWriteBehindCache({ prisma, redis, flushIntervalMs: 0 });
  wbc.queueWrite('user', { id: 'a' }, { lastActiveAt: 1 });
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(redisCalls.some((c) => c[0] === 'hset'));
  await wbc.flushNow();
});

test('flushNow retains transient failures for retry instead of dropping writes', async () => {
  const calls = [];
  let fail = true;
  const prisma = {
    user: {
      update: async ({ where, data }) => {
        calls.push({ where, data });
        if (fail) throw new Error('temporary database outage');
        return { id: where.id, ...data };
      },
    },
  };
  const errors = [];
  const wbc = createWriteBehindCache({ prisma, flushIntervalMs: 0, maxRetries: 3, onError: (...args) => errors.push(args) });

  wbc.queueWrite('user', { id: 'retry-me' }, { apiUsage: { __increment: 2 } });
  const first = await wbc.flushNow();

  assert.equal(first.flushed, 0);
  assert.equal(first.retried, 1);
  assert.equal(wbc.size(), 1);
  assert.deepEqual(wbc.getPending('user', { id: 'retry-me' }), { apiUsage: { __increment: 2 } });
  assert.ok(errors.some(([stage]) => stage === 'flush_update'));

  fail = false;
  const second = await wbc.flushNow();
  assert.equal(second.flushed, 1);
  assert.equal(wbc.size(), 0);
  assert.equal(calls.length, 2);
});

test('flushNow merges retry payloads with writes queued during an in-flight flush', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const prisma = {
    user: {
      update: async () => {
        await gate;
        throw new Error('db still down');
      },
    },
  };
  const wbc = createWriteBehindCache({ prisma, flushIntervalMs: 0, maxRetries: 3 });

  wbc.queueWrite('user', { id: 'coalesced' }, { apiUsage: { __increment: 2 }, lastActiveAt: 100 });
  const flushing = wbc.flushNow();
  wbc.queueWrite('user', { id: 'coalesced' }, { apiUsage: { __increment: 5 }, lastActiveAt: 200 });
  release();
  const result = await flushing;

  assert.equal(result.retried, 1);
  assert.deepEqual(wbc.getPending('user', { id: 'coalesced' }), {
    apiUsage: { __increment: 7 },
    lastActiveAt: 200,
  });
});

test('flushNow drops poison writes after maxRetries and clears redis only then', async () => {
  const redisCalls = [];
  const prisma = {
    user: {
      update: async () => { throw new Error('permanent failure'); },
    },
  };
  const redis = {
    hset: async (...args) => { redisCalls.push(['hset', args]); },
    hdel: async (...args) => { redisCalls.push(['hdel', args]); },
    hgetall: async () => ({}),
  };
  const errors = [];
  const wbc = createWriteBehindCache({ prisma, redis, flushIntervalMs: 0, maxRetries: 1, onError: (...args) => errors.push(args) });

  wbc.queueWrite('user', { id: 'poison' }, { lastActiveAt: 1 });
  await new Promise((r) => setTimeout(r, 5));
  const first = await wbc.flushNow();
  assert.equal(first.retried, 1);
  assert.equal(redisCalls.filter(([op]) => op === 'hdel').length, 0);

  const second = await wbc.flushNow();
  assert.equal(second.dropped, 1);
  assert.equal(wbc.size(), 0);
  assert.equal(wbc.stats().totalDropped, 1);
  assert.ok(redisCalls.some(([op]) => op === 'hdel'));
  assert.ok(errors.some(([stage]) => stage === 'retry_exhausted'));
});

test('queueWrite rejects non-finite increment payloads before corrupting data', () => {
  const wbc = createWriteBehindCache({ prisma: fakePrisma(), flushIntervalMs: 0 });
  assert.throws(
    () => wbc.queueWrite('user', { id: 'bad' }, { apiUsage: { __increment: Number.NaN } }),
    /finite increment/,
  );
  assert.equal(wbc.size(), 0);
});

test('hydrateFromRedis merges duplicate pending entries with local queue safely', async () => {
  const redis = {
    hgetall: async () => ({
      [keyFor('user', { id: 'hydrated' })]: JSON.stringify({
        model: 'user',
        where: { id: 'hydrated' },
        data: { apiUsage: { __increment: 2 }, lastActiveAt: 100 },
      }),
    }),
  };
  const wbc = createWriteBehindCache({ prisma: fakePrisma(), redis, flushIntervalMs: 0 });
  wbc.queueWrite('user', { id: 'hydrated' }, { apiUsage: { __increment: 3 }, lastActiveAt: 200 });

  const result = await wbc.hydrateFromRedis();

  assert.equal(result.hydrated, 1);
  assert.deepEqual(wbc.getPending('user', { id: 'hydrated' }), {
    apiUsage: { __increment: 5 },
    lastActiveAt: 200,
  });
});

test('auth shutdown stops the existing write-behind singleton exactly once', async (t) => {
  const previousDisabled = process.env.WRITE_BEHIND_DISABLED;
  delete process.env.WRITE_BEHIND_DISABLED;

  let creations = 0;
  let shutdownCalls = 0;
  const prisma = fakePrisma();
  let singleton;
  const loaded = loadFreshAuthWithWriteBehindFactory(() => {
    creations += 1;
    singleton = createWriteBehindCache({ prisma, flushIntervalMs: 0 });
    const shutdown = singleton.shutdown;
    singleton.shutdown = async () => {
      shutdownCalls += 1;
      return shutdown();
    };
    return singleton;
  });
  t.after(() => {
    loaded.cleanup();
    if (previousDisabled === undefined) delete process.env.WRITE_BEHIND_DISABLED;
    else process.env.WRITE_BEHIND_DISABLED = previousDisabled;
  });

  const live = loaded.auth.__getWriteBehindCache();
  assert.strictEqual(live, singleton);
  assert.equal(creations, 1);
  live.queueWrite('user', { id: 'shutdown-user' }, { lastActiveAt: 123 });

  const first = await loaded.auth.shutdownWriteBehindCache();
  const second = await loaded.auth.shutdownWriteBehindCache();

  assert.deepEqual(first, { flushed: 1, batches: 1, retried: 0, dropped: 0 });
  assert.deepEqual(second, first);
  assert.equal(shutdownCalls, 1);
  assert.equal(live.size(), 0);
  assert.equal(prisma._calls.length, 1);
});

test('auth shutdown prevents later creation of an unused write-behind singleton', async (t) => {
  const previousDisabled = process.env.WRITE_BEHIND_DISABLED;
  delete process.env.WRITE_BEHIND_DISABLED;

  let creations = 0;
  const singleton = { shutdown: async () => ({ flushed: 0 }) };
  const loaded = loadFreshAuthWithWriteBehindFactory(() => {
    creations += 1;
    return singleton;
  });
  t.after(() => {
    loaded.cleanup();
    if (previousDisabled === undefined) delete process.env.WRITE_BEHIND_DISABLED;
    else process.env.WRITE_BEHIND_DISABLED = previousDisabled;
  });

  assert.equal(await loaded.auth.shutdownWriteBehindCache(), undefined);
  assert.equal(creations, 0);
  assert.equal(loaded.auth.__getWriteBehindCache(), null);
  assert.equal(creations, 0);
});

test('auth shutdown is a no-op when write-behind caching is disabled', async (t) => {
  const previousDisabled = process.env.WRITE_BEHIND_DISABLED;
  process.env.WRITE_BEHIND_DISABLED = 'true';

  let creations = 0;
  const loaded = loadFreshAuthWithWriteBehindFactory(() => {
    creations += 1;
    return { shutdown: async () => ({ flushed: 0 }) };
  });
  t.after(() => {
    loaded.cleanup();
    if (previousDisabled === undefined) delete process.env.WRITE_BEHIND_DISABLED;
    else process.env.WRITE_BEHIND_DISABLED = previousDisabled;
  });

  assert.equal(await loaded.auth.shutdownWriteBehindCache(), undefined);
  assert.equal(loaded.auth.__getWriteBehindCache(), null);
  assert.equal(creations, 0);
});

test('central shutdown invokes the auth-owned write-behind shutdown function', () => {
  const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');
  const hook = source.match(
    /shutdownRegistry\.register\(\s*'write_behind_cache_flush',([\s\S]*?),\s*5000,?\s*\);/,
  );

  assert.ok(hook, 'write-behind shutdown hook must remain registered');
  assert.match(
    source,
    /executionOrder:\s*shutdownRegistry\.PRODUCTION_SHUTDOWN_ORDER/,
    'production shutdown must opt into the behaviorally tested explicit order',
  );
  assert.match(hook[1], /shutdownWriteBehindCache\(\)/);
  assert.doesNotMatch(hook[1], /__getWriteBehindCache|services\/cache\/write-behind/);
});

test('central shutdown returns both websocket close promises to the registry', () => {
  const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');

  assert.match(
    source,
    /shutdownRegistry\.register\(\s*'realtime_ws_close',\s*\(\)\s*=>\s*closeRealtimeServer\(\)/,
  );
  assert.match(
    source,
    /shutdownRegistry\.register\(\s*'computer_use_ws_close',\s*\(\)\s*=>\s*closeComputerUseWebSocketServer\(\)/,
  );
});

test('production shutdown hooks execute in explicit dependency-safe order', async (t) => {
  const expected = [
    'scheduler_stop',
    'system_cron_stop',
    'realtime_ws_close',
    'computer_use_ws_close',
    'http_server_close',
    'drain_inflight_requests',
    'write_behind_cache_flush',
    'bullmq_workers_close',
    'queue_health_probe_close',
    'observability_flush',
    'prisma_disconnect',
    'redis_disconnect',
  ];
  const registrationOrder = [
    'system_cron_stop',
    'http_server_close',
    'drain_inflight_requests',
    'write_behind_cache_flush',
    'realtime_ws_close',
    'computer_use_ws_close',
    'bullmq_workers_close',
    'queue_health_probe_close',
    'prisma_disconnect',
    'redis_disconnect',
    'observability_flush',
    'scheduler_stop',
  ];
  const executed = [];
  const closedWebSocketServers = new Set();
  shutdownRegistry._resetForTests();
  t.after(() => shutdownRegistry._resetForTests());

  shutdownRegistry.configure({
    executionOrder: shutdownRegistry.PRODUCTION_SHUTDOWN_ORDER,
  });
  for (const name of registrationOrder) {
    shutdownRegistry.register(name, async () => {
      if (name === 'realtime_ws_close' || name === 'computer_use_ws_close') {
        await new Promise((resolve) => setImmediate(resolve));
        closedWebSocketServers.add(name);
      }
      if (name === 'http_server_close') {
        assert.deepEqual(
          [...closedWebSocketServers].sort(),
          ['computer_use_ws_close', 'realtime_ws_close'],
        );
      }
      executed.push(name);
    });
  }

  const result = await shutdownRegistry.shutdown('production-order-test');

  assert.deepEqual(executed, expected);
  assert.deepEqual(shutdownRegistry.PRODUCTION_SHUTDOWN_ORDER, expected);
  assert.equal(result.ok, true);
});
