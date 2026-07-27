'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  IMPERSONATION_LIMITER_UNAVAILABLE,
  createImpersonationRateLimiter,
  impersonationRedisOptions,
} = require('../src/services/auth/impersonation-rate-limiter');

function env(overrides = {}) {
  return {
    NODE_ENV: 'test',
    IMPERSONATION_TARGET_LIMIT: '3',
    IMPERSONATION_ADMIN_LIMIT: '5',
    IMPERSONATION_WINDOW_MS: '3600000',
    IMPERSONATION_MEMORY_MAX_KEYS: '100',
    ...overrides,
  };
}

class FakeRedis {
  constructor(shared, {
    failPing = false,
    failCommands = false,
    failQuit = false,
    maxmemoryPolicy = 'noeviction',
    usedMemory = 20,
    maxmemory = 100,
  } = {}) {
    this.shared = shared;
    this.failPing = failPing;
    this.failCommands = failCommands;
    this.failQuit = failQuit;
    this.maxmemoryPolicy = maxmemoryPolicy;
    this.usedMemory = usedMemory;
    this.maxmemory = maxmemory;
    this.status = 'ready';
    this.closed = false;
    this.quitCalls = 0;
    this.disconnectCalls = 0;
    this.calls = [];
  }

  async ping() {
    if (this.failPing) throw new Error('redis unavailable');
    return 'PONG';
  }

  async eval(script, keyCount, ...args) {
    if (this.failCommands) throw new Error('redis command failed');
    this.calls.push({ command: 'eval', script, keyCount, args });
    if (script.includes('auth-security-readiness-v1')) {
      assert.equal(keyCount, 1);
      return 1;
    }
    assert.match(script, /impersonation-limit-v1/);
    assert.equal(keyCount, 2);
    const keys = args.slice(0, keyCount);
    const now = Number(args[2]);
    const windowStart = Number(args[3]);
    const windowMs = Number(args[4]);
    const member = String(args[5]);
    const limits = [Number(args[6]), Number(args[7])];
    const logs = keys.map((key) => {
      const active = (this.shared.get(key) || []).filter((entry) => entry.at > windowStart);
      this.shared.set(key, active);
      return active;
    });
    const blocked = logs.map((log, index) => log.length >= limits[index]);
    if (blocked.some(Boolean)) {
      const resetAt = Math.max(...logs.map((log, index) => (
        blocked[index] && log.length ? log[0].at + windowMs : now
      )));
      const dimension = blocked[0] && blocked[1] ? 3 : (blocked[0] ? 1 : 2);
      return [0, 0, resetAt, dimension];
    }
    let remaining = Infinity;
    let resetAt = now + windowMs;
    keys.forEach((key, index) => {
      const next = [...logs[index], { member, at: now }];
      this.shared.set(key, next);
      remaining = Math.min(remaining, limits[index] - next.length);
      resetAt = Math.max(resetAt, next[0].at + windowMs);
    });
    return [1, remaining, resetAt, 0];
  }

  async info(section) {
    assert.equal(section, 'memory');
    if (this.failCommands) throw new Error('redis command failed');
    this.calls.push({ command: 'info', section });
    return [
      '# Memory',
      `used_memory:${this.usedMemory}`,
      `maxmemory:${this.maxmemory}`,
      `maxmemory_policy:${this.maxmemoryPolicy}`,
    ].join('\r\n');
  }

  async quit() {
    this.quitCalls += 1;
    if (this.failQuit) throw new Error('redis quit failed');
    this.closed = true;
  }

  disconnect() {
    this.disconnectCalls += 1;
    this.closed = true;
  }
}

function pair({ clock = Date.now, overrides = {} } = {}) {
  const shared = new Map();
  const sharedEnv = env({
    REDIS_URL: 'redis://impersonation.test:6379',
    ...overrides,
  });
  const redisA = new FakeRedis(shared);
  const redisB = new FakeRedis(shared);
  return {
    shared,
    redisA,
    redisB,
    a: createImpersonationRateLimiter({
      env: sharedEnv,
      redis: redisA,
      clock,
    }),
    b: createImpersonationRateLimiter({
      env: sharedEnv,
      redis: redisB,
      clock,
    }),
  };
}

test('Redis policy has no offline queue and bounded command timeout', () => {
  const options = impersonationRedisOptions(env({
    IMPERSONATION_REDIS_CONNECT_TIMEOUT_MS: '210',
    IMPERSONATION_REDIS_COMMAND_TIMEOUT_MS: '320',
  }));
  assert.equal(options.lazyConnect, true);
  assert.equal(options.enableOfflineQueue, false);
  assert.equal(options.maxRetriesPerRequest, 1);
  assert.equal(options.connectTimeout, 210);
  assert.equal(options.commandTimeout, 320);
});

