/**
 * cors-policy — verifies the allowlist resolver and the per-request
 * origin callback. The previous CORS config silently allowed every
 * origin via `callback(null, true)`; this test pins the new fail-
 * closed-in-production semantics so a future edit cannot regress.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveAllowedOrigins,
  makeOriginCallback,
  DEV_FALLBACK,
} = require("../src/middleware/cors-policy");

describe("resolveAllowedOrigins", () => {
  test("parses comma-separated CORS_ORIGINS and trims whitespace", () => {
    const result = resolveAllowedOrigins({
      CORS_ORIGINS: "https://a.example.com, https://b.example.com ,",
    });
    assert.deepEqual(result, ["https://a.example.com", "https://b.example.com"]);
  });

  test("returns the dev localhost fallback when CORS_ORIGINS is empty in development", () => {
    const result = resolveAllowedOrigins({ NODE_ENV: "development" });
    assert.deepEqual(result, DEV_FALLBACK);
    assert.ok(result.includes("http://localhost:3000"));
    assert.ok(result.includes("http://127.0.0.1:3000"));
    assert.notEqual(result, DEV_FALLBACK, "must be a copy, not a reference");
  });

  test("returns an empty list in production when CORS_ORIGINS is empty (fail closed)", () => {
    const result = resolveAllowedOrigins({ NODE_ENV: "production" });
    assert.deepEqual(result, []);
  });

  test("respects CORS_ORIGINS in production", () => {
    const result = resolveAllowedOrigins({
      NODE_ENV: "production",
      CORS_ORIGINS: "https://app.example.com",
    });
    assert.deepEqual(result, ["https://app.example.com"]);
  });

  test("ignores empty / whitespace-only entries", () => {
    const result = resolveAllowedOrigins({
      CORS_ORIGINS: "   , https://a.com,, , https://b.com",
    });
    assert.deepEqual(result, ["https://a.com", "https://b.com"]);
  });
});

describe("makeOriginCallback", () => {
  // Helper: turn the (origin, cb) → cb(err, allow) callback into a
  // promise so individual cases are easier to read.
  function decide(callback, origin) {
    return new Promise((resolve) => {
      callback(origin, (err, allow) => resolve({ err, allow }));
    });
  }

  test("allows requests with no Origin header (server-to-server, curl)", async () => {
    const cb = makeOriginCallback(["https://app.example.com"]);
    const { err, allow } = await decide(cb, undefined);
    assert.equal(err, null);
    assert.equal(allow, true);
  });

  test("allows an origin in the allowlist", async () => {
    const cb = makeOriginCallback([
      "https://app.example.com",
      "http://localhost:3000",
    ]);
    const { err, allow } = await decide(cb, "https://app.example.com");
    assert.equal(err, null);
    assert.equal(allow, true);
  });

  test("explicit wildcard allows every browser origin", async () => {
    const cb = makeOriginCallback(["*"]);
    const { err, allow } = await decide(cb, "http://localhost:3000");
    assert.equal(err, null);
    assert.equal(allow, true);
  });

  test("rejects an origin not in the allowlist", async () => {
    const cb = makeOriginCallback(["https://app.example.com"]);
    const { err } = await decide(cb, "https://evil.example.com");
    assert.ok(err instanceof Error);
    assert.match(err.message, /CORS: origin not allowed \(https:\/\/evil\.example\.com\)/);
  });

  test("empty allowlist rejects every browser request but still allows server-to-server", async () => {
    const cb = makeOriginCallback([]);
    const browserResult = await decide(cb, "https://app.example.com");
    assert.ok(browserResult.err instanceof Error);

    const s2sResult = await decide(cb, undefined);
    assert.equal(s2sResult.err, null);
    assert.equal(s2sResult.allow, true);
  });

  test("Origin matching is exact — http vs https and trailing slashes do not match", async () => {
    const cb = makeOriginCallback(["https://app.example.com"]);
    const httpResult = await decide(cb, "http://app.example.com");
    assert.ok(httpResult.err instanceof Error, "http should not match https");
    const trailingResult = await decide(cb, "https://app.example.com/");
    assert.ok(trailingResult.err instanceof Error, "trailing slash should not match");
  });
});
