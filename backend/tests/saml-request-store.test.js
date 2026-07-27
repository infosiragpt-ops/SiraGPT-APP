'use strict';

const crypto = require('node:crypto');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SAML_REQUEST_TTL_MS,
  SAML_REQUEST_STORE_UNAVAILABLE,
  createSamlRequestStore,
  redisClientOptions,
} = require('../src/services/saml-request-store');

const SECRET = 'test-only-saml-relay-state-secret-32-bytes';
const PREAUTH_NONCE = Buffer.alloc(32, 3).toString('base64url');
const PREAUTH_NONCE_HASH = crypto
  .createHash('sha256')
  .update(PREAUTH_NONCE)
  .digest('base64url');

function memoryStore(options = {}) {
  return createSamlRequestStore({
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: SECRET,
      ...options.env,
    },
    clock: options.clock,
    randomBytes: options.randomBytes,
  });
}

test('non-production request cache uses a bounded in-memory fallback', async () => {
  const store = memoryStore({
    env: { SAML_REQUEST_CACHE_MAX_ENTRIES: '2' },
  });
  await store.ensureAvailable();
  assert.equal(store.status().mode, 'memory');
  assert.equal(store.status().maxEntries, 2);

  const provider = store.createCacheProvider('acme');
  await provider.saveAsync('_request-1', '2026-07-11T00:00:00.000Z');
  await provider.saveAsync('_request-2', '2026-07-11T00:00:01.000Z');
  await provider.saveAsync('_request-3', '2026-07-11T00:00:02.000Z');

  assert.equal(await store.createCacheProvider('acme').getAsync('_request-1'), null);
  assert.equal(
    await store.createCacheProvider('acme').getAsync('_request-2'),
    '2026-07-11T00:00:01.000Z',
  );
});

test('cache-provider get atomically claims globally but remains readable within one validation', async () => {
  const store = memoryStore();
  const loginProvider = store.createCacheProvider('acme');
  await loginProvider.saveAsync('_request-1', '2026-07-11T00:00:00.000Z');

  const firstCallback = store.createCacheProvider('acme');
  const replayCallback = store.createCacheProvider('acme');
  assert.equal(
    await firstCallback.getAsync('_request-1'),
    '2026-07-11T00:00:00.000Z',
  );
  assert.equal(
    await firstCallback.getAsync('_request-1'),
    '2026-07-11T00:00:00.000Z',
    'node-saml reads the ID twice during one validation',
  );
  assert.equal(
    await replayCallback.getAsync('_request-1'),
    null,
    'a concurrent/replayed callback cannot claim the same request',
  );
  assert.equal(await firstCallback.removeAsync('_request-1'), '_request-1');
});

test('request IDs are bound to the organization cache namespace', async () => {
  const store = memoryStore();
  await store.createCacheProvider('acme').saveAsync('_request-1', 'instant');

  assert.equal(await store.createCacheProvider('other-org').getAsync('_request-1'), null);
  assert.equal(await store.createCacheProvider('acme').getAsync('_request-1'), 'instant');
});

test('expired request IDs cannot be claimed', async () => {
  let now = Date.parse('2026-07-11T00:00:00.000Z');
  const store = memoryStore({
    clock: () => now,
    env: { SAML_REQUEST_TTL_MS: '60000' },
  });
  await store.createCacheProvider('acme').saveAsync('_request-1', new Date(now).toISOString());

  now += 60_001;
  assert.equal(await store.createCacheProvider('acme').getAsync('_request-1'), null);
});

test('production refuses an in-memory fallback when Redis is not configured', async () => {
  const store = createSamlRequestStore({
    env: {
      NODE_ENV: 'production',
      JWT_SECRET: SECRET,
    },
  });

  await assert.rejects(store.ensureAvailable(), (error) => {
    assert.equal(error.code, SAML_REQUEST_STORE_UNAVAILABLE);
    assert.equal(error.message, SAML_REQUEST_STORE_UNAVAILABLE);
    return true;
  });
  assert.equal(store.status().mode, 'unavailable');
});

