'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const {
  closeUserSessionRevocationBus,
  createUserSessionRevocationBus,
  initializeUserSessionRevocationBus,
  onUserSessionsRevoked,
  publishUserSessionsRevoked,
  revocationRedisOptions,
} = require('../src/services/auth/user-session-revocation-events');

test('distributed revocation Redis clients are bounded and never queue offline commands', () => {
  assert.equal(typeof revocationRedisOptions, 'function');

  const options = revocationRedisOptions({
    AUTH_REVOCATION_REDIS_CONNECT_TIMEOUT_MS: '75',
    AUTH_REVOCATION_REDIS_COMMAND_TIMEOUT_MS: '80',
  });

  assert.equal(options.lazyConnect, true);
  assert.equal(options.enableOfflineQueue, false);
  assert.equal(options.maxRetriesPerRequest, 1);
  assert.equal(options.connectTimeout, 75);
  assert.equal(options.commandTimeout, 80);
});

function createFakeRedisHub() {
  const subscribers = new Map();

  class FakeRedis extends EventEmitter {
    async connect() {}

    async subscribe(channel) {
      if (!subscribers.has(channel)) subscribers.set(channel, new Set());
      subscribers.get(channel).add(this);
      return subscribers.get(channel).size;
    }

    async unsubscribe(channel) {
      subscribers.get(channel)?.delete(this);
    }

    async publish(channel, payload) {
      for (const client of subscribers.get(channel) || []) {
        queueMicrotask(() => client.emit('message', channel, payload));
      }
      return subscribers.get(channel)?.size || 0;
    }

    async quit() {}

    disconnect() {}
  }

  return {
    createRedis: () => new FakeRedis(),
  };
}

test('a revocation published by one replica is delivered once to every other replica', async () => {
  assert.equal(typeof createUserSessionRevocationBus, 'function');
  const hub = createFakeRedisHub();
  const replicaAEvents = [];
  const replicaBEvents = [];
  const replicaA = createUserSessionRevocationBus({
    env: { REDIS_URL: 'redis://fake', NODE_ENV: 'test' },
    createRedis: hub.createRedis,
    instanceId: 'replica-a',
    onEvent: (event) => replicaAEvents.push(event),
  });
  const replicaB = createUserSessionRevocationBus({
    env: { REDIS_URL: 'redis://fake', NODE_ENV: 'test' },
    createRedis: hub.createRedis,
    instanceId: 'replica-b',
    onEvent: (event) => replicaBEvents.push(event),
  });

  await Promise.all([replicaA.init(), replicaB.init()]);
  assert.equal(await replicaA.publish({
    userId: 'user-7',
    reason: 'account_deleted',
  }), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(replicaAEvents, []);
  assert.deepEqual(replicaBEvents, [{
    userId: 'user-7',
    reason: 'account_deleted',
  }]);
  await Promise.all([replicaA.close(), replicaB.close()]);
});

test('a stuck Redis publish is bounded and degrades without failing revocation', async () => {
  let clients = 0;
  const createRedis = () => {
    clients += 1;
    const client = new EventEmitter();
    client.connect = async () => {};
    client.quit = async () => {};
    client.disconnect = () => {};
    if (clients === 1) {
      client.publish = () => new Promise(() => {});
    } else {
      client.subscribe = async () => 1;
      client.unsubscribe = async () => 1;
    }
    return client;
  };
  const bus = createUserSessionRevocationBus({
    env: {
      REDIS_URL: 'redis://fake',
      NODE_ENV: 'test',
      AUTH_REVOCATION_REDIS_COMMAND_TIMEOUT_MS: '10',
    },
    createRedis,
    instanceId: 'replica-timeout',
  });
  await bus.init();

  const startedAt = Date.now();
  const published = await bus.publish({ userId: 'user-8' });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(published, false);
  assert.ok(elapsedMs < 250, `publish took ${elapsedMs}ms`);
  assert.equal(bus.status().distributed, false);
  await bus.close();
});

test('revocation publisher delivers locally and awaits the bounded distributed bridge', async (t) => {
  assert.equal(typeof initializeUserSessionRevocationBus, 'function');
  assert.equal(typeof publishUserSessionsRevoked, 'function');
  const calls = [];
  const bus = {
    async init() { calls.push('init'); },
    async publish(event) { calls.push(['publish', event]); return true; },
    async close() { calls.push('close'); },
    status() { return { initialized: true, distributed: true, closed: false }; },
  };
  const local = [];
  const unsubscribe = onUserSessionsRevoked((event) => local.push(event));
  t.after(async () => {
    unsubscribe();
    await closeUserSessionRevocationBus();
  });
  await initializeUserSessionRevocationBus({ bus });

  const result = await publishUserSessionsRevoked({
    userId: 'local-and-remote',
    reason: 'account_deleted',
  });

  assert.deepEqual(local, [{
    userId: 'local-and-remote',
    reason: 'account_deleted',
  }]);
  assert.deepEqual(calls, [
    'init',
    ['publish', {
      userId: 'local-and-remote',
      reason: 'account_deleted',
    }],
  ]);
  assert.deepEqual(result, { delivered: 1, published: true });
});

test('server initializes revocation subscription before listen and closes it on shutdown', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
  const initAt = source.indexOf('await initializeUserSessionRevocationBus(');
  const listenAt = source.indexOf('const server = app.listen(');

  assert.ok(initAt > 0);
  assert.ok(listenAt > initAt);
  assert.match(source, /auth_revocation_bus_close[\s\S]*closeUserSessionRevocationBus/);
});