test('production readiness validates Lua support, noeviction, and memory headroom', async () => {
  const redis = new FakeRedis(new Map(), {
    maxmemoryPolicy: 'noeviction',
    usedMemory: 30,
    maxmemory: 100,
  });
  const limiter = createImpersonationRateLimiter({
    env: env({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://impersonation.test:6379',
      AUTH_SECURITY_REDIS_MAX_MEMORY_RATIO: '0.9',
    }),
    redis,
  });

  await limiter.ready();

  assert.ok(redis.calls.some(
    (call) => call.command === 'eval' && call.script.includes('auth-security-readiness-v1'),
  ));
  assert.ok(redis.calls.some((call) => call.command === 'info'));
  assert.equal(limiter.health().redisPolicy, 'noeviction');
  assert.equal(limiter.health().memoryUtilization, 0.3);
  assert.equal(limiter.health().capacityOk, true);
});

test('production fails closed for unsafe Redis eviction or exhausted capacity', async () => {
  for (const redis of [
    new FakeRedis(new Map(), { maxmemoryPolicy: 'volatile-lru' }),
    new FakeRedis(new Map(), {
      maxmemoryPolicy: 'noeviction',
      usedMemory: 91,
      maxmemory: 100,
    }),
  ]) {
    const limiter = createImpersonationRateLimiter({
      env: env({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://impersonation.test:6379',
        AUTH_SECURITY_REDIS_MAX_MEMORY_RATIO: '0.9',
      }),
      redis,
    });
    await assert.rejects(
      limiter.ready(),
      (error) => error?.code === IMPERSONATION_LIMITER_UNAVAILABLE,
    );
    assert.equal(limiter.health().ok, false);
    assert.equal(limiter.health().mode, 'unavailable');
  }
});

test('impersonation Lua keys share an admin-scoped Redis Cluster hash tag', async () => {
  const { a, redisA } = pair();

  await a.consume({ adminId: 'admin-slot', targetId: 'target-one' });
  await a.consume({ adminId: 'admin-slot', targetId: 'target-two' });

  const limitCalls = redisA.calls.filter(
    (call) => call.command === 'eval' && call.script.includes('impersonation-limit-v1'),
  );
  assert.equal(limitCalls.length, 2);
  let adminKey;
  for (const call of limitCalls) {
    const keys = call.args.slice(0, call.keyCount);
    const tags = keys.map((key) => String(key).match(/\{([^{}]+)\}/)?.[1]);
    assert.ok(tags.every(Boolean), `all Lua keys need a hash tag: ${keys.join(', ')}`);
    assert.equal(new Set(tags).size, 1, `Lua keys must share one hash slot: ${keys.join(', ')}`);
    if (adminKey) assert.equal(keys[1], adminKey, 'global admin key must span targets');
    adminKey = keys[1];
  }
});

test('admin-only Retry-After is based on the oldest admin timestamp', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/services/auth/impersonation-rate-limiter.js'),
    'utf8',
  );
  assert.match(source, /local reset_at = 0/);
  assert.doesNotMatch(
    source,
    /local reset_at = now \+ window_ms[\s\S]{0,500}if admin_reset > reset_at/,
  );
});