test('production fails promptly when Redis startup stalls', async () => {
  const redis = {
    status: 'ready',
    ping: () => new Promise(() => {}),
    disconnect() {},
  };
  const store = createSamlRequestStore({
    env: {
      NODE_ENV: 'production',
      REDIS_URL: 'redis://redis:6379',
      JWT_SECRET: SECRET,
      SAML_REDIS_COMMAND_TIMEOUT_MS: '20',
    },
    redis,
  });

  const startedAt = Date.now();
  await assert.rejects(store.ensureAvailable(), (error) => {
    assert.equal(error.code, SAML_REQUEST_STORE_UNAVAILABLE);
    return true;
  });
  assert.ok(Date.now() - startedAt < 250, 'stalled Redis must be deadline-bound');
  assert.equal(store.status().mode, 'unavailable');
});

test('production Redis initialization circuit recovers after bounded backoff without restart', async () => {
  let now = Date.parse('2026-07-11T00:00:00.000Z');
  let pingCalls = 0;
  const redis = {
    status: 'ready',
    async ping() {
      pingCalls += 1;
      if (pingCalls === 1) throw new Error('transient redis startup failure');
      return 'PONG';
    },
    disconnect() {},
  };
  const store = createSamlRequestStore({
    env: {
      NODE_ENV: 'production',
      REDIS_URL: 'redis://redis:6379',
      JWT_SECRET: SECRET,
      SAML_REDIS_RETRY_BASE_MS: '100',
      SAML_REDIS_RETRY_MAX_MS: '500',
    },
    redis,
    clock: () => now,
  });

  await assert.rejects(
    store.ensureAvailable(),
    (error) => error.code === SAML_REQUEST_STORE_UNAVAILABLE,
  );
  assert.equal(store.status().circuitState, 'open');
  assert.equal(store.status().consecutiveFailures, 1);
  assert.equal(store.status().retryAt, now + 100);

  await assert.rejects(
    store.ensureAvailable(),
    (error) => error.code === SAML_REQUEST_STORE_UNAVAILABLE,
    'an open circuit remains fail-closed before its retry deadline',
  );
  assert.equal(pingCalls, 1);

  now += 100;
  const recovered = await store.ensureAvailable();
  assert.equal(recovered.mode, 'redis');
  assert.equal(recovered.circuitState, 'closed');
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(pingCalls, 2);
});

test('Redis initialization backoff doubles and stays capped', async () => {
  let now = 10_000;
  let pingCalls = 0;
  const redis = {
    status: 'ready',
    async ping() {
      pingCalls += 1;
      throw new Error('redis unavailable');
    },
    disconnect() {},
  };
  const store = createSamlRequestStore({
    env: {
      NODE_ENV: 'production',
      REDIS_URL: 'redis://redis:6379',
      JWT_SECRET: SECRET,
      SAML_REDIS_RETRY_BASE_MS: '20',
      SAML_REDIS_RETRY_MAX_MS: '50',
    },
    redis,
    clock: () => now,
  });

  const expectedDelays = [20, 40, 50, 50];
  for (const delay of expectedDelays) {
    await assert.rejects(
      store.ensureAvailable(),
      (error) => error.code === SAML_REQUEST_STORE_UNAVAILABLE,
    );
    assert.equal(store.status().retryAt - now, delay);
    now += delay;
  }
  assert.equal(pingCalls, expectedDelays.length);
});

test('Redis client policy disables offline queue and bounds command latency', () => {
  const options = redisClientOptions({
    SAML_REDIS_CONNECT_TIMEOUT_MS: '75',
    SAML_REDIS_COMMAND_TIMEOUT_MS: '90',
  });
  assert.equal(options.enableOfflineQueue, false);
  assert.equal(options.maxRetriesPerRequest, 1);
  assert.equal(options.lazyConnect, true);
  assert.equal(options.connectTimeout, 75);
  assert.equal(options.commandTimeout, 90);
});

