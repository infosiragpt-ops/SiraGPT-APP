/**
 * webauthn-challenge-store — pins the in-memory store contract.
 * The Redis-backed path uses the same interface and is exercised
 * end-to-end in the CI smoke when REDIS_URL is set; here we only
 * test the memory mode + a hand-rolled fake redis to cover the
 * factory's Redis branch without booting a real server.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createInMemoryStore,
  createRedisStore,
  createWebAuthnChallengeStore,
  DEFAULT_TTL_SECONDS,
} = require("../src/services/webauthn/webauthn-challenge-store");

describe("createInMemoryStore", () => {
  test("put then get returns the same challenge", async () => {
    const store = createInMemoryStore();
    await store.put("u1", "registration", "abc123");
    assert.equal(await store.get("u1", "registration"), "abc123");
  });

  test("get for a different flow returns null", async () => {
    const store = createInMemoryStore();
    await store.put("u1", "registration", "abc");
    assert.equal(await store.get("u1", "authentication"), null);
  });

  test("del removes the challenge", async () => {
    const store = createInMemoryStore();
    await store.put("u1", "registration", "abc");
    await store.del("u1", "registration");
    assert.equal(await store.get("u1", "registration"), null);
  });

  test("expired challenge returns null (TTL enforced)", async () => {
    let fakeTime = 1_000_000;
    const store = createInMemoryStore({ ttlSeconds: 60, now: () => fakeTime });
    await store.put("u1", "registration", "abc");
    // 30 s later — still valid
    fakeTime += 30 * 1000;
    assert.equal(await store.get("u1", "registration"), "abc");
    // 90 s later — expired
    fakeTime += 90 * 1000;
    assert.equal(await store.get("u1", "registration"), null);
  });

  test("lazy GC: expired entries are pruned on subsequent puts", async () => {
    let fakeTime = 1_000_000;
    const store = createInMemoryStore({ ttlSeconds: 60, now: () => fakeTime });
    await store.put("u1", "registration", "abc");
    await store.put("u2", "registration", "def");
    assert.equal(store._size(), 2);
    fakeTime += 200 * 1000;
    // Trigger GC by writing a new entry; old ones should have been pruned.
    await store.put("u3", "registration", "ghi");
    assert.equal(store._size(), 1);
  });

  test("DEFAULT_TTL_SECONDS is 5 minutes (matches the WebAuthn-spec rule of thumb)", () => {
    assert.equal(DEFAULT_TTL_SECONDS, 5 * 60);
  });
});

describe("createRedisStore", () => {
  function makeFakeRedis() {
    const store = new Map();
    const calls = [];
    return {
      async set(key, value, mode, ttlSeconds) {
        calls.push({ op: "set", key, value, mode, ttlSeconds });
        store.set(key, value);
      },
      async get(key) {
        calls.push({ op: "get", key });
        return store.has(key) ? store.get(key) : null;
      },
      async del(key) {
        calls.push({ op: "del", key });
        store.delete(key);
      },
      _calls: () => calls,
    };
  }

  test("put issues SET with EX <ttlSeconds>", async () => {
    const redis = makeFakeRedis();
    const store = createRedisStore({ redis, prefix: "wac:" });
    await store.put("u1", "registration", "abc");
    const [call] = redis._calls();
    assert.equal(call.op, "set");
    assert.equal(call.key, "wac:registration:u1");
    assert.equal(call.value, "abc");
    assert.equal(call.mode, "EX");
    assert.equal(call.ttlSeconds, DEFAULT_TTL_SECONDS);
  });

  test("get returns the stored value", async () => {
    const redis = makeFakeRedis();
    const store = createRedisStore({ redis });
    await store.put("u1", "registration", "abc");
    assert.equal(await store.get("u1", "registration"), "abc");
  });

  test("get returns null when redis throws (network blip degrades to expired)", async () => {
    const redis = {
      async set() {},
      async get() { throw new Error("ECONNRESET"); },
      async del() {},
    };
    const store = createRedisStore({ redis });
    assert.equal(await store.get("u1", "registration"), null);
  });

  test("del issues DEL", async () => {
    const redis = makeFakeRedis();
    const store = createRedisStore({ redis });
    await store.put("u1", "registration", "abc");
    await store.del("u1", "registration");
    // The fake redis records exactly two calls — the put (set) and
    // the del. Pull the second one rather than the third.
    const calls = redis._calls();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].op, "del");
    assert.equal(calls[1].key, "wac:registration:u1");
  });
});

describe("createWebAuthnChallengeStore — factory selection", () => {
  test("falls back to memory when REDIS_URL is not set", () => {
    const store = createWebAuthnChallengeStore({});
    assert.equal(store.mode, "memory");
  });

  test("uses memory when forceMemory:true (test seam)", () => {
    const store = createWebAuthnChallengeStore({ REDIS_URL: "redis://localhost:6379" }, { forceMemory: true });
    assert.equal(store.mode, "memory");
  });

  test("uses Redis when an injected client is provided", () => {
    const fakeRedis = { async set() {}, async get() { return null; }, async del() {} };
    const store = createWebAuthnChallengeStore({}, { redis: fakeRedis });
    assert.equal(store.mode, "redis");
  });
});
