/**
 * runtime-market regression — deterministic tests for the
 * ExecutionGraph runtime (runGraph + resumeGraph + adapter) and
 * the market-frameworks library. No network, no real clock.
 */

const { strict: assert } = require("assert");

const { buildExecutionGraph } = require("../src/services/agents/execution-graph");
const {
  runGraph,
  resumeGraph,
  compileToGraph,
  createInMemoryAdapter,
  INTERNAL,
} = require("../src/services/agents/execution-graph-runner");

const {
  computeTamSamSom,
  scorePorterFiveForces,
  buildSwot,
  buildPestel,
  computeUnitEconomics,
  buildCohortTable,
  PORTER_AXES,
} = require("../src/services/bi/market-frameworks");

const cases = [
  // ── Runtime happy path ─────────────────────────────────────────────
  async () => {
    const graph = compileToGraph({
      nodes: [
        { id: "a", tool: "echo", inputs: { value: "hello" } },
        { id: "b", tool: "upper", depends_on: ["a"] },
      ],
    });
    const tools = {
      echo: async (inputs) => inputs.value,
      upper: async (inputs) => String(inputs.deps?.a || "").toUpperCase(),
    };
    const events = [];
    const r = await runGraph({ graph, tools, onEvent: e => events.push(e.type) });
    assert.equal(r.outcome, "done");
    assert.equal(graph.nodes.find(n => n.id === "b").result, "HELLO");
    assert.ok(events.includes("graph_started") && events.includes("graph_completed"));
  },

  // ── Retry-then-succeed ────────────────────────────────────────────
  async () => {
    let attempts = 0;
    const graph = compileToGraph({
      nodes: [{
        id: "flaky",
        tool: "flaky",
        retry_policy: { max_retries: 2, backoff_ms: 0, on_error: "retry-then-fail" },
      }],
    });
    const tools = {
      flaky: async () => { attempts++; if (attempts < 3) throw new Error("transient"); return "ok"; },
    };
    const r = await runGraph({ graph, tools, sleep: async () => {} });
    assert.equal(r.outcome, "done");
    assert.equal(attempts, 3);
  },

  // ── Retry-then-fail ───────────────────────────────────────────────
  async () => {
    const graph = compileToGraph({
      nodes: [{
        id: "bad",
        tool: "bad",
        retry_policy: { max_retries: 1, backoff_ms: 0, on_error: "retry-then-fail" },
      }],
    });
    const tools = { bad: async () => { throw new Error("always"); } };
    const r = await runGraph({ graph, tools, sleep: async () => {} });
    assert.equal(r.outcome, "failed");
    assert.equal(graph.nodes[0].state, "failed");
    assert.equal(graph.nodes[0].attempt, 2);
  },

  // ── retry-then-skip downstream ────────────────────────────────────
  async () => {
    const graph = compileToGraph({
      nodes: [
        {
          id: "a",
          tool: "bad",
          retry_policy: { max_retries: 0, backoff_ms: 0, on_error: "retry-then-skip" },
        },
        { id: "b", tool: "ok", depends_on: ["a"] },
      ],
    });
    const tools = {
      bad: async () => { throw new Error("nope"); },
      ok: async () => "fine",
    };
    const r = await runGraph({ graph, tools, sleep: async () => {} });
    assert.equal(graph.nodes.find(n => n.id === "a").state, "skipped");
    // b should run (it treats skipped as "done enough to proceed")
    assert.equal(graph.nodes.find(n => n.id === "b").state, "done");
    assert.equal(r.outcome, "done");
  },

  // ── continue after error ──────────────────────────────────────────
  async () => {
    const graph = compileToGraph({
      nodes: [{
        id: "warn",
        tool: "bad",
        retry_policy: { max_retries: 0, backoff_ms: 0, on_error: "continue" },
      }],
    });
    const tools = { bad: async () => { throw new Error("weh"); } };
    const r = await runGraph({ graph, tools, sleep: async () => {} });
    assert.equal(graph.nodes[0].state, "done");
    assert.equal(graph.nodes[0].result, null);
    assert.equal(graph.nodes[0].error, "weh");
  },

  // ── Timeout (fail) ────────────────────────────────────────────────
  async () => {
    const graph = compileToGraph({
      nodes: [{
        id: "slow",
        tool: "slow",
        retry_policy: { max_retries: 0, backoff_ms: 0, on_error: "retry-then-fail" },
        timeout_policy: { ms: 50, on_timeout: "fail" },
      }],
    });
    const tools = {
      slow: () => new Promise(r => setTimeout(() => r("too late"), 200)),
    };
    const r = await runGraph({ graph, tools });
    assert.equal(graph.nodes[0].state, "failed");
    assert.ok(/timed out/.test(graph.nodes[0].error));
  },

  // ── Timeout cascade (cancel-downstream) ──────────────────────────
  async () => {
    const graph = compileToGraph({
      nodes: [
        { id: "a", tool: "slow", timeout_policy: { ms: 20, on_timeout: "cancel-downstream" }, retry_policy: { max_retries: 0, on_error: "retry-then-fail" } },
        { id: "b", tool: "ok", depends_on: ["a"] },
      ],
    });
    const tools = {
      slow: () => new Promise(r => setTimeout(() => r(1), 100)),
      ok: async () => "fine",
    };
    await runGraph({ graph, tools });
    assert.equal(graph.nodes.find(n => n.id === "a").state, "failed");
    assert.equal(graph.nodes.find(n => n.id === "b").state, "cancelled");
  },

  // ── Pause + resume via adapter ───────────────────────────────────
  async () => {
    // Part 1: resuming a graph whose `b` terminated in `failed` is a
    // no-op — terminal states don't re-run. max_retries=0 means b
    // fails permanently on the first throw.
    const adapter = createInMemoryAdapter();
    const graph = compileToGraph({
      nodes: [
        { id: "a", tool: "echo", inputs: { value: 1 } },
        { id: "b", tool: "echo", inputs: { value: 2 }, depends_on: ["a"], retry_policy: { max_retries: 0, backoff_ms: 0, on_error: "retry-then-fail" } },
      ],
    });
    const tools = {
      echo: async (inputs) => inputs.value,
    };
    let seen = 0;
    await runGraph({
      graph,
      tools: {
        echo: async (inputs) => {
          seen++;
          if (seen === 2) throw new Error("simulated crash");
          return inputs.value;
        },
      },
      adapter,
      graphId: "run-1",
      sleep: async () => {},
    });
    assert.equal(graph.nodes.find(n => n.id === "b").state, "failed");
    const r = await resumeGraph({ adapter, graphId: "run-1", tools });
    assert.equal(r.outcome, "failed", "b was terminal-failed; resume preserves outcome");

    // Part 2: resuming a graph that crashed mid-node (state=running
    // at save time) flips back to pending and completes cleanly.
    const adapter2 = createInMemoryAdapter();
    const fresh = compileToGraph({ nodes: [{ id: "x", tool: "echo", inputs: { value: 7 } }] });
    fresh.nodes[0].state = "running";
    await adapter2.save("rerun", fresh);
    const r2 = await resumeGraph({ adapter: adapter2, graphId: "rerun", tools: { echo: async (i) => i.value } });
    assert.equal(r2.outcome, "done");
  },

  // ── Abort via signal ─────────────────────────────────────────────
  async () => {
    const graph = compileToGraph({
      nodes: [
        { id: "a", tool: "echo" },
        { id: "b", tool: "echo", depends_on: ["a"] },
      ],
    });
    const controller = new AbortController();
    controller.abort();
    const r = await runGraph({
      graph,
      tools: { echo: async () => "v" },
      signal: controller.signal,
    });
    // All pending nodes are cancelled
    for (const n of graph.nodes) assert.ok(["cancelled", "done"].includes(n.state));
    assert.equal(r.outcome, "cancelled");
  },

  // ── Unknown tool fails the node ──────────────────────────────────
  async () => {
    const graph = compileToGraph({
      nodes: [{ id: "a", tool: "not-in-registry" }],
    });
    const r = await runGraph({ graph, tools: {} });
    assert.equal(r.outcome, "failed");
    assert.ok(/unknown tool/.test(graph.nodes[0].error));
  },

  // ── Backoff schedule ──────────────────────────────────────────────
  () => {
    const b1 = INTERNAL.jitteredBackoff({ backoff_ms: 100, jitter_ms: 0 }, 1);
    const b2 = INTERNAL.jitteredBackoff({ backoff_ms: 100, jitter_ms: 0 }, 2);
    const b3 = INTERNAL.jitteredBackoff({ backoff_ms: 100, jitter_ms: 0 }, 3);
    assert.equal(b1, 100);
    assert.equal(b2, 200);
    assert.equal(b3, 400);
  },

  // ── Dependency fan-in: both parents' results available ────────────
  async () => {
    const graph = compileToGraph({
      nodes: [
        { id: "p", tool: "num", inputs: { value: 2 } },
        { id: "q", tool: "num", inputs: { value: 3 } },
        { id: "sum", tool: "sum", depends_on: ["p", "q"] },
      ],
    });
    const tools = {
      num: async (i) => i.value,
      sum: async (i) => (i.deps.p || 0) + (i.deps.q || 0),
    };
    await runGraph({ graph, tools });
    assert.equal(graph.nodes.find(n => n.id === "sum").result, 5);
  },

  // ── Market frameworks: TAM/SAM/SOM ────────────────────────────────
  () => {
    const r = computeTamSamSom({ universeCount: 10_000_000, pricePerUnitYear: 50, serviceableRatio: 0.3, obtainablePct: 0.05 });
    assert.equal(r.ok, true);
    assert.equal(r.tam, 500_000_000);
    assert.equal(r.sam, 150_000_000);
    assert.equal(r.som, 7_500_000);
  },

  () => {
    const bad = computeTamSamSom({ universeCount: -1, pricePerUnitYear: 50 });
    assert.equal(bad.ok, false);
    assert.ok(bad.findings.some(f => f.code === "universe_count_invalid"));
  },

  () => {
    const r = scorePorterFiveForces({
      supplierPower: 3, buyerPower: 4, newEntrantsThreat: 2, substitutesThreat: 3, competitiveRivalry: 5,
    });
    assert.equal(r.ok, true);
    assert.equal(r.averageThreat, 3.4);
    assert.equal(r.attractivenessScore, 1.6);
    for (const a of PORTER_AXES) assert.ok(r.axes[a]);
  },

  () => {
    const r = scorePorterFiveForces({ supplierPower: 8 });
    assert.ok(r.findings.some(f => f.code === "axis_missing"));
    assert.ok(r.findings.some(f => f.code === "axis_oob"));
  },

  () => {
    const r = buildSwot({
      strengths: ["strong brand", "scale"],
      weaknesses: ["thin margins"],
      opportunities: ["Latin America"],
      threats: ["platform risk"],
    });
    assert.deepEqual(r.matrix.strengths, ["strong brand", "scale"]);
    assert.equal(r.matrix.threats.length, 1);
  },

  () => {
    const r = buildPestel({});
    // Empty is not an error, just a warning
    assert.equal(r.ok, true);
    assert.equal(r.factors.political.length, 0);
  },

  () => {
    const r = computeUnitEconomics({ arpu: 50, cogs: 20, monthlyChurnPct: 0.05, cac: 90 });
    assert.equal(r.ok, true);
    assert.equal(r.grossMargin, 30);
    assert.equal(r.avgLifetimeMonths, 20);
    assert.equal(r.ltv, 600);
    assert.equal(r.ltvToCac, 6.67);
    assert.equal(r.paybackMonths, 3);
    assert.equal(r.quality, "strong");
  },

  () => {
    const r = computeUnitEconomics({ arpu: 50, cogs: 40, monthlyChurnPct: 0.2, cac: 200 });
    assert.equal(r.quality, "weak");
    assert.ok(r.findings.some(f => f.code === "ltv_to_cac_weak"));
  },

  () => {
    const r = computeUnitEconomics({ arpu: -1, cogs: 20, monthlyChurnPct: 0.05, cac: 90 });
    assert.equal(r.ok, false);
    assert.ok(r.findings.some(f => f.code === "arpu_invalid"));
  },

  () => {
    const r = buildCohortTable([
      { cohort: "2026-01", month0: 1, month1: 0.8, month2: 0.65 },
      { cohort: "2026-02", month0: 1, month1: 0.75 },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.table.length, 2);
    assert.equal(r.table[0].months[2], 0.65);
  },

  () => {
    // Retention out of range is flagged
    const r = buildCohortTable([{ cohort: "2026-01", month0: 1, month1: 1.2 }]);
    assert.ok(r.findings.some(f => f.code === "retention_oob"));
  },
];

(async () => {
  let passed = 0, failed = 0;
  const failures = [];
  for (let i = 0; i < cases.length; i++) {
    try { await cases[i](); passed++; }
    catch (err) { failed++; failures.push({ case: i + 1, message: err.message }); }
  }
  console.log(`runtime-market regression: ${passed}/${cases.length} passed, ${failed} failed`);
  if (failed) {
    for (const f of failures) console.log(`  FAIL ${f.case}: ${f.message}`);
    process.exit(1);
  }
  process.exit(0);
})();
