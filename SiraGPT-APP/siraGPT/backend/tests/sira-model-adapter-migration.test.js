/**
 * sira-model-adapter-migration — verifies the mkErr swap in
 * model-adapter (task 29). All thrown errors now extend
 * SiraPipelineError; `err.code` stays verbatim so legacy callers
 * and tests indexed on the raw code keep working.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const modelAdapter = require("../src/services/sira/model-adapter");
const {
  SiraPipelineError,
  IngressError,
  ToolError,
  toHttpResponse,
} = require("../src/services/sira/pipeline-errors");

const baseValidArgs = () => ({
  selectedModel: { provider: "openai", modelId: "gpt-4o-mini" },
  systemPrompt: "you are siraGPT",
  messages: [{ role: "user", content: "hi" }],
});

describe("model-adapter validation throws are now IngressError", () => {
  test("missing selectedModel → IngressError(missing_selected_model), 400", async () => {
    await assert.rejects(
      () => modelAdapter.callUserSelectedModel({ ...baseValidArgs(), selectedModel: null }),
      (err) => {
        assert.ok(err instanceof IngressError, "must be IngressError");
        assert.ok(err instanceof SiraPipelineError, "must extend SiraPipelineError");
        assert.equal(err.code, "missing_selected_model");
        assert.equal(err.stage, "ingress");
        assert.equal(err.httpStatus, 400);
        return true;
      },
    );
  });

  test("provider not in allowlist → IngressError(provider_unsupported)", async () => {
    await assert.rejects(
      () => modelAdapter.callUserSelectedModel({
        ...baseValidArgs(),
        selectedModel: { provider: "nope", modelId: "x" },
      }),
      (err) => err instanceof IngressError && err.code === "provider_unsupported",
    );
  });

  test("missing modelId → IngressError(missing_model_id)", async () => {
    await assert.rejects(
      () => modelAdapter.callUserSelectedModel({
        ...baseValidArgs(),
        selectedModel: { provider: "openai", modelId: "" },
      }),
      (err) => err instanceof IngressError && err.code === "missing_model_id",
    );
  });

  test("messages array empty → IngressError(missing_messages)", async () => {
    await assert.rejects(
      () => modelAdapter.callUserSelectedModel({ ...baseValidArgs(), messages: [] }),
      (err) => err instanceof IngressError && err.code === "missing_messages",
    );
  });

  test("bad role → IngressError(bad_message_role)", async () => {
    await assert.rejects(
      () => modelAdapter.callUserSelectedModel({
        ...baseValidArgs(),
        messages: [{ role: "ghost", content: "x" }],
      }),
      (err) => err instanceof IngressError && err.code === "bad_message_role",
    );
  });

  test("toHttpResponse maps each one to {status:400, body.error.code:<code>}", async () => {
    try {
      await modelAdapter.callUserSelectedModel({ ...baseValidArgs(), messages: [] });
    } catch (err) {
      const r = toHttpResponse(err);
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, "missing_messages");
      assert.equal(r.body.error.stage, "ingress");
    }
  });
});

describe("guardAgainstAutoRouting throws IngressError", () => {
  test("provider switch → IngressError(auto_route_violation), 400", () => {
    assert.throws(
      () => modelAdapter.guardAgainstAutoRouting(
        { provider: "openai", modelId: "x" },
        { provider: "anthropic", modelId: "x" },
      ),
      (err) => {
        assert.ok(err instanceof IngressError);
        assert.equal(err.code, "auto_route_violation");
        return true;
      },
    );
  });

  test("model switch → IngressError(auto_route_violation)", () => {
    assert.throws(
      () => modelAdapter.guardAgainstAutoRouting(
        { provider: "openai", modelId: "x" },
        { provider: "openai", modelId: "y" },
      ),
      (err) => err instanceof IngressError && err.code === "auto_route_violation",
    );
  });
});

describe("provider_circuit_open is a ToolError (not IngressError)", () => {
  test("class is ToolError, code stays verbatim, retryable:true", async () => {
    const llm = require("../src/services/sira/llm-instrumentation");
    llm._resetForTests();
    llm.configure({ failuresToOpen: 1 });
    llm.recordLlmCall({ selectedModel: { provider: "openai", modelId: "x" }, status: "error" });
    assert.equal(llm.getCircuitState("openai"), "open");

    await assert.rejects(
      () => modelAdapter.callUserSelectedModel({
        selectedModel: { provider: "openai", modelId: "gpt-4o-mini" },
        systemPrompt: "x",
        messages: [{ role: "user", content: "x" }],
      }),
      (err) => {
        assert.ok(err instanceof ToolError, `expected ToolError, got ${err.constructor.name}`);
        assert.equal(err.code, "provider_circuit_open");
        assert.equal(err.retryable, true);
        assert.equal(err.stage, "tool");
        assert.equal(err.httpStatus, 502);
        return true;
      },
    );
  });
});
