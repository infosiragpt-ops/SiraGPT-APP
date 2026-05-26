/**
 * langfuse-config — pins the env-var → config resolution and the
 * "no-op when disabled" contract. The actual SDK calls are not
 * exercised here (they would require a live Langfuse server); instead
 * we verify that the wrapper degrades safely when keys are missing
 * and that the config defaults match what's documented in
 * `.env.example`.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveLangfuseConfig,
  getLangfuseStatus,
  startLangfuse,
  traceLLMGeneration,
  shutdownLangfuse,
  getLangfuseClient,
} = require("../src/services/observability/langfuse");

describe("resolveLangfuseConfig", () => {
  test("disabled when no keys are present", () => {
    const cfg = resolveLangfuseConfig({});
    assert.equal(cfg.configured, false);
    assert.equal(cfg.requested, false);
    assert.equal(cfg.enabled, false);
  });

  test("auto-enables when both LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set", () => {
    const cfg = resolveLangfuseConfig({
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-test",
    });
    assert.equal(cfg.configured, true);
    assert.equal(cfg.requested, true);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.baseUrl, "https://cloud.langfuse.com");
  });

  test("LANGFUSE_ENABLED=false explicitly disables even when keys are set", () => {
    const cfg = resolveLangfuseConfig({
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-test",
      LANGFUSE_ENABLED: "false",
    });
    assert.equal(cfg.configured, true);
    assert.equal(cfg.requested, false);
    assert.equal(cfg.enabled, false);
  });

  test("LANGFUSE_ENABLED=true records intent even when keys are incomplete", () => {
    const cfg = resolveLangfuseConfig({
      LANGFUSE_ENABLED: "true",
      LANGFUSE_PUBLIC_KEY: "pk-test",
    });
    assert.equal(cfg.configured, false);
    assert.equal(cfg.requested, true);
    assert.equal(cfg.enabled, false);
  });

  test("having only one of the two keys is not configured", () => {
    const onlyPublic = resolveLangfuseConfig({ LANGFUSE_PUBLIC_KEY: "pk-x" });
    assert.equal(onlyPublic.configured, false);
    const onlySecret = resolveLangfuseConfig({ LANGFUSE_SECRET_KEY: "sk-x" });
    assert.equal(onlySecret.configured, false);
  });

  test("LANGFUSE_HOST overrides the cloud default", () => {
    const cfg = resolveLangfuseConfig({
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-test",
      LANGFUSE_HOST: "https://langfuse.internal.example.com",
    });
    assert.equal(cfg.baseUrl, "https://langfuse.internal.example.com");
  });

  test("LANGFUSE_BASE_URL is honored as an alias of LANGFUSE_HOST", () => {
    const cfg = resolveLangfuseConfig({
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-test",
      LANGFUSE_BASE_URL: "https://lf.example.com",
    });
    assert.equal(cfg.baseUrl, "https://lf.example.com");
  });

  test("sample rate is clamped to [0, 1]", () => {
    assert.equal(resolveLangfuseConfig({ LANGFUSE_SAMPLE_RATE: "1.5" }).sampleRate, 1);
    assert.equal(resolveLangfuseConfig({ LANGFUSE_SAMPLE_RATE: "-0.2" }).sampleRate, 0);
    assert.equal(resolveLangfuseConfig({ LANGFUSE_SAMPLE_RATE: "0.5" }).sampleRate, 0.5);
  });

  test("non-numeric flush settings fall back to documented defaults", () => {
    const cfg = resolveLangfuseConfig({
      LANGFUSE_FLUSH_AT: "garbage",
      LANGFUSE_FLUSH_INTERVAL_MS: "",
    });
    assert.equal(cfg.flushAt, 15);
    assert.equal(cfg.flushIntervalMs, 10_000);
  });
});

describe("startLangfuse — no-op safety when disabled", () => {
  test("startLangfuse with empty env reports missing_keys, no client created", () => {
    // The module is module-singleton — if a previous test in the same
    // process started a real client we'd see started:true here. Tests
    // are run with a clean env (no keys), so this should always be a
    // missing_keys / disabled_by_env path.
    const status = startLangfuse({});
    assert.equal(status.enabled, false);
    assert.equal(status.started, true); // start ran; nothing to start
    assert.equal(getLangfuseClient(), null);
    assert.match(status.reason, /missing_keys|disabled_by_env|not_started/);
  });

  test("traceLLMGeneration is a no-op (returns false) when no client", () => {
    const result = traceLLMGeneration({
      name: "test",
      model: "gpt-4",
      input: "hi",
      output: "hello",
    });
    assert.equal(result, false);
  });

  test("shutdownLangfuse is safe to call when client is null", async () => {
    await assert.doesNotReject(() => shutdownLangfuse());
  });

  test("getLangfuseStatus returns a defensive shallow copy", () => {
    const a = getLangfuseStatus();
    a.enabled = true;
    a.reason = "MUTATED";
    const b = getLangfuseStatus();
    assert.notEqual(b.reason, "MUTATED");
  });
});
