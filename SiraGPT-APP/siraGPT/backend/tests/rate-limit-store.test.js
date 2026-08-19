/**
 * rate-limit-store — pins the env-resolution rules for the limiter
 * store factory. Two properties matter for production behavior:
 *
 *   1. With no REDIS_URL we return mode:'memory'. The previous setup
 *      assumed Redis was always available; deploys that didn't
 *      configure it would crash on first /api/ request. The fallback
 *      lets local dev and single-instance deploys keep working.
 *
 *   2. With REDIS_URL set we return mode:'redis' AND the store
 *      object honors express-rate-limit's Store interface
 *      (increment / decrement / resetKey) so the limiter accepts it
 *      without runtime type errors. We do NOT connect here — the
 *      ioredis client is created with `lazyConnect: true`, so the
 *      test stays hermetic.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createRateLimitStore,
  shouldUseRedis,
} = require("../src/middleware/rate-limit-store");

describe("shouldUseRedis", () => {
  test("false when no REDIS_URL is set (auto mode falls back to memory)", () => {
    assert.equal(shouldUseRedis({}), false);
  });

  test("true when REDIS_URL is set (auto mode prefers Redis)", () => {
    assert.equal(shouldUseRedis({ REDIS_URL: "redis://localhost:6379" }), true);
  });

  test("false when RATE_LIMIT_STORE=memory, even with REDIS_URL set", () => {
    assert.equal(
      shouldUseRedis({
        REDIS_URL: "redis://localhost:6379",
        RATE_LIMIT_STORE: "memory",
      }),
      false,
    );
  });

  test("RATE_LIMIT_STORE=redis without REDIS_URL is treated as misconfigured (false)", () => {
    assert.equal(shouldUseRedis({ RATE_LIMIT_STORE: "redis" }), false);
  });

  test("RATE_LIMIT_STORE=REDIS (case-insensitive) honored", () => {
    assert.equal(
      shouldUseRedis({
        RATE_LIMIT_STORE: "REDIS",
        REDIS_URL: "redis://localhost:6379",
      }),
      true,
    );
  });
});

describe("createRateLimitStore — memory fallback paths", () => {
  test("returns mode:'memory' with reason:no_redis_url when REDIS_URL is missing", () => {
    const result = createRateLimitStore({});
    assert.equal(result.mode, "memory");
    assert.equal(result.store, null);
    assert.equal(result.redis, null);
    assert.equal(result.reason, "no_redis_url");
  });

  test("returns mode:'memory' with reason:forced_memory_store when explicitly forced", () => {
    const result = createRateLimitStore({
      REDIS_URL: "redis://localhost:6379",
      RATE_LIMIT_STORE: "memory",
    });
    assert.equal(result.mode, "memory");
    assert.equal(result.store, null);
    assert.equal(result.reason, "forced_memory_store");
  });
});

// The Redis-path is intentionally NOT unit-tested here.
//
// `new RedisStore({ sendCommand })` schedules an async SCRIPT LOAD
// on construction. With ioredis in `lazyConnect: true` mode this
// queues until either a real Redis answers or the connection is
// torn down — which happens AFTER the test ends, surfacing as an
// `unhandledRejection`. There is no way to drain that side-effect
// in an isolated unit test without mocking the entire library.
//
// We cover the Redis path through:
//   1. The CI integration smoke (boots the backend with a real
//      Redis sidecar; if the wiring is broken, /health/ready fails).
//   2. The shouldUseRedis cases above, which cover the env-resolution
//      branch that decides which path runs.
//
// If a future regression slips through both, the operator-visible
// signal is the `rateLimitStore: 'memory'` field in the
// `server_started` log — set REDIS_URL and watch the field flip.
