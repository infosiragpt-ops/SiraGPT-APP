/**
 * sira-hybrid-retrieval-migration — verifies the mkErr swap in
 * hybrid-retrieval (task 32). All thrown errors now extend
 * SiraPipelineError; the `err.code` value is preserved verbatim.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const hybridRetrieval = require("../src/services/sira/hybrid-retrieval");
const {
  SiraPipelineError,
  RAGError,
  IngressError,
} = require("../src/services/sira/pipeline-errors");

describe("hybrid-retrieval throw migration", () => {
  test("buildIndex with non-array chunks → RAGError(invalid_chunks)", () => {
    assert.throws(
      () => hybridRetrieval.buildIndex("not-an-array"),
      (err) => {
        assert.ok(err instanceof RAGError, `expected RAGError, got ${err.constructor.name}`);
        assert.ok(err instanceof SiraPipelineError);
        assert.equal(err.code, "invalid_chunks");
        assert.equal(err.stage, "rag");
        assert.equal(err.httpStatus, 502);
        return true;
      },
    );
  });

  test("search with missing index → RAGError(invalid_index)", async () => {
    await assert.rejects(
      () => hybridRetrieval.search(null, { query: "x" }),
      (err) => err instanceof RAGError && err.code === "invalid_index",
    );
  });

  test("search with empty query → IngressError(missing_query)", async () => {
    // missing_query is a caller-shape complaint (bad input), not a
    // RAG-state problem, so it maps to IngressError + 400.
    const idx = hybridRetrieval.buildIndex([{ id: "c1", text: "hello" }]);
    await assert.rejects(
      () => hybridRetrieval.search(idx, { query: "" }),
      (err) => {
        assert.ok(err instanceof IngressError);
        assert.equal(err.code, "missing_query");
        assert.equal(err.stage, "ingress");
        assert.equal(err.httpStatus, 400);
        return true;
      },
    );
  });

  test("search with unknown mode → RAGError(invalid_mode)", async () => {
    const idx = hybridRetrieval.buildIndex([{ id: "c1", text: "hello" }]);
    await assert.rejects(
      () => hybridRetrieval.search(idx, { query: "x", mode: "weird" }),
      (err) => err instanceof RAGError && err.code === "invalid_mode",
    );
  });
});