test('production Redis runtime errors never fall back to process memory', async () => {
  let evalCalls = 0;
  const redis = {
    status: 'ready',
    async ping() { return 'PONG'; },
    async eval() {
      evalCalls += 1;
      throw new Error('redis down');
    },
    async del() { return 0; },
    disconnect() {},
  };
  const store = createSamlRequestStore({
    env: {
      NODE_ENV: 'production',
      REDIS_URL: 'redis://redis:6379',
      JWT_SECRET: SECRET,
      SAML_REDIS_COMMAND_TIMEOUT_MS: '50',
    },
    redis,
  });
  await store.ensureAvailable();

  await assert.rejects(
    store.createCacheProvider('acme').saveAsync('_request-1', 'instant'),
    (error) => error.code === SAML_REQUEST_STORE_UNAVAILABLE,
  );
  assert.equal(evalCalls, 1);
  assert.equal(store.status().mode, 'redis');
  assert.equal(store.status().localEntries, 0);
});

test('distributed cache bounds cardinality and consumes request IDs in atomic Lua calls', async () => {
  const values = new Map();
  const evalCalls = [];
  const redis = {
    status: 'ready',
    async ping() { return 'PONG'; },
    async eval(script, keyCount, ...args) {
      evalCalls.push({ script, keyCount, args });
      const key = args[0];
      if (script.includes("redis.call('PSETEX'")) {
        if (values.has(key)) return 0;
        values.set(key, args[5]);
        return 1;
      }
      if (script.includes('pcall(cjson.decode')) {
        const value = values.get(key) ?? null;
        if (!value) return [0, ''];
        const parsed = JSON.parse(value);
        if (parsed.preAuthNonceHash !== args[2]) return [-1, ''];
        values.delete(key);
        return [1, value];
      }
      if (script.includes("redis.call('GET'")) {
        const value = values.get(key) ?? null;
        values.delete(key);
        return value;
      }
      if (script.includes("redis.call('DEL'")) {
        const existed = values.delete(key);
        return existed ? 1 : 0;
      }
      throw new Error('unexpected script');
    },
    disconnect() {},
  };
  const store = createSamlRequestStore({
    env: {
      NODE_ENV: 'production',
      REDIS_URL: 'redis://redis:6379',
      JWT_SECRET: SECRET,
      SAML_REQUEST_CACHE_MAX_ENTRIES: '25',
    },
    redis,
  });
  const login = store.createCacheProvider('acme');
  await login.saveAsync('_request-1', 'instant');

  const callback = store.createCacheProvider('acme');
  assert.equal(await callback.getAsync('_request-1'), 'instant');
  assert.equal(await store.createCacheProvider('acme').getAsync('_request-1'), null);

  const saveCall = evalCalls[0];
  assert.equal(saveCall.keyCount, 2);
  assert.match(saveCall.script, /ZCARD/);
  assert.match(saveCall.script, /ZREMRANGEBYRANK/);
  assert.ok(saveCall.args.includes('25'));
  const claimCall = evalCalls[1];
  assert.equal(claimCall.keyCount, 2);
  assert.match(claimCall.script, /GET/);
  assert.match(claimCall.script, /DEL/);

  const relayState = await store.issueRelayState({
    orgSlug: 'acme',
    requestId: '_request-2',
    preAuthNonceHash: PREAUTH_NONCE_HASH,
  });
  const storedRelay = [...values.values()][0];
  assert.equal(storedRelay.includes(PREAUTH_NONCE), false);
  assert.equal(JSON.parse(storedRelay).preAuthNonceHash, PREAUTH_NONCE_HASH);

  const wrongHash = crypto.createHash('sha256').update('wrong browser').digest('base64url');
  await assert.rejects(
    store.consumeRelayState({
      relayState,
      orgSlug: 'acme',
      preAuthNonceHash: wrongHash,
    }),
    (error) => error.code === 'SAML_BROWSER_BINDING_INVALID',
  );
  assert.equal(values.size, 1, 'a mismatched browser cannot burn valid Redis state');
  assert.deepEqual(
    await store.consumeRelayState({
      relayState,
      orgSlug: 'acme',
      preAuthNonceHash: PREAUTH_NONCE_HASH,
    }),
    { requestId: '_request-2' },
  );
  const matchingClaims = evalCalls.filter((call) => call.script.includes('pcall(cjson.decode'));
  assert.equal(matchingClaims.length, 2);
  assert.match(matchingClaims[0].script, /DEL/);
});