test('per-target sliding window is shared across replicas', async () => {
  const { a, b } = pair();
  assert.equal((await a.consume({ adminId: 'admin-1', targetId: 'user-1' })).allowed, true);
  assert.equal((await b.consume({ adminId: 'admin-1', targetId: 'user-1' })).allowed, true);
  assert.equal((await a.consume({ adminId: 'admin-1', targetId: 'user-1' })).allowed, true);
  const denied = await b.consume({ adminId: 'admin-1', targetId: 'user-1' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.dimension, 'target');
  assert.ok(denied.retryAfterMs >= 1 && denied.retryAfterMs <= 3_600_000);
});

test('global admin limit applies across different targets and replicas', async () => {
  const { a, b } = pair({
    overrides: {
      IMPERSONATION_TARGET_LIMIT: '10',
      IMPERSONATION_ADMIN_LIMIT: '2',
    },
  });
  assert.equal((await a.consume({ adminId: 'admin-global', targetId: 'u1' })).allowed, true);
  assert.equal((await b.consume({ adminId: 'admin-global', targetId: 'u2' })).allowed, true);
  const denied = await a.consume({ adminId: 'admin-global', targetId: 'u3' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.dimension, 'admin');
  assert.equal((await b.consume({ adminId: 'other-admin', targetId: 'u3' })).allowed, true);
});

test('sliding entries expire and a later request is allowed', async () => {
  let now = 1_000_000;
  const { a, b } = pair({
    clock: () => now,
    overrides: {
      IMPERSONATION_TARGET_LIMIT: '1',
      IMPERSONATION_ADMIN_LIMIT: '10',
      IMPERSONATION_WINDOW_MS: '60000',
    },
  });
  assert.equal((await a.consume({ adminId: 'a', targetId: 't' })).allowed, true);
  assert.equal((await b.consume({ adminId: 'a', targetId: 't' })).allowed, false);
  now += 60_001;
  assert.equal((await b.consume({ adminId: 'a', targetId: 't' })).allowed, true);
});

test('production fails closed on missing Redis and reports bounded retry', async () => {
  const production = createImpersonationRateLimiter({
    env: env({ NODE_ENV: 'production' }),
  });
  await assert.rejects(
    production.consume({ adminId: 'a', targetId: 't' }),
    (error) => (
      error?.code === IMPERSONATION_LIMITER_UNAVAILABLE
      && error.retryAfterSeconds >= 1
      && error.retryAfterSeconds <= 300
    ),
  );

  const down = createImpersonationRateLimiter({
    env: env({ NODE_ENV: 'production', REDIS_URL: 'redis://down.test:6379' }),
    redis: new FakeRedis(new Map(), { failCommands: true }),
  });
  await assert.rejects(
    down.consume({ adminId: 'a', targetId: 't' }),
    (error) => error?.code === IMPERSONATION_LIMITER_UNAVAILABLE,
  );
});

test('non-production uses a bounded memory fallback', async () => {
  const limiter = createImpersonationRateLimiter({
    env: env({ IMPERSONATION_MEMORY_MAX_KEYS: '2' }),
  });
  assert.equal((await limiter.consume({ adminId: 'a', targetId: 't' })).allowed, true);
  assert.equal(limiter.health().mode, 'memory');
  assert.ok(limiter.health().localKeys <= 2);
});

test('config and close lifecycle expose no Redis credentials', async () => {
  const redis = new FakeRedis(new Map());
  const limiter = createImpersonationRateLimiter({
    env: env({ REDIS_URL: 'redis://user:secret@redis.internal:6379/4' }),
    createRedis: () => redis,
  });
  await limiter.ready();
  assert.equal(limiter.health().distributed, true);
  assert.equal(JSON.stringify(limiter.config()).includes('secret'), false);
  await limiter.close();
  assert.equal(redis.closed, true);
  assert.equal(limiter.health().mode, 'closed');
});

test('close marks the limiter closed and surfaces Redis shutdown failures', async () => {
  const redis = new FakeRedis(new Map(), { failQuit: true });
  const limiter = createImpersonationRateLimiter({
    env: env({ REDIS_URL: 'redis://impersonation.test:6379' }),
    createRedis: () => redis,
  });
  await limiter.ready();

  await assert.rejects(
    limiter.close(),
    /redis quit failed|IMPERSONATION_LIMITER_CLOSE_FAILED/,
  );
  assert.equal(redis.disconnectCalls, 1);
  assert.equal(limiter.health().mode, 'closed');
});

test('readiness replaces an owned Redis client after ping and quit both fail', async () => {
  const first = new FakeRedis(new Map(), { failPing: true, failQuit: true });
  const second = new FakeRedis(new Map());
  const created = [];
  const limiter = createImpersonationRateLimiter({
    env: env({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://impersonation.test:6379',
    }),
    createRedis() {
      const client = created.length === 0 ? first : second;
      created.push(client);
      return client;
    },
  });

  await assert.rejects(
    limiter.ready(),
    (error) => error?.code === IMPERSONATION_LIMITER_UNAVAILABLE,
  );
  assert.equal(first.disconnectCalls, 1, 'failed quit must force-disconnect the owned client');
  assert.equal(limiter.health().mode, 'unavailable');

  await limiter.ready();
  assert.equal(created.length, 2, 'retry must construct a fresh owned Redis client');
  assert.equal(limiter.health().mode, 'redis');
  await limiter.close();
});

test('closing a limiter never destroys an externally injected Redis client', async () => {
  const redis = new FakeRedis(new Map());
  const limiter = createImpersonationRateLimiter({
    env: env({ REDIS_URL: 'redis://impersonation.test:6379' }),
    redis,
  });

  await limiter.ready();
  await limiter.close();

  assert.equal(redis.quitCalls, 0);
  assert.equal(redis.disconnectCalls, 0);
  assert.equal(redis.closed, false);
});

test('auth route has no process-local impersonation Map and audits rate denials', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/routes/auth.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /impersonateAttempts\s*=\s*new Map/);
  assert.match(source, /impersonationLimiter\.consume/);
  assert.match(source, /action:\s*'impersonate_denied'/);
  assert.match(source, /Retry-After/);
});
