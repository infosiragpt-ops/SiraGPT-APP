'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const IORedis = require('ioredis');
const jwt = require('jsonwebtoken');

const {
  OAUTH_STATE_REPLAYED_OR_EXPIRED,
  OAUTH_STATE_STORE_CAPACITY,
  OAUTH_STATE_STORE_UNAVAILABLE,
  createOAuthStateCodec,
  createOAuthStateStore,
  oauthStateRedisOptions,
  resolveOAuthStateTtlSeconds,
} = require('../src/services/auth/oauth-state-store');

const SECRET = 'oauth-state-distributed-test-secret-at-least-32-bytes';

function env(overrides = {}) {
  return {
    NODE_ENV: 'test',
    JWT_SECRET: SECRET,
    OAUTH_STATE_TTL: '10m',
    OAUTH_STATE_CACHE_MAX_ENTRIES: '100',
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

  async eval(script, numberOfKeys, ...args) {
    if (this.failCommands) throw new Error('redis command failed');
    this.calls.push({ command: 'eval', script, numberOfKeys, args });
    if (script.includes('auth-security-readiness-v1')) {
      assert.equal(numberOfKeys, 1);
      return 1;
    }
    assert.equal(numberOfKeys, 2);
    const [key, indexKey] = args;
    if (script.includes('oauth-state-issue-v1')) {
      const now = Number(args[2]);
      const ttlMs = Number(args[3]);
      const maxEntries = Number(args[4]);
      const value = String(args[5]);
      this._prune(indexKey, now);
      if (this.shared.values.has(key)) return 0;
      const index = this._index(indexKey);
      if (index.size >= maxEntries) return -1;
      this.shared.values.set(key, { value, expiresAt: now + ttlMs });
      index.set(key, now + ttlMs);
      return 1;
    }
    if (script.includes('oauth-state-consume-v1')) {
      const now = Number(args[2]);
      this._prune(indexKey, now);
      const entry = this.shared.values.get(key);
      if (!entry || entry.expiresAt <= now) return null;
      this.shared.values.delete(key);
      this._index(indexKey).delete(key);
      return entry.value;
    }
    throw new Error('unexpected lua script');
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

  _index(key) {
    if (!this.shared.indexes.has(key)) this.shared.indexes.set(key, new Map());
    return this.shared.indexes.get(key);
  }

  _prune(indexKey, now) {
    const index = this._index(indexKey);
    for (const [key, expiresAt] of index) {
      if (expiresAt <= now) {
        index.delete(key);
        this.shared.values.delete(key);
      }
    }
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

function sharedRedisState() {
  return { values: new Map(), indexes: new Map() };
}

function realishRedis({ failPing = false, failQuit = false } = {}) {
  const client = new IORedis({
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  client.status = 'ready';
  client.disconnectCalls = 0;
  client.ping = async () => {
    if (failPing) throw new Error('real-ish ping failed');
    return 'PONG';
  };
  client.eval = async () => 1;
  client.info = async () => [
    'used_memory:20',
    'maxmemory:100',
    'maxmemory_policy:noeviction',
  ].join('\r\n');
  client.quit = async () => {
    if (failQuit) throw new Error('real-ish quit failed');
    client.status = 'end';
    return 'OK';
  };
  client.disconnect = () => {
    client.disconnectCalls += 1;
    client.status = 'end';
  };
  return client;
}

function makeRedisPair({ clock = Date.now } = {}) {
  const shared = sharedRedisState();
  const storeA = createOAuthStateStore({
    env: env({ REDIS_URL: 'redis://oauth.test:6379' }),
    redis: new FakeRedis(shared),
    clock,
  });
  const storeB = createOAuthStateStore({
    env: env({ REDIS_URL: 'redis://oauth.test:6379' }),
    redis: new FakeRedis(shared),
    clock,
  });
  return { shared, storeA, storeB };
}

test('Redis client policy disables offline queue and bounds command latency', () => {
  const options = oauthStateRedisOptions(env({
    OAUTH_STATE_REDIS_CONNECT_TIMEOUT_MS: '321',
    OAUTH_STATE_REDIS_COMMAND_TIMEOUT_MS: '432',
  }));
  assert.equal(options.lazyConnect, true);
  assert.equal(options.enableOfflineQueue, false);
  assert.equal(options.maxRetriesPerRequest, 1);
  assert.equal(options.connectTimeout, 321);
  assert.equal(options.commandTimeout, 432);
});

test('OAuth state TTL is clamped to a short operational window', async () => {
  assert.equal(resolveOAuthStateTtlSeconds(env({ OAUTH_STATE_TTL: '1s' })), 60);
  assert.equal(resolveOAuthStateTtlSeconds(env({ OAUTH_STATE_TTL: '30d' })), 900);
  assert.equal(resolveOAuthStateTtlSeconds(env({ OAUTH_STATE_TTL: 'bogus' })), 600);

  for (const configuredTtl of ['1s', '30d']) {
    const configuredEnv = env({ OAUTH_STATE_TTL: configuredTtl });
    const store = createOAuthStateStore({ env: configuredEnv });
    const codec = createOAuthStateCodec({ env: configuredEnv, store });
    const token = await codec.issue({
      userId: `ttl-${configuredTtl}`,
      service: 'gmail',
      redirectUri: 'http://localhost:5000/oauth/callback',
    });
    const decoded = jwt.decode(token);
    assert.ok(decoded.exp - decoded.iat >= 60);
    assert.ok(decoded.exp - decoded.iat <= 900);
  }
});

test('every OAuth state JWT carries a fresh cryptographically random jti', async () => {
  const configuredEnv = env();
  const store = createOAuthStateStore({ env: configuredEnv });
  const codec = createOAuthStateCodec({ env: configuredEnv, store });
  const payload = {
    userId: 'jti-user',
    service: 'github',
    redirectUri: 'http://localhost:5000/api/github/callback',
  };

  const first = jwt.decode(await codec.issue(payload));
  const second = jwt.decode(await codec.issue(payload));

  assert.match(first.jti, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.match(second.jti, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(first.jti, second.jti);
});

test('production codec refuses insecure or localhost redirect bindings', async () => {
  const productionEnv = env({ NODE_ENV: 'production' });
  const localStore = createOAuthStateStore({ env: env() });
  const codec = createOAuthStateCodec({ env: productionEnv, store: localStore });

  for (const redirectUri of [
    'http://api.example.test/oauth/callback',
    'https://localhost/oauth/callback',
  ]) {
    await assert.rejects(
      codec.issue({ userId: 'secure-user', service: 'gmail', redirectUri }),
      (error) => error?.code === 'OAUTH_STATE_INPUT_INVALID',
    );
  }
});

test('production readiness validates Lua support, noeviction, and memory headroom', async () => {
  const redis = new FakeRedis(sharedRedisState(), {
    maxmemoryPolicy: 'noeviction',
    usedMemory: 40,
    maxmemory: 100,
  });
  const store = createOAuthStateStore({
    env: env({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://oauth.test:6379',
      AUTH_SECURITY_REDIS_MAX_MEMORY_RATIO: '0.9',
    }),
    redis,
  });

  await store.ready();

  assert.ok(redis.calls.some(
    (call) => call.command === 'eval' && call.script.includes('auth-security-readiness-v1'),
  ));
  assert.ok(redis.calls.some((call) => call.command === 'info'));
  assert.equal(store.health().redisPolicy, 'noeviction');
  assert.equal(store.health().memoryUtilization, 0.4);
  assert.equal(store.health().capacityOk, true);
});

test('production fails closed for an eviction policy or exhausted Redis capacity', async () => {
  for (const redis of [
    new FakeRedis(sharedRedisState(), { maxmemoryPolicy: 'allkeys-lru' }),
    new FakeRedis(sharedRedisState(), {
      maxmemoryPolicy: 'noeviction',
      usedMemory: 95,
      maxmemory: 100,
    }),
    new FakeRedis(sharedRedisState(), {
      maxmemoryPolicy: 'noeviction',
      usedMemory: 20,
      maxmemory: 0,
    }),
  ]) {
    const store = createOAuthStateStore({
      env: env({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://oauth.test:6379',
        AUTH_SECURITY_REDIS_MAX_MEMORY_RATIO: '0.9',
      }),
      redis,
    });
    await assert.rejects(
      store.ready(),
      (error) => error?.code === OAUTH_STATE_STORE_UNAVAILABLE,
    );
    assert.equal(store.health().ok, false);
    assert.equal(store.health().mode, 'unavailable');
  }
});

test('OAuth Lua keys use one Redis Cluster hash tag', async () => {
  const redis = new FakeRedis(sharedRedisState());
  const store = createOAuthStateStore({
    env: env({ REDIS_URL: 'redis://oauth.test:6379' }),
    redis,
  });

  await store.issue('jti-cluster-slot', '{"binding":true}', 60_000);
  await store.consume('jti-cluster-slot');

  const dataCalls = redis.calls.filter(
    (call) => call.command === 'eval' && !call.script.includes('auth-security-readiness-v1'),
  );
  assert.equal(dataCalls.length, 2);
  for (const call of dataCalls) {
    const keys = call.args.slice(0, call.numberOfKeys);
    const tags = keys.map((key) => String(key).match(/\{([^{}]+)\}/)?.[1]);
    assert.ok(tags.every(Boolean), `all Lua keys need a hash tag: ${keys.join(', ')}`);
    assert.equal(new Set(tags).size, 1, `Lua keys must share one hash slot: ${keys.join(', ')}`);
  }
});

test('Google login persists its browser-session binding before state issuance', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/routes/auth.js'),
    'utf8',
  );
  const routeStart = source.indexOf("router.get('/google'");
  const routeEnd = source.indexOf("router.get('/google/callback'", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const route = source.slice(routeStart, routeEnd);
  const persistAt = route.indexOf('persistGoogleLoginStateBinding(req)');
  const issueAt = route.indexOf('signOAuthState({');

  assert.ok(persistAt >= 0, 'issuer must make saveUninitialized=false persist the session');
  assert.ok(issueAt > persistAt, 'browser binding must be persisted before state is issued');
});

test('Google login callback sets an HttpOnly session cookie and redirects without a JWT URL', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/routes/auth.js'),
    'utf8',
  );
  const routeStart = source.indexOf("router.get('/google/callback'");
  const routeEnd = source.indexOf('// Gmail + Google-Services OAuth routes', routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const callback = source.slice(routeStart, routeEnd);

  assert.match(callback, /setSessionCookie\(\s*res\s*,\s*token\s*\)/);
  assert.match(callback, /getGooglePostCallbackURL\(\s*'success'\s*\)/);
  assert.doesNotMatch(callback, /[?&]token=\$\{token\}/);
  assert.ok(
    callback.indexOf('setSessionCookie(res, token)')
      < callback.indexOf("getGooglePostCallbackURL('success')"),
    'cookie must be set before the token-free redirect',
  );
});

test('provider routes centralize callback destinations and expose actionable state-store outages', () => {
  const authRoute = fs.readFileSync(
    path.resolve(__dirname, '../src/routes/auth.js'),
    'utf8',
  );
  const githubRoute = fs.readFileSync(
    path.resolve(__dirname, '../src/routes/github.js'),
    'utf8',
  );
  const spotifyRoute = fs.readFileSync(
    path.resolve(__dirname, '../src/routes/spotify.js'),
    'utf8',
  );
  const spotifyService = fs.readFileSync(
    path.resolve(__dirname, '../src/services/spotify-mcp.js'),
    'utf8',
  );

  assert.match(authRoute, /sendOAuthStateUnavailable/);
  assert.match(githubRoute, /sendOAuthStateUnavailable/);
  assert.match(spotifyRoute, /sendOAuthStateUnavailable/);
  assert.match(spotifyRoute, /getSpotifyPostCallbackURL/);
  assert.doesNotMatch(spotifyRoute, /http:\/\/localhost:3000/);
  assert.match(spotifyService, /getSpotifyCallbackURL/);
  assert.doesNotMatch(spotifyService, /process\.env\.SPOTIFY_REDIRECT_URI/);
});

test('all OAuth providers consume state across replicas exactly once', async () => {
  const { storeA, storeB } = makeRedisPair();
  const issuer = createOAuthStateCodec({ env: env(), store: storeA });
  const callback = createOAuthStateCodec({ env: env(), store: storeB });
  const providers = ['google', 'gmail', 'google_services', 'spotify', 'github'];

  for (const service of providers) {
    const redirectUri = `https://api.example.test/oauth/${service}/callback`;
    const state = await issuer.issue({
      userId: `user-${service}`,
      service,
      redirectUri,
    });
    const claims = await callback.consume(state, { service, redirectUri });
    assert.deepEqual(claims, {
      userId: `user-${service}`,
      service,
      redirectUri,
    });
    await assert.rejects(
      issuer.consume(state, { service, redirectUri }),
      (error) => error?.code === OAUTH_STATE_REPLAYED_OR_EXPIRED,
    );
  }
});

test('concurrent callbacks across replicas have one winner', async () => {
  const { storeA, storeB } = makeRedisPair();
  const issuer = createOAuthStateCodec({ env: env(), store: storeA });
  const callbackA = createOAuthStateCodec({ env: env(), store: storeA });
  const callbackB = createOAuthStateCodec({ env: env(), store: storeB });
  const redirectUri = 'https://api.example.test/oauth/gmail/callback';
  const state = await issuer.issue({ userId: 'u-race', service: 'gmail', redirectUri });

  const settled = await Promise.allSettled([
    callbackA.consume(state, { service: 'gmail', redirectUri }),
    callbackB.consume(state, { service: 'gmail', redirectUri }),
  ]);
  assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = settled.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, OAUTH_STATE_REPLAYED_OR_EXPIRED);
});

test('state is bound to provider, user, and redirect and mismatch consumes it', async () => {
  const { storeA } = makeRedisPair();
  const codec = createOAuthStateCodec({ env: env(), store: storeA });

  for (const [expected, field] of [
    [{ service: 'spotify', redirectUri: 'https://api.example.test/cb' }, 'provider'],
    [{ service: 'gmail', userId: 'other', redirectUri: 'https://api.example.test/cb' }, 'user'],
    [{ service: 'gmail', redirectUri: 'https://evil.example.test/cb' }, 'redirect'],
  ]) {
    const state = await codec.issue({
      userId: 'bound-user',
      service: 'gmail',
      redirectUri: 'https://api.example.test/cb',
    });
    await assert.rejects(
      codec.consume(state, expected),
      (error) => error?.code === 'OAUTH_STATE_BINDING_INVALID',
      `${field} mismatch must fail`,
    );
    await assert.rejects(
      codec.consume(state, {
        userId: 'bound-user',
        service: 'gmail',
        redirectUri: 'https://api.example.test/cb',
      }),
      (error) => error?.code === OAUTH_STATE_REPLAYED_OR_EXPIRED,
      `${field} mismatch must still burn the one-time state`,
    );
  }
});

test('store TTL expiry is enforced even while the signed JWT remains valid', async () => {
  let now = Date.now();
  const { storeA, storeB } = makeRedisPair({ clock: () => now });
  const issuer = createOAuthStateCodec({ env: env(), store: storeA, clock: () => now });
  const callback = createOAuthStateCodec({ env: env(), store: storeB, clock: () => now });
  const redirectUri = 'https://api.example.test/oauth/spotify/callback';
  const state = await issuer.issue({ userId: 'u-exp', service: 'spotify', redirectUri });

  now += 10 * 60 * 1000 + 1;
  await assert.rejects(
    callback.consume(state, { service: 'spotify', redirectUri }),
    (error) => error?.code === OAUTH_STATE_REPLAYED_OR_EXPIRED,
  );
});

test('production fails closed when Redis is absent or unavailable', async () => {
  const productionEnv = env({ NODE_ENV: 'production' });
  const noRedis = createOAuthStateStore({ env: productionEnv });
  const noRedisCodec = createOAuthStateCodec({ env: productionEnv, store: noRedis });
  await assert.rejects(
    noRedisCodec.issue({
      userId: 'u-prod',
      service: 'google',
      redirectUri: 'https://api.example.test/oauth/google/callback',
    }),
    (error) => error?.code === OAUTH_STATE_STORE_UNAVAILABLE,
  );

  const downStore = createOAuthStateStore({
    env: env({ NODE_ENV: 'production', REDIS_URL: 'redis://down.test:6379' }),
    redis: new FakeRedis(sharedRedisState(), { failPing: true }),
  });
  const downCodec = createOAuthStateCodec({ env: productionEnv, store: downStore });
  await assert.rejects(
    downCodec.issue({
      userId: 'u-prod',
      service: 'google',
      redirectUri: 'https://api.example.test/oauth/google/callback',
    }),
    (error) => error?.code === OAUTH_STATE_STORE_UNAVAILABLE,
  );
});

test('non-production fallback is in-memory and hard bounded', async () => {
  const fallbackEnv = env({ OAUTH_STATE_CACHE_MAX_ENTRIES: '2' });
  const store = createOAuthStateStore({ env: fallbackEnv });
  const codec = createOAuthStateCodec({ env: fallbackEnv, store });
  const redirectUri = 'http://localhost:5000/callback';

  await codec.issue({ userId: 'u1', service: 'gmail', redirectUri });
  await codec.issue({ userId: 'u2', service: 'gmail', redirectUri });
  await assert.rejects(
    codec.issue({ userId: 'u3', service: 'gmail', redirectUri }),
    (error) => error?.code === OAUTH_STATE_STORE_CAPACITY,
  );
  assert.equal(store.health().mode, 'memory');
  assert.equal(store.health().localEntries, 2);
});

test('lifecycle exposes safe config and closes owned Redis clients', async () => {
  const shared = sharedRedisState();
  const redis = new FakeRedis(shared);
  const configured = env({
    REDIS_URL: 'redis://user:super-secret@redis.internal:6379/2',
    OAUTH_STATE_REDIS_PREFIX: 'custom:oauth:',
  });
  const store = createOAuthStateStore({
    env: configured,
    createRedis: () => redis,
  });
  await store.ready();
  const config = store.config();
  assert.equal(config.redisConfigured, true);
  assert.equal(config.redisPrefix, 'custom:oauth:');
  assert.equal(JSON.stringify(config).includes('super-secret'), false);
  assert.equal(store.health().distributed, true);
  await store.close();
  assert.equal(redis.closed, true);
  assert.equal(store.health().mode, 'closed');
});

test('close marks the OAuth store closed and surfaces Redis shutdown failures', async () => {
  const redis = new FakeRedis(sharedRedisState(), { failQuit: true });
  const store = createOAuthStateStore({
    env: env({ REDIS_URL: 'redis://oauth.test:6379' }),
    createRedis: () => redis,
  });
  await store.ready();

  await assert.rejects(store.close(), /redis quit failed|OAUTH_STATE_STORE_CLOSE_FAILED/);
  assert.equal(redis.disconnectCalls, 1);
  assert.equal(store.health().mode, 'closed');
});

test('readiness replaces an owned ioredis client after ping and quit both fail', async () => {
  const first = realishRedis({ failPing: true, failQuit: true });
  const second = realishRedis();
  const created = [];
  const store = createOAuthStateStore({
    env: env({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://oauth.test:6379',
    }),
    createRedis() {
      const client = created.length === 0 ? first : second;
      created.push(client);
      return client;
    },
  });

  await assert.rejects(
    store.ready(),
    (error) => error?.code === OAUTH_STATE_STORE_UNAVAILABLE,
  );
  assert.equal(first.disconnectCalls, 1, 'failed quit must force-disconnect the owned client');
  assert.equal(store.health().mode, 'unavailable');

  await store.ready();
  assert.equal(created.length, 2, 'retry must construct a fresh owned ioredis client');
  assert.equal(store.health().mode, 'redis');
  await store.close();
});

test('closing an OAuth store never destroys an externally injected Redis client', async () => {
  const redis = new FakeRedis(sharedRedisState());
  const store = createOAuthStateStore({
    env: env({ REDIS_URL: 'redis://oauth.test:6379' }),
    redis,
  });

  await store.ready();
  await store.close();

  assert.equal(redis.quitCalls, 0);
  assert.equal(redis.disconnectCalls, 0);
  assert.equal(redis.closed, false);
});
