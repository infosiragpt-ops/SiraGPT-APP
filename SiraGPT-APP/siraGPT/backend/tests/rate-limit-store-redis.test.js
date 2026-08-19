"use strict";

/**
 * rate-limit-store-redis.test.js
 *
 * Tests the `consume(key, limit, windowMs)` API of rate-limit-store
 * against a mocked ioredis client (sliding-window ZSET algorithm) and
 * the in-memory fallback path.
 */

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const store = require("../src/middleware/rate-limit-store");

/**
 * MockRedis — implements just enough of ioredis to drive the sliding
 * window pipeline used by `consume()`.
 *
 *   multi() returns a chainable pipeline whose .exec() resolves to an
 *   array of `[err, reply]` tuples (the ioredis contract).
 */
class MockRedis {
  constructor({ failOn } = {}) {
    this.zsets = new Map();
    this.failOn = failOn || null; // 'exec' to simulate Redis outage
    this.calls = [];
  }
  _get(key) {
    if (!this.zsets.has(key)) this.zsets.set(key, []);
    return this.zsets.get(key);
  }
  multi() {
    const ops = [];
    const chain = {
      zremrangebyscore: (k, min, max) => {
        ops.push(() => {
          const set = this._get(k);
          const remaining = set.filter((entry) =>
            entry.score > max && entry.score < (min === "-inf" ? Infinity : min)
              ? false
              : !(entry.score >= (min === "-inf" ? -Infinity : min) && entry.score <= max),
          );
          this.zsets.set(k, remaining);
          return [null, set.length - remaining.length];
        });
        return chain;
      },
      zadd: (k, score, member) => {
        ops.push(() => {
          const set = this._get(k);
          set.push({ score, member });
          set.sort((a, b) => a.score - b.score);
          return [null, 1];
        });
        return chain;
      },
      zcard: (k) => {
        ops.push(() => [null, this._get(k).length]);
        return chain;
      },
      pexpire: (_k, _ms) => {
        ops.push(() => [null, 1]);
        return chain;
      },
      exec: async () => {
        this.calls.push("exec");
        if (this.failOn === "exec") throw new Error("redis_down");
        return ops.map((fn) => fn());
      },
    };
    return chain;
  }
  async zrem(k, member) {
    const set = this._get(k);
    const idx = set.findIndex((e) => e.member === member);
    if (idx >= 0) set.splice(idx, 1);
    return idx >= 0 ? 1 : 0;
  }
  async zrange(k, start, stop, withScores) {
    const set = this._get(k);
    const slice = set.slice(start, stop + 1);
    if (withScores === "WITHSCORES") {
      const out = [];
      for (const e of slice) {
        out.push(e.member, String(e.score));
      }
      return out;
    }
    return slice.map((e) => e.member);
  }
}

beforeEach(() => {
  store._resetForTests();
});

test("consume: allows requests up to the limit, then denies", async () => {
  const redis = new MockRedis();
  const env = { REDIS_URL: "redis://mock" };
  const key = "test:user:1";

  const a = await store.consume(key, 3, 60_000, { env, redis });
  assert.equal(a.allowed, true);
  assert.equal(a.remaining, 2);
  assert.ok(a.resetAt instanceof Date);

  const b = await store.consume(key, 3, 60_000, { env, redis });
  assert.equal(b.allowed, true);
  assert.equal(b.remaining, 1);

  const c = await store.consume(key, 3, 60_000, { env, redis });
  assert.equal(c.allowed, true);
  assert.equal(c.remaining, 0);

  const d = await store.consume(key, 3, 60_000, { env, redis });
  assert.equal(d.allowed, false);
  assert.equal(d.remaining, 0);
  assert.ok(d.resetAt instanceof Date);
});

test("consume: distinct keys have independent counters", async () => {
  const redis = new MockRedis();
  const env = { REDIS_URL: "redis://mock" };
  const a = await store.consume("user:a", 1, 60_000, { env, redis });
  const b = await store.consume("user:b", 1, 60_000, { env, redis });
  assert.equal(a.allowed, true);
  assert.equal(b.allowed, true);
  const a2 = await store.consume("user:a", 1, 60_000, { env, redis });
  assert.equal(a2.allowed, false);
});

