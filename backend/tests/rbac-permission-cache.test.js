'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

function loadOptional(specifier) {
  try {
    return require(specifier);
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
}

const cacheModule = loadOptional('../src/services/rbac-permission-cache');

function requireFeature(value, label) {
  assert.ok(value, `${label} has not been implemented`);
  return value;
}

function createRedisBus() {
  const subscriptions = new Map();
  const clients = [];

  class FakeRedis extends EventEmitter {
    constructor() {
      super();
      this.closed = false;
      this.channels = new Set();
      clients.push(this);
    }

    async subscribe(channel) {
      this.channels.add(channel);
      if (!subscriptions.has(channel)) subscriptions.set(channel, new Set());
      subscriptions.get(channel).add(this);
      return 1;
    }

    async unsubscribe(channel) {
      this.channels.delete(channel);
      subscriptions.get(channel)?.delete(this);
      return 1;
    }

    async publish(channel, message) {
      for (const subscriber of subscriptions.get(channel) || []) {
        queueMicrotask(() => subscriber.emit('message', channel, message));
      }
      return subscriptions.get(channel)?.size || 0;
    }

    async quit() {
      this.closed = true;
      for (const channel of this.channels) subscriptions.get(channel)?.delete(this);
      this.channels.clear();
    }

    disconnect() {
      this.closed = true;
      for (const channel of this.channels) subscriptions.get(channel)?.delete(this);
      this.channels.clear();
    }
  }

  return {
    clients,
    createRedis: () => new FakeRedis(),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('cache TTL is clamped to a finite operational range', () => {
  const feature = requireFeature(cacheModule, 'RBAC permission cache');
  assert.equal(feature.clampCacheTtl('-50'), feature.MIN_CACHE_TTL_MS);
  assert.equal(feature.clampCacheTtl('999999999'), feature.MAX_CACHE_TTL_MS);
  assert.equal(feature.clampCacheTtl('not-a-number'), feature.DEFAULT_CACHE_TTL_MS);
});

test('enforce mode without Redis uses a bounded five-second local fallback', async () => {
  const feature = requireFeature(cacheModule, 'RBAC permission cache');
  const cache = feature.createRbacPermissionCache({
    env: {
      NODE_ENV: 'production',
      RBAC_ENFORCEMENT_MODE: 'enforce',
      RBAC_CACHE_TTL_MS: '60000',
    },
  });
  let loads = 0;
  const loader = async () => {
    loads += 1;
    return new Set(['chat.read']);
  };

  await cache.init();
  await cache.get('user-1', loader);
  await cache.get('user-1', loader);

  assert.equal(loads, 1);
  assert.equal(cache.status().enabled, true);
  assert.equal(cache.status().distributed, false);
  assert.ok(cache.status().ttlMs <= 5_000);
  assert.equal(cache.status().reason, 'bounded_local_fallback');
  await cache.close();
});

test('shadow mode may use bounded local caching without Redis', async () => {
  const feature = requireFeature(cacheModule, 'RBAC permission cache');
  const cache = feature.createRbacPermissionCache({
    env: {
      NODE_ENV: 'test',
      RBAC_ENFORCEMENT_MODE: 'shadow',
      RBAC_CACHE_TTL_MS: '60000',
    },
  });
  let loads = 0;
  await cache.get('user-1', async () => {
    loads += 1;
    return new Set(['chat.read']);
  });
  await cache.get('user-1', async () => {
    loads += 1;
    return new Set(['chat.read']);
  });

  assert.equal(loads, 1);
  assert.equal(cache.status().enabled, true);
  assert.equal(cache.status().distributed, false);
  await cache.close();
});

test('generation tokens prevent an invalidated in-flight lookup from repopulating cache', async () => {
  const feature = requireFeature(cacheModule, 'RBAC permission cache');
  const cache = feature.createRbacPermissionCache({
    env: { NODE_ENV: 'test', RBAC_ENFORCEMENT_MODE: 'shadow' },
  });
  const slow = deferred();
  const first = cache.get('user-1\u0000GLOBAL', () => slow.promise);
  await new Promise((resolve) => setImmediate(resolve));
  await cache.invalidate('user-1');
  slow.resolve(new Set(['stale.permission']));
  await first;

  let freshLoads = 0;
  const fresh = await cache.get('user-1\u0000GLOBAL', async () => {
    freshLoads += 1;
    return new Set(['fresh.permission']);
  });
  assert.equal(freshLoads, 1);
  assert.deepEqual([...fresh], ['fresh.permission']);
  assert.equal(cache._entriesForTests.get('user-1\u0000GLOBAL').value.has('stale.permission'), false);
  await cache.close();
});

test('Redis pubsub invalidates peer caches and closes owned connections', async () => {
  const feature = requireFeature(cacheModule, 'RBAC permission cache');
  const bus = createRedisBus();
  const env = {
    NODE_ENV: 'production',
    RBAC_ENFORCEMENT_MODE: 'enforce',
    REDIS_URL: 'redis://cache.test',
    RBAC_CACHE_TTL_MS: '60000',
  };
  const a = feature.createRbacPermissionCache({ env, createRedis: bus.createRedis, instanceId: 'a' });
  const b = feature.createRbacPermissionCache({ env, createRedis: bus.createRedis, instanceId: 'b' });
  await Promise.all([a.init(), b.init()]);
  let bLoads = 0;
  const loadB = async () => {
    bLoads += 1;
    return new Set([`version-${bLoads}`]);
  };
  await b.get('user-1', loadB);
  await b.get('user-1', loadB);
  assert.equal(bLoads, 1);

  await a.invalidate('user-1');
  await new Promise((resolve) => setImmediate(resolve));
  const refreshed = await b.get('user-1', loadB);
  assert.equal(bLoads, 2);
  assert.deepEqual([...refreshed], ['version-2']);
  assert.equal(a.status().distributed, true);
  assert.equal(b.status().distributed, true);

  await Promise.all([a.close(), b.close()]);
  assert.equal(bus.clients.length, 4);
  assert.equal(bus.clients.every((client) => client.closed), true);
});

test('peer invalidation also defeats a stale in-flight repopulation race', async () => {
  const feature = requireFeature(cacheModule, 'RBAC permission cache');
  const bus = createRedisBus();
  const env = {
    NODE_ENV: 'production',
    RBAC_ENFORCEMENT_MODE: 'enforce',
    REDIS_URL: 'redis://cache.test',
  };
  const a = feature.createRbacPermissionCache({ env, createRedis: bus.createRedis, instanceId: 'a' });
  const b = feature.createRbacPermissionCache({ env, createRedis: bus.createRedis, instanceId: 'b' });
  await Promise.all([a.init(), b.init()]);

  const slow = deferred();
  const pending = b.get('user-2', () => slow.promise);
  await new Promise((resolve) => setImmediate(resolve));
  await a.invalidate('user-2');
  await new Promise((resolve) => setImmediate(resolve));
  slow.resolve(new Set(['stale.permission']));
  await pending;

  let loads = 0;
  const fresh = await b.get('user-2', async () => {
    loads += 1;
    return new Set(['fresh.permission']);
  });
  assert.equal(loads, 1);
  assert.deepEqual([...fresh], ['fresh.permission']);
  await Promise.all([a.close(), b.close()]);
});

test('closing the cache prevents an in-flight shadow lookup from repopulating it', async () => {
  const feature = requireFeature(cacheModule, 'RBAC permission cache');
  const cache = feature.createRbacPermissionCache({
    env: { NODE_ENV: 'test', RBAC_ENFORCEMENT_MODE: 'shadow' },
  });
  const slow = deferred();
  const pending = cache.get('user-close-race', () => slow.promise);
  await new Promise((resolve) => setImmediate(resolve));

  await cache.close();
  slow.resolve(new Set(['stale.permission']));
  await pending;

  assert.equal(cache.status().enabled, false);
  assert.equal(cache.status().reason, 'closed');
  assert.equal(cache._entriesForTests.size, 0);
});

test('durable permission version mismatch bypasses a locally cached grant', async () => {
  const feature = requireFeature(cacheModule, 'RBAC permission cache');
  let durableVersion = '1';
  let loads = 0;
  const cache = feature.createRbacPermissionCache({
    env: {
      NODE_ENV: 'production',
      RBAC_ENFORCEMENT_MODE: 'enforce',
      RBAC_CACHE_TTL_MS: '60000',
    },
    readVersion: async () => durableVersion,
  });
  const loader = async () => {
    loads += 1;
    return new Set([`permission-v${loads}`]);
  };

  await cache.init();
  await cache.get('user-versioned', loader);
  await cache.get('user-versioned', loader);
  assert.equal(loads, 1);

  durableVersion = '2';
  const refreshed = await cache.get('user-versioned', loader);
  assert.equal(loads, 2);
  assert.deepEqual([...refreshed], ['permission-v2']);
  await cache.close();
});

test('durable version and generation both prevent stale in-flight repopulation', async () => {
  const feature = requireFeature(cacheModule, 'RBAC permission cache');
  let durableVersion = '10';
  const slow = deferred();
  const cache = feature.createRbacPermissionCache({
    env: {
      NODE_ENV: 'production',
      RBAC_ENFORCEMENT_MODE: 'enforce',
    },
    readVersion: async () => durableVersion,
  });

  const pending = cache.get('user-durable-race', () => slow.promise);
  await new Promise((resolve) => setImmediate(resolve));
  durableVersion = '11';
  slow.resolve(new Set(['stale.permission']));
  await pending;

  let loads = 0;
  const fresh = await cache.get('user-durable-race', async () => {
    loads += 1;
    return new Set(['fresh.permission']);
  });
  assert.equal(loads, 1);
  assert.deepEqual([...fresh], ['fresh.permission']);
  await cache.close();
});

test('Redis client options disable offline queues and bound retries and connect time', () => {
  const feature = requireFeature(cacheModule, 'RBAC permission cache');
  const options = requireFeature(feature.redisClientOptions, 'RBAC Redis options')({
    RBAC_REDIS_CONNECT_TIMEOUT_MS: '999999',
    RBAC_REDIS_COMMAND_TIMEOUT_MS: '999999',
  });
  assert.equal(options.enableOfflineQueue, false);
  assert.ok(Number.isInteger(options.maxRetriesPerRequest));
  assert.ok(options.maxRetriesPerRequest >= 0 && options.maxRetriesPerRequest <= 2);
  assert.ok(options.connectTimeout >= 50 && options.connectTimeout <= 2_000);
  assert.ok(options.commandTimeout >= 10 && options.commandTimeout <= 2_000);
  assert.equal(options.lazyConnect, true);
});

test('Redis invalidation publish is time-bounded and degrades without hanging mutations', async () => {
  const feature = requireFeature(cacheModule, 'RBAC permission cache');
  const clients = [];
  class PublishStalledRedis extends EventEmitter {
    constructor() {
      super();
      this.closed = false;
      clients.push(this);
    }

    async connect() {}

    async subscribe() {
      return 1;
    }

    publish() {
      return new Promise(() => {});
    }

    async unsubscribe() {}

    async quit() {
      this.closed = true;
    }

    disconnect() {
      this.closed = true;
    }
  }
  const cache = feature.createRbacPermissionCache({
    env: {
      NODE_ENV: 'production',
      RBAC_ENFORCEMENT_MODE: 'enforce',
      REDIS_URL: 'redis://publish-stalled.test',
      RBAC_REDIS_COMMAND_TIMEOUT_MS: '20',
    },
    createRedis: () => new PublishStalledRedis(),
  });

  await cache.init();
  const timeoutSentinel = Symbol('publish-timeout');
  let outcome;
  try {
    outcome = await Promise.race([
      cache.invalidate('mutation-user'),
      new Promise((resolve) => setTimeout(() => resolve(timeoutSentinel), 250)),
    ]);
    assert.notEqual(outcome, timeoutSentinel, 'mutation invalidation must not hang');
    assert.equal(outcome, false);
    assert.equal(cache.status().distributed, false);
  } finally {
    await cache.close();
  }
  assert.equal(clients.every((client) => client.closed), true);
});

test('Redis initialization is time-bounded when subscribe never settles', async () => {
  const feature = requireFeature(cacheModule, 'RBAC permission cache');
  const clients = [];
  class StalledRedis extends EventEmitter {
    constructor() {
      super();
      this.closed = false;
      clients.push(this);
    }

    async connect() {}

    subscribe() {
      return new Promise(() => {});
    }

    async unsubscribe() {}

    async quit() {
      this.closed = true;
    }
  }
  const cache = feature.createRbacPermissionCache({
    env: {
      NODE_ENV: 'production',
      RBAC_ENFORCEMENT_MODE: 'enforce',
      REDIS_URL: 'redis://stalled.test',
      RBAC_REDIS_STARTUP_TIMEOUT_MS: '20',
    },
    createRedis: () => new StalledRedis(),
  });

  const started = Date.now();
  const status = await cache.init();
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 250, `cache startup blocked for ${elapsed}ms`);
  assert.equal(status.initialized, true);
  assert.equal(status.distributed, false);
  assert.equal(status.enabled, true);
  assert.equal(status.reason, 'bounded_local_fallback');
  await cache.close();
  assert.equal(clients.every((client) => client.closed), true);
});

test('server startup initializes and shutdown closes the RBAC cache lifecycle', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
  assert.match(source, /await\s+initializePermissionsCache\(\)/);
  assert.match(
    source,
    /shutdownRegistry\.register\(\s*['"]rbac_permission_cache_close['"][\s\S]{0,180}closePermissionsCache/,
  );
});
