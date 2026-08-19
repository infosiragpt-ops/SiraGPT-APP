/**
 * sira-mkErr-migrations-bulk — verifies the throw-class swap across
 * the five remaining sira modules that still used a plain
 * `mkErr`/`err` helper:
 *
 *   tasks 33–37
 *   - llm-observability       (IngressError)
 *   - eval-harness            (IngressError)
 *   - tool-registry           (IngressError)
 *   - storage-schema          (StorageError)
 *   - document-pipeline-registry (Context/IngressError split)
 *
 * Codes are preserved verbatim so existing audit-log queries and
 * filters keep working — only the class hops from plain Error to
 * the right SiraPipelineError subclass.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  SiraPipelineError,
  IngressError,
  StorageError,
  ContextError,
} = require("../src/services/sira/pipeline-errors");

// ── llm-observability ──────────────────────────────────────────────

describe("llm-observability mkErr → IngressError", () => {
  const llmObs = require("../src/services/sira/llm-observability");

  test("createSession with missing user_id → IngressError(missing_user_id)", () => {
    assert.throws(
      () => llmObs.createSession({}),
      (err) => {
        assert.ok(err instanceof IngressError);
        assert.ok(err instanceof SiraPipelineError);
        assert.equal(err.code, "missing_user_id");
        assert.equal(err.stage, "ingress");
        assert.equal(err.httpStatus, 400);
        return true;
      },
    );
  });

  test("createTrace with missing session_id → IngressError(missing_session_id)", () => {
    assert.throws(
      () => llmObs.createTrace({ name: "x" }),
      (err) => err instanceof IngressError && err.code === "missing_session_id",
    );
  });
});

// ── eval-harness ───────────────────────────────────────────────────

describe("eval-harness mkErr → IngressError", () => {
  const evalHarness = require("../src/services/sira/eval-harness");

  test("evaluateMetric with unknown metric → IngressError(unknown_metric)", () => {
    assert.throws(
      () => evalHarness.evaluateMetric("not-a-metric", {}),
      (err) => {
        assert.ok(err instanceof IngressError);
        assert.equal(err.code, "unknown_metric");
        return true;
      },
    );
  });

  test("runPromptfooSuite with missing runFn → IngressError(missing_runFn)", async () => {
    await assert.rejects(
      () => evalHarness.runPromptfooSuite({ cases: [], runFn: null }),
      (err) => err instanceof IngressError && err.code === "missing_runFn",
    );
  });
});

// ── tool-registry ──────────────────────────────────────────────────

describe("tool-registry validation throws → IngressError", () => {
  const { SiraToolRegistry } = require("../src/services/sira/tool-registry");

  test("register(null) → IngressError(invalid_tool_object)", () => {
    const r = new SiraToolRegistry();
    assert.throws(
      () => r.register(null),
      (err) => err instanceof IngressError && err.code === "invalid_tool_object",
    );
  });

  test("register(missing name) → IngressError(missing_tool_name)", () => {
    const r = new SiraToolRegistry();
    assert.throws(
      () => r.register({ execute() {} }),
      (err) => err instanceof IngressError && err.code === "missing_tool_name",
    );
  });

  test("register(missing execute) → IngressError(missing_tool_execute)", () => {
    const r = new SiraToolRegistry();
    assert.throws(
      () => r.register({ name: "x" }),
      (err) => err instanceof IngressError && err.code === "missing_tool_execute",
    );
  });

  test("register(unknown category) → IngressError(invalid_tool_category)", () => {
    const r = new SiraToolRegistry();
    assert.throws(
      () => r.register({
        name: "x", execute: () => {}, category: "weird",
        riskLevel: "low", permissionsRequired: [], timeoutMs: 1,
        manifest: { allowedFormats: [], acceptanceTests: [] },
      }),
      (err) => err instanceof IngressError && err.code === "invalid_tool_category",
    );
  });
});

// ── storage-schema ─────────────────────────────────────────────────

describe("storage-schema err → StorageError", () => {
  const { createInMemoryStorage } = require("../src/services/sira/storage-schema");

  test("appendAudit with missing eventType → StorageError(missing_args)", async () => {
    const adapter = createInMemoryStorage();
    await assert.rejects(
      () => adapter.appendAudit({ id: "a1", userId: "u" }),
      (err) => {
        assert.ok(err instanceof StorageError);
        assert.equal(err.code, "missing_args");
        assert.equal(err.stage, "storage");
        assert.equal(err.httpStatus, 500);
        return true;
      },
    );
  });
});

// ── document-pipeline-registry ─────────────────────────────────────

describe("document-pipeline-registry mkErr → Context/IngressError", () => {
  const dpr = require("../src/services/sira/document-pipeline-registry");

  test("chooseParsers with unrecognised mime/ext → ContextError(unknown_format)", () => {
    assert.throws(
      () => dpr.chooseParsers({ mime: "application/x-weird", ext: ".xyz" }),
      (err) => err instanceof ContextError && err.code === "unknown_format",
    );
  });

  test("chooseGenerators with missing format → IngressError(missing_format)", () => {
    // missing_format is a caller-shape complaint, not a registry-state
    // problem, so it lands on the Ingress side of the routing map.
    assert.throws(
      () => dpr.chooseGenerators({ format: null }),
      (err) => err instanceof IngressError && err.code === "missing_format",
    );
  });
});