test('RelayState is signed, bound to org and request, and consumed once', async () => {
  const store = memoryStore({
    randomBytes: () => Buffer.alloc(24, 7),
  });
  const relayState = await store.issueRelayState({
    orgSlug: 'acme',
    requestId: '_request-1',
    preAuthNonceHash: PREAUTH_NONCE_HASH,
  });

  assert.match(relayState, /^[a-z0-9]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(
    Buffer.byteLength(relayState, 'utf8') <= 80,
    'SAML HTTP bindings limit RelayState to 80 bytes',
  );
  assert.deepEqual(
    await store.consumeRelayState({
      relayState,
      orgSlug: 'acme',
      preAuthNonceHash: PREAUTH_NONCE_HASH,
    }),
    { requestId: '_request-1' },
  );
  await assert.rejects(
    store.consumeRelayState({
      relayState,
      orgSlug: 'acme',
      preAuthNonceHash: PREAUTH_NONCE_HASH,
    }),
    (error) => error.code === 'SAML_RELAY_STATE_INVALID',
  );
});

test('cross-org RelayState rejection does not consume the legitimate state', async () => {
  const store = memoryStore();
  const relayState = await store.issueRelayState({
    orgSlug: 'acme',
    requestId: '_request-1',
    preAuthNonceHash: PREAUTH_NONCE_HASH,
  });

  await assert.rejects(
    store.consumeRelayState({
      relayState,
      orgSlug: 'other-org',
      preAuthNonceHash: PREAUTH_NONCE_HASH,
    }),
    (error) => error.code === 'SAML_RELAY_STATE_INVALID',
  );
  assert.deepEqual(
    await store.consumeRelayState({
      relayState,
      orgSlug: 'acme',
      preAuthNonceHash: PREAUTH_NONCE_HASH,
    }),
    { requestId: '_request-1' },
  );
});

test('expired and tampered RelayState values are rejected', async () => {
  let now = Date.parse('2026-07-11T00:00:00.000Z');
  const store = memoryStore({
    clock: () => now,
    env: { SAML_REQUEST_TTL_MS: '60000' },
  });
  const relayState = await store.issueRelayState({
    orgSlug: 'acme',
    requestId: '_request-1',
    preAuthNonceHash: PREAUTH_NONCE_HASH,
  });

  const tampered = `${relayState.slice(0, -1)}${relayState.endsWith('a') ? 'b' : 'a'}`;
  await assert.rejects(
    store.consumeRelayState({
      relayState: tampered,
      orgSlug: 'acme',
      preAuthNonceHash: PREAUTH_NONCE_HASH,
    }),
    (error) => error.code === 'SAML_RELAY_STATE_INVALID',
  );

  now += 60_001;
  await assert.rejects(
    store.consumeRelayState({
      relayState,
      orgSlug: 'acme',
      preAuthNonceHash: PREAUTH_NONCE_HASH,
    }),
    (error) => error.code === 'SAML_RELAY_STATE_EXPIRED',
  );
});

test('SAML request TTL is short-lived rather than the node-saml eight-hour default', () => {
  assert.ok(DEFAULT_SAML_REQUEST_TTL_MS >= 60_000);
  assert.ok(DEFAULT_SAML_REQUEST_TTL_MS <= 15 * 60_000);
});
