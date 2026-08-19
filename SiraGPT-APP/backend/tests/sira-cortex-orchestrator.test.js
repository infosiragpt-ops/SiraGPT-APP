/**
 * sira-cortex-orchestrator — verifies the public contract of
 * `runCortex`: planner/executor/reflector composition, replan
 * triggers, hard budgets, and abort handling.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  runCortex,
  STOP_REASONS,
  _internals,
} = require("../src/services/sira/cortex-orchestrator");

const {
  normalizePlan,
  normalizeObservation,
  normalizeReflection,
  clamp01,
  defaultReflector,
} = _internals;

// ── pure helpers ───────────────────────────────────────────────────

describe("clamp01", () => {
  test("clamps below 0", () => assert.equal(clamp01(-3), 0));
  test("clamps above 1", () => assert.equal(clamp01(2.5), 1));
  test("passes through normal values", () => assert.equal(clamp01(0.42), 0.42));
  test("returns 0 for non-finite", () => assert.equal(clamp01(NaN), 0));
});

describe("normalizePlan", () => {
  test("returns empty plan for null", () => {
    const p = normalizePlan(null);
    assert.deepEqual(p, { summary: "", subgoals: [] });
  });
  test("dedupes subgoals by id", () => {
    const p = normalizePlan({
      summary: "x",
      subgoals: [
        { id: "a", description: "A" },
        { id: "a", description: "A duplicate" },
        { id: "b", description: "B" },
      ],
    });
    assert.equal(p.subgoals.length, 2);
    assert.equal(p.subgoals[0].id, "a");
    assert.equal(p.subgoals[1].id, "b");
  });
  test("synthesizes ids when missing", () => {
    const p = normalizePlan({ subgoals: [{ description: "x" }, { description: "y" }] });
    assert.equal(p.subgoals[0].id, "sg-1");
    assert.equal(p.subgoals[1].id, "sg-2");
  });
  test("ignores non-object subgoals", () => {
    const p = normalizePlan({ subgoals: [null, "bad", { id: "ok", description: "z" }] });
    assert.equal(p.subgoals.length, 1);
  });
});

describe("normalizeObservation", () => {
  test("clamps confidence", () => {
    const o = normalizeObservation({ result: 1, confidence: 5 }, { id: "a" });
    assert.equal(o.confidence, 1);
  });
  test("defaults requestReplan to false", () => {
    const o = normalizeObservation({ result: 1, confidence: 0.5 }, { id: "a" });
    assert.equal(o.requestReplan, false);
  });
  test("invalid input becomes a replan request", () => {
    const o = normalizeObservation(null, { id: "a" });
    assert.equal(o.requestReplan, true);
    assert.equal(o.confidence, 0);
  });
});

describe("normalizeReflection", () => {
  test("falls back to observation confidence", () => {
    const r = normalizeReflection(null, { confidence: 0.4 });
    assert.equal(r.confidence, 0.4);
    assert.equal(r.done, false);
  });
  test("respects done", () => {
    const r = normalizeReflection({ confidence: 0.9, done: true }, { confidence: 0.1 });
    assert.equal(r.done, true);
    assert.equal(r.confidence, 0.9);
  });
});

describe("defaultReflector", () => {
  test("not done with empty history", async () => {
    const r = await defaultReflector({ history: [] });
    assert.equal(r.done, false);
    assert.equal(r.confidence, 0);
  });
  test("done when min act confidence ≥ 0.7", async () => {
    const history = [
      { kind: "act", subgoal: { id: "a" }, observation: { confidence: 0.8 } },
      { kind: "act", subgoal: { id: "b" }, observation: { confidence: 0.9 } },
    ];
    const r = await defaultReflector({ history });
    assert.equal(r.done, true);
  });
  test("not done when any act confidence < 0.7", async () => {
    const history = [
      { kind: "act", subgoal: { id: "a" }, observation: { confidence: 0.9 } },
      { kind: "act", subgoal: { id: "b" }, observation: { confidence: 0.3 } },
    ];
    const r = await defaultReflector({ history });
    assert.equal(r.done, false);
  });
});

// ── end-to-end orchestration ───────────────────────────────────────

describe("runCortex — happy path", () => {
  test("executes plan in order and finalizes", async () => {
    const events = [];
    const plan = {
      summary: "test",
      subgoals: [
        { id: "g1", description: "first" },
        { id: "g2", description: "second" },
      ],
    };
    // Custom reflector: not done until both subgoals have been acted on,
    // so the loop runs both before the plan terminates.
    const out = await runCortex({
      request: "do the thing",
      planner: async () => plan,
      executor: async ({ subgoal }) => ({
        subgoal,
        result: `done:${subgoal.id}`,
        confidence: 0.85,
      }),
      reflector: async ({ plan: p, history }) => ({
        confidence: 0.9,
        done: history.filter((h) => h.kind === "act").length >= p.subgoals.length,
      }),
      finalizer: async ({ history }) => history.map((h) => h.observation.result).join("|"),
      onEvent: (e) => events.push(e.kind),
    });
    assert.equal(out.ok, true);
    assert.equal(out.stopReason, STOP_REASONS.COMPLETED);
    assert.equal(out.finalAnswer, "done:g1|done:g2");
    assert.equal(out.history.length, 2);
    assert.ok(events.includes("plan"));
    assert.ok(events.includes("act"));
    assert.ok(events.includes("reflect"));
  });
});

describe("runCortex — replan trigger", () => {
  test("replans when reflection.confidence drops below threshold", async () => {
    let plansBuilt = 0;
    const planner = async () => {
      plansBuilt += 1;
      if (plansBuilt === 1) return { summary: "v1", subgoals: [{ id: "a" }] };
      return { summary: "v2", subgoals: [{ id: "b" }] };
    };
    const executor = async ({ subgoal }) => ({
      subgoal,
      result: `r-${subgoal.id}`,
      confidence: subgoal.id === "a" ? 0.9 : 0.95,
    });
    const reflector = async ({ history }) => {
      if (history.length === 1) return { confidence: 0.2, done: false };
      return { confidence: 0.95, done: true };
    };
    const out = await runCortex({
      request: "complex",
      planner,
      executor,
      reflector,
      maxReplans: 3,
    });
    assert.equal(out.ok, true);
    assert.equal(out.stats.replans, 1);
    assert.equal(out.stats.plansGenerated, 2);
  });
});

describe("runCortex — executor failure becomes replan request", () => {
  test("captures executor throw and replans", async () => {
    const planner = async ({ previousPlan }) => {
      if (!previousPlan) return { subgoals: [{ id: "fail" }] };
      return { subgoals: [{ id: "recover" }] };
    };
    let calls = 0;
    const executor = async ({ subgoal }) => {
      calls += 1;
      if (subgoal.id === "fail") throw new Error("boom");
      return { subgoal, result: "ok", confidence: 0.9 };
    };
    const reflector = async ({ history }) => {
      const last = history[history.length - 1];
      return { confidence: last.observation.confidence, done: last.observation.confidence >= 0.8 };
    };
    const out = await runCortex({
      request: "x",
      planner,
      executor,
      reflector,
      maxReplans: 2,
    });
    assert.equal(out.ok, true);
    assert.equal(out.stats.replans, 1);
    assert.equal(calls, 2);
  });
});

describe("runCortex — bounds", () => {
  test("stops at maxSteps", async () => {
    const subgoals = Array.from({ length: 20 }, (_, i) => ({ id: `g${i}` }));
    const out = await runCortex({
      request: "x",
      planner: async () => ({ subgoals }),
      executor: async ({ subgoal }) => ({ subgoal, result: 0, confidence: 0.95 }),
      reflector: async () => ({ confidence: 0.95, done: false }),
      maxSteps: 3,
      maxReplans: 0,
      replanConfidence: 0,
    });
    assert.equal(out.stopReason, STOP_REASONS.MAX_STEPS);
    assert.equal(out.stats.steps, 3);
  });
  test("stops at maxReplans", async () => {
    const out = await runCortex({
      request: "x",
      planner: async () => ({ subgoals: [{ id: "a" }] }),
      executor: async ({ subgoal }) => ({ subgoal, result: 0, confidence: 0.05, requestReplan: true }),
      reflector: async () => ({ confidence: 0.05, done: false }),
      maxReplans: 1,
    });
    assert.equal(out.stopReason, STOP_REASONS.MAX_REPLANS);
    assert.equal(out.stats.replans, 1);
  });
  test("stops on aborted signal", async () => {
    const ac = new AbortController();
    const planner = async () => ({ subgoals: [{ id: "a" }, { id: "b" }] });
    const out = await runCortex({
      request: "x",
      planner,
      executor: async ({ subgoal }) => {
        if (subgoal.id === "a") ac.abort();
        return { subgoal, result: 1, confidence: 0.4 };
      },
      // Reflector keeps done=false so the loop iterates again and trips abort.
      reflector: async () => ({ confidence: 0.4, done: false }),
      signal: ac.signal,
      maxReplans: 5,
      replanConfidence: 0,
    });
    assert.equal(out.stopReason, STOP_REASONS.ABORTED);
  });
  test("planner returning empty plan terminates", async () => {
    const out = await runCortex({
      request: "x",
      planner: async () => ({ subgoals: [] }),
      executor: async () => ({ result: 1, confidence: 0.9 }),
    });
    assert.equal(out.stopReason, STOP_REASONS.PLANNER_EMPTY);
    assert.equal(out.ok, false);
  });
});

describe("runCortex — input validation", () => {
  test("rejects empty request", async () => {
    await assert.rejects(() => runCortex({ request: "", planner: async () => ({ subgoals: [] }), executor: async () => ({}) }), TypeError);
  });
  test("rejects missing planner", async () => {
    await assert.rejects(() => runCortex({ request: "x", executor: async () => ({}) }), TypeError);
  });
  test("rejects missing executor", async () => {
    await assert.rejects(() => runCortex({ request: "x", planner: async () => ({ subgoals: [] }) }), TypeError);
  });
});
