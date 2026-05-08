/**
 * posthog-config — pins the env-var → config resolution and the
 * "no-op when disabled" contract for the backend PostHog wrapper.
 * Mirrors langfuse-config.test.js: we don't exercise the real SDK
 * because that would require a live PostHog endpoint and pollute
 * other tests via the module's singleton state.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolvePostHogConfig,
  getPostHogStatus,
  startPostHog,
  capturePostHogEvent,
  shutdownPostHog,
  getPostHogClient,
} = require("../src/services/observability/posthog");

describe("resolvePostHogConfig", () => {
  test("disabled when POSTHOG_API_KEY is missing", () => {
    const cfg = resolvePostHogConfig({});
    assert.equal(cfg.configured, false);
    assert.equal(cfg.requested, false);
    assert.equal(cfg.enabled, false);
  });

  test("auto-enables when POSTHOG_API_KEY is set", () => {
    const cfg = resolvePostHogConfig({ POSTHOG_API_KEY: "phc_test" });
    assert.equal(cfg.configured, true);
    assert.equal(cfg.requested, true);
    assert.equal(cfg.enabled, true);
    // Default points at PostHog Cloud US — operators set POSTHOG_HOST
    // for EU cloud or self-hosted deploys.
    assert.equal(cfg.host, "https://us.i.posthog.com");
  });

  test("POSTHOG_PROJECT_API_KEY is honored as an alias", () => {
    const cfg = resolvePostHogConfig({ POSTHOG_PROJECT_API_KEY: "phc_alias" });
    assert.equal(cfg.configured, true);
    assert.equal(cfg.apiKey, "phc_alias");
  });

  test("POSTHOG_ENABLED=false explicitly disables even with key", () => {
    const cfg = resolvePostHogConfig({
      POSTHOG_API_KEY: "phc_test",
      POSTHOG_ENABLED: "false",
    });
    assert.equal(cfg.configured, true);
    assert.equal(cfg.requested, false);
    assert.equal(cfg.enabled, false);
  });

  test("POSTHOG_ENABLED=true records intent even when key is missing", () => {
    const cfg = resolvePostHogConfig({ POSTHOG_ENABLED: "true" });
    assert.equal(cfg.configured, false);
    assert.equal(cfg.requested, true);
    assert.equal(cfg.enabled, false);
  });

  test("POSTHOG_HOST overrides the cloud default (self-host path)", () => {
    const cfg = resolvePostHogConfig({
      POSTHOG_API_KEY: "phc_test",
      POSTHOG_HOST: "https://posthog.internal.example.com",
    });
    assert.equal(cfg.host, "https://posthog.internal.example.com");
  });

  test("flush settings fall back to documented defaults on garbage input", () => {
    const cfg = resolvePostHogConfig({
      POSTHOG_FLUSH_AT: "abc",
      POSTHOG_FLUSH_INTERVAL_MS: "",
    });
    assert.equal(cfg.flushAt, 20);
    assert.equal(cfg.flushInterval, 10_000);
  });
});

describe("startPostHog — no-op safety when disabled", () => {
  test("startPostHog with empty env reports missing_api_key, no client created", () => {
    const status = startPostHog({});
    assert.equal(status.enabled, false);
    assert.equal(status.started, true);
    assert.equal(getPostHogClient(), null);
    assert.match(status.reason, /missing_api_key|disabled_by_env|not_started/);
  });

  test("capturePostHogEvent is a no-op (returns false) when no client", () => {
    const result = capturePostHogEvent({
      distinctId: "u-1",
      event: "test.event",
      properties: { foo: "bar" },
    });
    assert.equal(result, false);
  });

  test("capturePostHogEvent rejects calls with missing distinctId / event even if client were present", () => {
    assert.equal(capturePostHogEvent({}), false);
    assert.equal(capturePostHogEvent({ distinctId: "u-1" }), false);
    assert.equal(capturePostHogEvent({ event: "x" }), false);
  });

  test("shutdownPostHog is safe to call when client is null", async () => {
    await assert.doesNotReject(() => shutdownPostHog());
  });

  test("getPostHogStatus returns a defensive shallow copy", () => {
    const a = getPostHogStatus();
    a.enabled = true;
    a.reason = "MUTATED";
    const b = getPostHogStatus();
    assert.notEqual(b.reason, "MUTATED");
  });
});
