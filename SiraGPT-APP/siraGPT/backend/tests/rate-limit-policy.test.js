/**
 * rate-limit-policy — verifies the env-var → config mapping for the
 * tiered rate limiter. Pins defaults (so a missing var doesn't drop
 * us back to the old `max: 10000` permissive cap) and pins the
 * "ignore garbage" behavior (so a typo doesn't accidentally widen
 * a bucket).
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveRateLimitConfig,
  FIFTEEN_MINUTES_MS,
} = require("../src/middleware/rate-limit-policy");

describe("resolveRateLimitConfig", () => {
  test("uses the documented defaults when no env vars are set", () => {
    const cfg = resolveRateLimitConfig({});
    assert.equal(cfg.windowMs, FIFTEEN_MINUTES_MS);
    assert.equal(cfg.auth, 30);
    assert.equal(cfg.expensive, 60);
    assert.equal(cfg.api, 1000);
  });

  test("honors valid integer env vars across all four knobs", () => {
    const cfg = resolveRateLimitConfig({
      RATE_LIMIT_WINDOW_MS: "60000",
      RATE_LIMIT_AUTH_MAX: "10",
      RATE_LIMIT_EXPENSIVE_MAX: "20",
      RATE_LIMIT_API_MAX: "500",
    });
    assert.deepEqual(cfg, {
      windowMs: 60000,
      auth: 10,
      expensive: 20,
      api: 500,
    });
  });

  test("falls back to defaults for non-numeric values (typo protection)", () => {
    const cfg = resolveRateLimitConfig({
      RATE_LIMIT_WINDOW_MS: "not-a-number",
      RATE_LIMIT_AUTH_MAX: "abc",
      RATE_LIMIT_EXPENSIVE_MAX: "",
      RATE_LIMIT_API_MAX: undefined,
    });
    assert.equal(cfg.windowMs, FIFTEEN_MINUTES_MS);
    assert.equal(cfg.auth, 30);
    assert.equal(cfg.expensive, 60);
    assert.equal(cfg.api, 1000);
  });

  test("rejects zero and negative values (a 0-cap would block all traffic, presumed unintended)", () => {
    const cfg = resolveRateLimitConfig({
      RATE_LIMIT_AUTH_MAX: "0",
      RATE_LIMIT_API_MAX: "-5",
    });
    assert.equal(cfg.auth, 30);
    assert.equal(cfg.api, 1000);
  });

  test("each tier resolves independently — partial config does not collapse other defaults", () => {
    const cfg = resolveRateLimitConfig({ RATE_LIMIT_AUTH_MAX: "5" });
    assert.equal(cfg.auth, 5);
    assert.equal(cfg.expensive, 60);
    assert.equal(cfg.api, 1000);
    assert.equal(cfg.windowMs, FIFTEEN_MINUTES_MS);
  });
});
