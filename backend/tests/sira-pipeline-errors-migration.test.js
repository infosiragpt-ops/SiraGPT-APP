/**
 * sira-pipeline-errors-migration — verifies the throw sites in
 * engine, runtime, and task-envelope-builder migrated from plain
 * `Error("...")` to stage-tagged `SiraPipelineError` subclasses.
 * Closes task 18.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const engine = require("../src/services/sira/engine");
const runtime = require("../src/services/sira/runtime");
const { buildEnvelope } = require("../src/services/sira/task-envelope-builder");
const {
  SiraPipelineError,
  IngressError,
  ContextError,
  toHttpResponse,
} = require("../src/services/sira/pipeline-errors");

describe("engine.runUserMessage throws IngressError on missing text", () => {
  test("rejects with IngressError + ingress.engine_missing_text", async () => {
    await assert.rejects(
      () => engine.runUserMessage({ requestId: "req-engine" }),
      (err) => {
        assert.ok(err instanceof IngressError, "must be IngressError");
        assert.ok(err instanceof SiraPipelineError, "must extend SiraPipelineError");
        assert.equal(err.code, "ingress.engine_missing_text");
        assert.equal(err.stage, "ingress");
        assert.equal(err.httpStatus, 400);
        assert.equal(err.requestId, "req-engine");
        return true;
      },
    );
  });

  test("toHttpResponse maps the error to a 400 with the right body", async () => {
    try {
      await engine.runUserMessage({ requestId: "req-engine-http" });
    } catch (err) {
      const r = toHttpResponse(err);
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, "ingress.engine_missing_text");
      assert.equal(r.body.error.stage, "ingress");
      assert.equal(r.body.error.request_id, "req-engine-http");
    }
  });
});

describe("buildEnvelope throws IngressError on missing text", () => {
  test("rejects with IngressError + ingress.envelope_missing_text", async () => {
    await assert.rejects(
      () => buildEnvelope({ requestId: "req-env" }),
      (err) => {
        assert.ok(err instanceof IngressError);
        assert.equal(err.code, "ingress.envelope_missing_text");
        assert.equal(err.stage, "ingress");
        assert.equal(err.requestId, "req-env");
        return true;
      },
    );
  });
});

describe("runtime.runWorkflow throws ContextError on missing workflow_graph", () => {
  test("rejects with ContextError + context.runtime_missing_workflow_graph", async () => {
    await assert.rejects(
      () => runtime.runWorkflow({ envelope: { request_id: "req-rt" } }),
      (err) => {
        assert.ok(err instanceof ContextError);
        assert.equal(err.code, "context.runtime_missing_workflow_graph");
        assert.equal(err.stage, "context");
        assert.equal(err.httpStatus, 500);
        assert.equal(err.requestId, "req-rt");
        return true;
      },
    );
  });

  test("rejects with ContextError when envelope is null too", async () => {
    await assert.rejects(
      () => runtime.runWorkflow({}),
      (err) => err instanceof ContextError && err.code === "context.runtime_missing_workflow_graph",
    );
  });
});
