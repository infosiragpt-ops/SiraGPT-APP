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
  validateAllowedOrigins,
  DEV_FALLBACK,
  PROD_FALLBACK,
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

  test("returns the prod fallback origins when CORS_ORIGINS is empty in production (with WARN)", () => {
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      const result = resolveAllowedOrigins({ NODE_ENV: "production" });
      // PROD_FALLBACK was introduced cycle 9; the previous fail-closed
      // behaviour is replaced by safe-default origins + a loud WARN.
      assert.deepEqual(result, PROD_FALLBACK);
      assert.ok(result.some((o) => o.startsWith("https://siragpt")));
      assert.equal(result.some((o) => o.startsWith("http://localhost")), false);
      assert.equal(result.some((o) => o.startsWith("http://127.0.0.1")), false);
      assert.equal(result.every((o) => o.startsWith("https://")), true);
      assert.ok(warnings.some((line) => line.includes("CORS_ORIGINS env var is unset")));
    } finally {
      console.warn = originalWarn;
    }
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

  test("merges CODEX_PREVIEW_ORIGIN so generated apps' module fetches pass CORS", () => {
    // A codex preview app fetches @vite/client / main.tsx with Origin equal to
    // the preview origin; without this the strict callback 500s and the app
    // stays blank. Present with an explicit list AND with the prod fallback,
    // trailing slash trimmed.
    const withList = resolveAllowedOrigins({
      CORS_ORIGINS: "https://app.example.com",
      CODEX_PREVIEW_ORIGIN: "https://preview.example.com/",
    });
    assert.ok(withList.includes("https://preview.example.com"));

    const withFallback = resolveAllowedOrigins({
      NODE_ENV: "production",
      CODEX_PREVIEW_ORIGIN: "https://preview.example.com",
    });
    assert.ok(withFallback.includes("https://preview.example.com"));

    // A non-https value is ignored (never widens the allowlist).
    const ignored = resolveAllowedOrigins({
      CORS_ORIGINS: "https://a.com",
      CODEX_PREVIEW_ORIGIN: "not-a-url",
    });
    assert.deepEqual(ignored, ["https://a.com"]);
  });
});

describe("validateAllowedOrigins", () => {
  test("accepts well-formed http/https origins and wildcard", () => {
    const list = ["https://a.com", "http://localhost:3000", "*"];
    assert.deepEqual(validateAllowedOrigins(list), list);
  });

  test("normalizes trailing slashes and deduplicates origins", () => {
    assert.deepEqual(
      validateAllowedOrigins(["https://a.com/", "https://a.com", "https://b.com:443/"]),
      ["https://a.com", "https://b.com"],
    );
  });

  test("throws on garbage non-URL entry", () => {
    assert.throws(
      () => validateAllowedOrigins(["not a url"]),
      /Invalid CORS_ORIGINS entry/
    );
  });

  test("throws on disallowed protocol", () => {
    assert.throws(
      () => validateAllowedOrigins(["ftp://files.example.com"]),
      /only http:\/\/ or https:\/\/ allowed/
    );
  });

  test("throws when origin contains a path", () => {
    assert.throws(
      () => validateAllowedOrigins(["https://a.com/app"]),
      /must be bare origin without path/
    );
  });

  test("throws when origin contains query, hash, or credentials", () => {
    assert.throws(
      () => validateAllowedOrigins(["https://a.com?debug=1"]),
      /without query or hash/
    );
    assert.throws(
      () => validateAllowedOrigins(["https://a.com#fragment"]),
      /without query or hash/
    );
    assert.throws(
      () => validateAllowedOrigins(["https://user:pass@a.com"]),
      /credentials are not allowed/
    );
  });

  test("resolveAllowedOrigins propagates validation error", () => {
    assert.throws(
      () => resolveAllowedOrigins({ CORS_ORIGINS: "https://ok.com, garbage" }),
      /Invalid CORS_ORIGINS entry "garbage"/
    );
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
