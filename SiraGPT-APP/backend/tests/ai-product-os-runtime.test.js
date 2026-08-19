/**
 * ai-product-os-runtime — deterministic tests for the 14 laws, the
 * 17-agent kernel, the MCP gateway, event envelope, durable workflow
 * adapter, and the compile/execute runtime entry point.
 *
 * (This is the runtime kernel at backend/src/services/ai-product-os/.
 *  A separate prompt-descriptor module lives under services/agents/
 *  ai-product-os.js and is covered by ai-product-os.test.js.)
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { LAWS, getLaw, enforceConstitution } = require("../src/services/ai-product-os/constitution");
const { AGENTS, listAgents, getAgent, validateHandoff, registryIntegrity, computeHandoffGraph, EVENTS, GUARDRAILS } = require("../src/services/ai-product-os/agentic-kernel");
const { createMcpGateway } = require("../src/services/ai-product-os/mcp-gateway");
const { createEnvelope, validateEnvelope, chainEnvelope, serializeEnvelope, deserializeEnvelope } = require("../src/services/ai-product-os/event-envelope");
const { createDurableRuntime, createInMemoryStore } = require("../src/services/ai-product-os/durable-workflow");
const productOs = require("../src/services/ai-product-os/product-os");

function expect(actual) {
  return {
    toEqual(e) { assert.deepEqual(actual, e); },
    toBe(e) { assert.equal(actual, e); },
    toBeGreaterThan(e) { assert.ok(actual > e, `${actual} not > ${e}`); },
    toBeGreaterThanOrEqual(e) { assert.ok(actual >= e, `${actual} not >= ${e}`); },
    toBeLessThan(e) { assert.ok(actual < e, `${actual} not < ${e}`); },
    toContain(e) { assert.ok(actual.includes(e), `${JSON.stringify(actual)} missing ${JSON.stringify(e)}`); },
    toBeTruthy() { assert.ok(actual); },
    toBeFalsy() { assert.ok(!actual); },
    toMatch(p) { assert.match(String(actual), p); },
  };
}

// ── Constitution ─────────────────────────────────────────────────────

describe("product-os runtime / constitution", () => {
  test("exposes at least 14 laws including never_fake_artifacts", () => {
    expect(LAWS.length).toBeGreaterThanOrEqual(14);
    expect(LAWS.some(l => l.key === "do_not_answer_freely")).toBe(true);
    expect(LAWS.some(l => l.key === "never_fake_artifacts")).toBe(true);
  });

  test("getLaw finds by id or key", () => {
    expect(getLaw("L01").key).toBe("do_not_answer_freely");
    expect(getLaw("never_fake_citations").id).toBe("L14");
    expect(getLaw("nope")).toBe(null);
  });

  test("blocks free answer", () => {
    const r = enforceConstitution({ freeAnswerAttempted: true });
    expect(r.ok).toBe(false);
    expect(r.violations.some(v => v.key === "do_not_answer_freely")).toBe(true);
  });

  test("blocks uncompiled contract", () => {
    const r = enforceConstitution({ hasContract: false });
    expect(r.violations.some(v => v.key === "compile_request_to_contract")).toBe(true);
  });

  test("blocks release when validation fails but output released", () => {
    const r = enforceConstitution({
      hasContract: true, contractValid: true, dagPresent: true, statePersisted: true,
      hasDeliverables: true, validationFabricRan: true, artifactsFormatApproved: true,
      releaseGateDecision: "reject", releasedAnyway: true,
    });
    expect(r.violations.some(v => v.key === "block_release_if_validation_fails")).toBe(true);
  });

  test("passes clean context", () => {
    const r = enforceConstitution({
      hasContract: true, contractValid: true, dagPresent: true, statePersisted: true,
      hasDeliverables: true, artifactsFormatApproved: true, validationFabricRan: true,
      releaseGateDecision: "approve", evidenceBindingsForClaims: true, hasFactualClaims: true,
      noFakedScores: true, noFakedCitations: true, noFakedArtifacts: true, noHallucinatedFileReads: true,
    });
    expect(r.ok).toBe(true);
  });

  test("blocks unregistered tool calls", () => {
    const r = enforceConstitution({ unregisteredToolCalls: ["rogue_tool"] });
    expect(r.violations.some(v => v.key === "select_tools_only_from_registry")).toBe(true);
  });

  test("blocks validator failure without self-repair", () => {
    const r = enforceConstitution({ validatorsFailed: true, selfRepairAttempted: false });
    expect(r.violations.some(v => v.key === "repair_before_delivery")).toBe(true);
  });
});

// ── AgenticKernel ────────────────────────────────────────────────────

describe("product-os runtime / agentic-kernel", () => {
  test("registers 17 specialised agents", () => {
    expect(AGENTS.length).toBe(17);
  });

  test("registry integrity passes", () => {
    const r = registryIntegrity();
    expect(r.ok).toBe(true);
    expect(r.issues.length).toBe(0);
  });

  test("listAgents returns deep-copied snapshot", () => {
    const a = listAgents();
    a[0].tools.push("polluted");
    expect(getAgent(a[0].id).tools.includes("polluted")).toBe(false);
  });

  test("validateHandoff: allowed edge is ok", () => {
    const r = validateHandoff("intent-compiler", "planner");
    expect(r.ok).toBe(true);
  });

  test("validateHandoff rejects unknown agent", () => {
    const r = validateHandoff("intent-compiler", "nonexistent");
    expect(r.ok).toBe(false);
  });

  test("validateHandoff rejects illegal direct edge", () => {
    const r = validateHandoff("telemetry", "intent-compiler");
    expect(r.ok).toBe(false);
  });

  test("every agent references only known guardrails", () => {
    for (const a of AGENTS) {
      for (const g of a.guardrails) expect(GUARDRAILS[g]).toBeTruthy();
    }
  });

  test("computeHandoffGraph produces ≥ 20 edges and 17 nodes", () => {
    const g = computeHandoffGraph();
    expect(g.edges.length).toBeGreaterThanOrEqual(20);
    expect(g.nodes.length).toBe(17);
  });

  test("EVENTS constant exposes standard event names", () => {
    expect(EVENTS.INTENT_COMPILED).toBe("product-os.intent.compiled");
    expect(EVENTS.RELEASE_DECIDED).toBe("product-os.release.decided");
  });
});

// ── MCP Gateway ──────────────────────────────────────────────────────

describe("product-os runtime / mcp-gateway", () => {
  test("registerTool requires non-empty name + function handler", () => {
    const g = createMcpGateway();
    assert.throws(() => g.registerTool({ name: "", handler: () => {} }), /non-empty string/);
    assert.throws(() => g.registerTool({ name: "x", handler: null }), /function/);
  });

  test("tools/list returns registered tools", async () => {
    const g = createMcpGateway();
    g.registerTool({ name: "echo", description: "echo args", handler: a => a });
    const r = await g.call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(r.result.tools.length).toBe(1);
    expect(r.result.tools[0].name).toBe("echo");
  });

  test("tools/call invokes handler and returns content", async () => {
    const g = createMcpGateway();
    g.registerTool({ name: "sum", handler: ({ a, b }) => a + b });
    const r = await g.call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "sum", arguments: { a: 1, b: 2 } } });
    expect(r.result.content).toBe(3);
  });

  test("unknown tool returns tool_not_found", async () => {
    const g = createMcpGateway();
    const r = await g.call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope" } });
    expect(r.error.code).toBe("tool_not_found");
  });

  test("scoped tool rejects unauthorized caller", async () => {
    const g = createMcpGateway();
    g.registerTool({ name: "sql", scopes: ["db.write"], handler: () => "ok" });
    const r = await g.call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "sql", arguments: {} } });
    expect(r.error.code).toBe("permission_denied");
  });

  test("scoped tool succeeds when scope granted", async () => {
    const g = createMcpGateway();
    g.registerTool({ name: "sql", scopes: ["db.write"], handler: () => "ok" });
    const r = await g.call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "sql", arguments: {} } }, { grantedScopes: ["db.write"] });
    expect(r.result.content).toBe("ok");
  });

  test("resources/read dispatches to registered handler", async () => {
    const g = createMcpGateway();
    g.registerResource({ uri: "config://feature-flags", read: () => ({ flag: true }) });
    const r = await g.call({ jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri: "config://feature-flags" } });
    expect(r.result.contents.flag).toBe(true);
  });

  test("prompts/get renders template", async () => {
    const g = createMcpGateway();
    g.registerPrompt({ name: "greet", arguments: [{ name: "who", required: true }], render: ({ who }) => `Hello, ${who}` });
    const r = await g.call({ jsonrpc: "2.0", id: 7, method: "prompts/get", params: { name: "greet", arguments: { who: "World" } } });
    expect(r.result.content).toBe("Hello, World");
  });

  test("unknown method returns method_not_supported", async () => {
    const g = createMcpGateway();
    const r = await g.call({ jsonrpc: "2.0", id: 8, method: "unknown/method" });
    expect(r.error.code).toBe("method_not_supported");
  });

  test("audit records every call", async () => {
    const g = createMcpGateway();
    g.registerTool({ name: "x", handler: () => 1 });
    await g.call({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "x" } });
    await g.call({ jsonrpc: "2.0", id: 10, method: "tools/list" });
    expect(g.auditSnapshot().length).toBe(2);
    expect(g.counts().audit_records).toBe(2);
  });
});

// ── Event Envelope ───────────────────────────────────────────────────

describe("product-os runtime / event-envelope", () => {
  test("createEnvelope produces required fields", () => {
    const e = createEnvelope({ type: "unit.test", payload: { x: 1 } });
    expect(validateEnvelope(e).ok).toBe(true);
    expect(e.trace_id.length).toBe(32);
    expect(e.span_id.length).toBe(16);
  });

  test("validateEnvelope rejects invalid trace id", () => {
    const bad = { id: "x", type: "t", schema_version: "1.0", ts: new Date().toISOString(), correlation_id: "x", trace_id: "zzz", span_id: "0000000000000000", producer: "x" };
    const r = validateEnvelope(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e === "invalid.trace_id")).toBe(true);
  });

  test("chainEnvelope preserves correlation and trace ids", () => {
    const parent = createEnvelope({ type: "parent.event" });
    const child = chainEnvelope(parent, { type: "child.event" });
    expect(child.correlation_id).toBe(parent.correlation_id);
    expect(child.trace_id).toBe(parent.trace_id);
    expect(child.parent_span_id).toBe(parent.span_id);
    expect(child.causation_id).toBe(parent.id);
  });

  test("serialize / deserialize round-trip", () => {
    const e = createEnvelope({ type: "x.y" });
    const back = deserializeEnvelope(serializeEnvelope(e));
    expect(back.id).toBe(e.id);
  });

  test("createEnvelope rejects empty type", () => {
    assert.throws(() => createEnvelope({ type: "" }), /type/);
  });
});

// ── Durable Workflow Adapter ─────────────────────────────────────────

describe("product-os runtime / durable-workflow", () => {
  test("runs a linear 3-node graph to completion", async () => {
    const rt = createDurableRuntime();
    const activityRunner = async ({ activity, input }) => ({ activity, input, done: true });
    const r = await rt.startRun({
      run_id: "run-1",
      nodes: [
        { id: "a", activity: "x", input: 1 },
        { id: "b", activity: "x", input: 2, depends_on: ["a"] },
        { id: "c", activity: "x", input: 3, depends_on: ["b"] },
      ],
    }, { activityRunner });
    expect(r.ok).toBe(true);
    expect(r.state.nodes.every(n => n.status === "done")).toBe(true);
  });

  test("retries a flaky activity up to max_attempts", async () => {
    const rt = createDurableRuntime();
    let attempts = 0;
    const activityRunner = async () => {
      attempts += 1;
      if (attempts < 3) { const e = new Error("boom"); e.code = "transient"; throw e; }
      return "ok";
    };
    const r = await rt.startRun({
      run_id: "run-2",
      nodes: [{ id: "a", activity: "x", retry_policy: { max_attempts: 3, backoff_ms: 1 } }],
    }, { activityRunner });
    expect(r.ok).toBe(true);
    expect(attempts).toBe(3);
  });

  test("fails after exhausting retries", async () => {
    const rt = createDurableRuntime();
    const activityRunner = async () => { const e = new Error("boom"); e.code = "permanent"; throw e; };
    const r = await rt.startRun({
      run_id: "run-3",
      nodes: [{ id: "a", activity: "x", retry_policy: { max_attempts: 2, backoff_ms: 1 } }],
    }, { activityRunner });
    expect(r.ok).toBe(false);
    expect(r.state.nodes[0].status).toBe("failed");
  });

  test("compensates in reverse when configured", async () => {
    const rt = createDurableRuntime();
    const compensated = [];
    const activityRunner = async ({ activity, node_id }) => {
      if (activity === "compensate") { compensated.push(node_id); return "compensated"; }
      if (node_id === "c") { const e = new Error("boom"); e.code = "permanent"; throw e; }
      return "ok";
    };
    const r = await rt.startRun({
      run_id: "run-4",
      rollback_strategy: "compensate_in_reverse",
      nodes: [
        { id: "a", activity: "real", compensation_action: { activity: "compensate" } },
        { id: "b", activity: "real", compensation_action: { activity: "compensate" }, depends_on: ["a"] },
        { id: "c", activity: "real", retry_policy: { max_attempts: 1, backoff_ms: 0 }, depends_on: ["b"] },
      ],
    }, { activityRunner });
    expect(r.ok).toBe(false);
    expect(compensated.includes("b.compensation")).toBe(true);
    expect(compensated.includes("a.compensation")).toBe(true);
  });

  test("resume picks up from checkpoint", async () => {
    const store = createInMemoryStore();
    const rt = createDurableRuntime({ store });
    let callCount = 0;
    await rt.startRun({
      run_id: "run-5",
      nodes: [
        { id: "a", activity: "x", retry_policy: { max_attempts: 1 } },
        { id: "b", activity: "x", retry_policy: { max_attempts: 1 }, depends_on: ["a"] },
      ],
    }, {
      activityRunner: async ({ node_id }) => {
        callCount += 1;
        if (node_id === "b") { const e = new Error("fail"); e.code = "p"; throw e; }
        return "ok";
      },
    });
    expect(callCount).toBe(2);
    const r = await rt.resume("run-5", {
      activityRunner: async ({ node_id }) => (node_id === "b" ? "fixed" : "ok"),
    });
    expect(r.ok).toBe(true);
  });

  test("rejects cyclic graph", async () => {
    const rt = createDurableRuntime();
    await assert.rejects(
      rt.startRun({
        run_id: "cyc",
        nodes: [
          { id: "a", activity: "x", depends_on: ["b"] },
          { id: "b", activity: "x", depends_on: ["a"] },
        ],
      }, { activityRunner: async () => "ok" }),
      /cycle/,
    );
  });

  test("rejects unknown dependency", async () => {
    const rt = createDurableRuntime();
    await assert.rejects(
      rt.startRun({
        run_id: "unknown-dep",
        nodes: [{ id: "a", activity: "x", depends_on: ["ghost"] }],
      }, { activityRunner: async () => "ok" }),
      /unknown/,
    );
  });

  test("honours AbortSignal", async () => {
    const rt = createDurableRuntime();
    const ctrl = new AbortController();
    const activityRunner = async ({ node_id }) => {
      if (node_id === "a") ctrl.abort();
      return "ok";
    };
    const r = await rt.startRun({
      run_id: "cancel",
      nodes: [
        { id: "a", activity: "x" },
        { id: "b", activity: "x", depends_on: ["a"] },
      ],
    }, { activityRunner, signal: ctrl.signal });
    expect(r.status).toBe("cancelled");
  });
});

// ── Product OS compile / execute ────────────────────────────────────

describe("product-os runtime / compile + execute", () => {
  test("compile produces contract + graph with matching contract_id", () => {
    const r = productOs.compile({
      objective: "Research generative AI market size",
      deliverables: [{ name: "report.pdf", required_extension: ".pdf", mime_type: "application/pdf" }],
      constraints: ["evidence_ledger_required"],
    });
    expect(r.contract.objective).toMatch(/Research/);
    expect(r.graph.contract_id).toBe(r.contract.contract_id);
    expect(r.graph.nodes.length).toBeGreaterThan(10);
  });

  test("compile refuses missing objective", () => {
    assert.throws(() => productOs.compile({}), /objective/);
  });

  test("execute runs graph end-to-end with trivial activity runner", async () => {
    const { contract, graph } = productOs.compile({ objective: "Simple task" });
    const r = await productOs.execute({ contract, graph }, {
      activityRunner: async ({ activity }) => ({ activity, output: "ok" }),
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("completed");
  });

  test("execute surfaces failure when a required node throws", async () => {
    const { contract, graph } = productOs.compile({ objective: "Ship report" });
    const r = await productOs.execute({ contract, graph }, {
      activityRunner: async ({ node_id }) => {
        if (node_id === "qa.regression") { const e = new Error("failed"); e.code = "qa_fail"; throw e; }
        return "ok";
      },
    });
    expect(r.ok).toBe(false);
  });

  test("status() returns integrity snapshot", () => {
    const s = productOs.status();
    expect(s.laws).toBeGreaterThanOrEqual(14);
    expect(s.agents).toBe(17);
    expect(s.agent_registry_ok).toBe(true);
  });
});