test("consume: falls back to in-memory when Redis pipeline throws", async () => {
  const redis = new MockRedis({ failOn: "exec" });
  const env = { REDIS_URL: "redis://mock" };
  const key = "test:fallback:1";
  const r1 = await store.consume(key, 2, 60_000, { env, redis });
  assert.equal(r1.allowed, true);
  assert.equal(r1.remaining, 1);
  // second call: fallback breaker is now active, so we go straight to memory
  const r2 = await store.consume(key, 2, 60_000, { env, redis });
  assert.equal(r2.allowed, true);
  assert.equal(r2.remaining, 0);
  const r3 = await store.consume(key, 2, 60_000, { env, redis });
  assert.equal(r3.allowed, false);
});

test("consume: uses memory store when REDIS_URL is unset", async () => {
  const env = {}; // no REDIS_URL
  const key = "noredis:user:1";
  const r1 = await store.consume(key, 1, 60_000, { env });
  assert.equal(r1.allowed, true);
  const r2 = await store.consume(key, 1, 60_000, { env });
  assert.equal(r2.allowed, false);
});

test("consume: RATE_LIMIT_STORE=memory forces in-memory even with REDIS_URL", async () => {
  const redis = new MockRedis();
  const env = { REDIS_URL: "redis://mock", RATE_LIMIT_STORE: "memory" };
  // Memory only — never touches redis mock.
  await store.consume("forced:1", 5, 60_000, { env, redis });
  assert.equal(redis.calls.length, 0);
});

test("consume: rejects invalid arguments", async () => {
  await assert.rejects(() => store.consume("", 5, 60_000), /non-empty string/);
  await assert.rejects(() => store.consume("x".repeat(store.MAX_CONSUME_KEY_LENGTH + 1), 5, 60_000), /at most/);
  await assert.rejects(() => store.consume("bad\nkey", 5, 60_000), /control characters/);
  await assert.rejects(() => store.consume("k", 0, 60_000), /positive number/);
  await assert.rejects(() => store.consume("k", 5, 0), /positive number/);
});

test("consume: memory fallback enforces max key cap", async () => {
  const env = { RATE_LIMIT_STORE: "memory" };
  await store.consume("mem:1", 5, 60_000, { env, maxFallbackKeys: 2 });
  await store.consume("mem:2", 5, 60_000, { env, maxFallbackKeys: 2 });
  await store.consume("mem:3", 5, 60_000, { env, maxFallbackKeys: 2 });
  assert.equal(store._fallbackSize(), 2);
  const r = await store.consume("mem:1", 5, 60_000, { env, maxFallbackKeys: 2 });
  assert.equal(r.allowed, true, "oldest key should have been evicted and start fresh");
  assert.equal(r.remaining, 4);
});

test("consume: sliding window expires old entries via ZREMRANGEBYSCORE", async () => {
  const redis = new MockRedis();
  const env = { REDIS_URL: "redis://mock" };
  const key = "slide:1";
  // Use a manual clock to simulate the passage of time
  let now = 1_000_000;
  await store.consume(key, 2, 100, { env, redis, now: () => now });
  await store.consume(key, 2, 100, { env, redis, now: () => now });
  const denied = await store.consume(key, 2, 100, { env, redis, now: () => now });
  assert.equal(denied.allowed, false);
  // Advance past window
  now += 200;
  const allowed = await store.consume(key, 2, 100, { env, redis, now: () => now });
  assert.equal(allowed.allowed, true);
});

test("consume: shouldUseRedis honors RATE_LIMIT_STORE=redis without URL", () => {
  // Without REDIS_URL set, even explicit RATE_LIMIT_STORE=redis falls back.
  assert.equal(store.shouldUseRedis({ RATE_LIMIT_STORE: "redis" }), false);
  assert.equal(store.shouldUseRedis({ RATE_LIMIT_STORE: "redis", REDIS_URL: "x" }), true);
  assert.equal(store.shouldUseRedis({ RATE_LIMIT_STORE: "memory", REDIS_URL: "x" }), false);
  assert.equal(store.shouldUseRedis({ REDIS_URL: "x" }), true);
  assert.equal(store.shouldUseRedis({}), false);
});
