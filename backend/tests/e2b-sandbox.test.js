/**
 * e2b-sandbox — pins the disabled-by-default contract and the
 * config resolution. Live sandbox creation is NOT exercised here
 * — that requires an E2B account + outbound network. The wrapper
 * is designed so every code path that doesn't need the real SDK
 * is testable in isolation.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveE2BConfig,
  executeCode,
  ALLOWED_LANGUAGES,
  DEFAULT_TIMEOUT_MS,
  HARD_MAX_TIMEOUT_MS,
} = require("../src/services/sandbox/e2b-sandbox");

describe("resolveE2BConfig", () => {
  test("disabled when E2B_API_KEY is missing", () => {
    const cfg = resolveE2BConfig({});
    assert.equal(cfg.configured, false);
    assert.equal(cfg.enabled, false);
  });

  test("auto-enables when E2B_API_KEY is set", () => {
    const cfg = resolveE2BConfig({ E2B_API_KEY: "e2b_test_xxxx" });
    assert.equal(cfg.configured, true);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.domain, undefined);
  });

  test("E2B_DOMAIN routes to a self-hosted Firecracker deployment", () => {
    const cfg = resolveE2BConfig({
      E2B_API_KEY: "e2b_test",
      E2B_DOMAIN: "sandbox.internal.example.com",
    });
    assert.equal(cfg.domain, "sandbox.internal.example.com");
  });

  test("E2B_ENABLED=false explicitly disables even with key set", () => {
    const cfg = resolveE2BConfig({
      E2B_API_KEY: "e2b_test",
      E2B_ENABLED: "false",
    });
    assert.equal(cfg.configured, true);
    assert.equal(cfg.enabled, false);
  });

  test("default timeout matches the documented constant", () => {
    const cfg = resolveE2BConfig({ E2B_API_KEY: "e2b_test" });
    assert.equal(cfg.defaultTimeoutMs, DEFAULT_TIMEOUT_MS);
  });

  test("custom timeout is clamped at the hard ceiling", () => {
    const cfg = resolveE2BConfig({
      E2B_API_KEY: "e2b_test",
      E2B_TIMEOUT_MS: String(HARD_MAX_TIMEOUT_MS * 5),
    });
    assert.equal(cfg.defaultTimeoutMs, HARD_MAX_TIMEOUT_MS);
  });

  test("custom timeout is clamped at the floor", () => {
    const cfg = resolveE2BConfig({
      E2B_API_KEY: "e2b_test",
      E2B_TIMEOUT_MS: "0",
    });
    assert.equal(cfg.defaultTimeoutMs, 1000);
  });
});

describe("executeCode — disabled posture", () => {
  test("returns sandbox_disabled when no key is set", async () => {
    const result = await executeCode({ code: "print('x')" }, {});
    assert.equal(result.ok, false);
    assert.equal(result.code, "sandbox_disabled");
  });

  test("returns sandbox_disabled when E2B_ENABLED=false even with key", async () => {
    const result = await executeCode(
      { code: "print('x')" },
      { E2B_API_KEY: "e2b_test", E2B_ENABLED: "false" },
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "sandbox_disabled");
  });
});

describe("executeCode — input validation", () => {
  test("rejects unsupported language", async () => {
    const result = await executeCode(
      { code: "print('x')", language: "fortran" },
      { E2B_API_KEY: "e2b_test" },
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "sandbox_language_not_allowed");
    // Listed languages should appear in the error so a frontend
    // can render a helpful UI without a separate constants endpoint.
    assert.ok(result.message.includes("python"));
  });

  test("rejects empty code", async () => {
    const result = await executeCode(
      { code: "  \n  " },
      { E2B_API_KEY: "e2b_test" },
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "sandbox_empty_code");
  });

  test("language defaults to python when omitted", async () => {
    // We can't actually run code without a real sandbox; we assert
    // that a missing language doesn't fail input validation by
    // injecting a fake sandbox that just echoes the language back.
    const fakeSandbox = {
      async runCode(code, { language }) {
        return {
          logs: { stdout: [`lang=${language}`], stderr: [] },
          exitCode: 0,
        };
      },
    };
    const result = await executeCode(
      { code: "x" },
      { E2B_API_KEY: "e2b_test" },
      { sandbox: fakeSandbox },
    );
    assert.equal(result.ok, true);
    assert.equal(result.stdout, "lang=python");
  });

  test("ALLOWED_LANGUAGES exports a stable set the frontend can introspect", () => {
    assert.ok(ALLOWED_LANGUAGES instanceof Set);
    for (const lang of ["python", "javascript", "typescript", "bash", "r"]) {
      assert.ok(ALLOWED_LANGUAGES.has(lang), `${lang} must be allowlisted`);
    }
  });
});

describe("executeCode — happy path with injected sandbox", () => {
  test("returns stdout / stderr / exitCode / durationMs", async () => {
    const fakeSandbox = {
      async runCode(_code, _opts) {
        return {
          logs: { stdout: ["hello\n"], stderr: ["warn\n"] },
          exitCode: 0,
        };
      },
    };
    const result = await executeCode(
      { code: "print('hello')" },
      { E2B_API_KEY: "e2b_test" },
      { sandbox: fakeSandbox },
    );
    assert.equal(result.ok, true);
    assert.equal(result.stdout, "hello\n");
    assert.equal(result.stderr, "warn\n");
    assert.equal(result.exitCode, 0);
    assert.ok(typeof result.durationMs === "number");
    assert.equal(result.error, null);
  });

  test("forwards execution.error onto a structured error field", async () => {
    const fakeSandbox = {
      async runCode() {
        return {
          logs: { stdout: [], stderr: [] },
          exitCode: 1,
          error: {
            name: "NameError",
            value: "name 'foo' is not defined",
            traceback: ["Traceback (most recent call last):", "  ...", "NameError: name 'foo' is not defined"],
          },
        };
      },
    };
    const result = await executeCode(
      { code: "print(foo)" },
      { E2B_API_KEY: "e2b_test" },
      { sandbox: fakeSandbox },
    );
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 1);
    assert.equal(result.error.name, "NameError");
    assert.equal(result.error.value, "name 'foo' is not defined");
    assert.ok(result.error.traceback.includes("NameError"));
  });

  test("translates SDK TimeoutError to sandbox_timeout", async () => {
    const fakeSandbox = {
      async runCode() {
        const err = new Error("execution exceeded timeout");
        err.name = "TimeoutError";
        throw err;
      },
    };
    const result = await executeCode(
      { code: "while True: pass" },
      { E2B_API_KEY: "e2b_test" },
      { sandbox: fakeSandbox },
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "sandbox_timeout");
  });

  test("translates other SDK errors to sandbox_runtime_error", async () => {
    const fakeSandbox = {
      async runCode() {
        throw new Error("connection lost");
      },
    };
    const result = await executeCode(
      { code: "print(1)" },
      { E2B_API_KEY: "e2b_test" },
      { sandbox: fakeSandbox },
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "sandbox_runtime_error");
    assert.ok(result.message.includes("connection lost"));
  });
});
