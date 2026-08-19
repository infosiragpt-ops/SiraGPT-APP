/**
 * sira-cortex-engine — verifies the facade composes the four
 * underlying modules correctly and applies defaults.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createCortexEngine,
  cortex,
  router,
  cache,
  fanout,
} = require("../src/services/sira/cortex-engine");

describe("createCortexEngine — wiring", () => {
  test("exposes the composed surface", () => {
    const engine = createCortexEngine({
      providerCatalog: { fast: ["a"], standard: ["b"], heavy: ["c"] },
    });
    assert.equal(engine.version, "1.0.0");
    assert.equal(typeof engine.runCortex, "function");
    assert.equal(typeof engine.route, "function");
    assert.equal(typeof engine.runFanout, "function");
    assert.ok(engine.cache && typeof engine.cache.wrap === "function");
    assert.ok(engine.components.STOP_REASONS);
    assert.ok(engine.components.TIERS);
    assert.ok(engine.components.FAILURE_POLICIES);
  });

  test("runCortex applies engine defaults", async () => {
    const engine = createCortexEngine({
      cortexDefaults: { maxSteps: 1, maxReplans: 0 },
    });
    const out = await engine.runCortex({
      request: "x",
      planner: async () => ({
        subgoals: [{ id: "a" }, { id: "b" }],
      }),
      executor: async ({ subgoal }) => ({ subgoal, result: 0, confidence: 0.5 }),
      reflector: async () => ({ confidence: 0.5, done: false }),
    });
    // Capped at 1 step → didn't reach goal b.
    assert.equal(out.stats.steps, 1);
  });

  test("route uses engine catalog by default", async () => {
    const engine = createCortexEngine({
      providerCatalog: { fast: ["fast-x"], standard: ["std-x"], heavy: ["heavy-x"] },
    });
    const out = await engine.route({
      text: "hi",
      invoker: async (id) => ({ id }),
    });
    assert.equal(out.providerId, "fast-x");
  });

  test("route allows per-call catalog override", async () => {
    const engine = createCortexEngine({
      providerCatalog: { fast: ["A"], standard: ["B"], heavy: ["C"] },
    });
    const out = await engine.route({
      text: "hi",
      catalog: { fast: ["X"], standard: ["Y"], heavy: ["Z"] },
      invoker: async (id) => ({ id }),
    });
    assert.equal(out.providerId, "X");
  });

  test("route throws when no catalog is available", () => {
    const engine = createCortexEngine();
    // Synchronous throw before the async router invocation.
    assert.throws(
      () => engine.route({ text: "hi", invoker: async () => ({}) }),
      TypeError,
    );
  });

  test("runFanout applies engine defaults", async () => {
    const engine = createCortexEngine({ fanoutDefaults: { concurrency: 1 } });
    let inflight = 0;
    let peak = 0;
    const tasks = Array.from({ length: 4 }, (_, i) => ({
      id: `t${i}`,
      run: async () => {
        inflight += 1;
        if (inflight > peak) peak = inflight;
        await new Promise((r) => setTimeout(r, 5));
        inflight -= 1;
        return i;
      },
    }));
    const out = await engine.runFanout({ tasks });
    assert.equal(out.ok, true);
    assert.ok(peak <= 1);
  });

  test("cache instance singleflight works through facade", async () => {
    const engine = createCortexEngine();
    let calls = 0;
    const exec = async () => { calls += 1; return 42; };
    const [a, b] = await Promise.all([
      engine.cache.wrap("t", { x: 1 }, exec),
      engine.cache.wrap("t", { x: 1 }, exec),
    ]);
    assert.equal(a, 42);
    assert.equal(b, 42);
    assert.equal(calls, 1);
  });

  test("re-exports raw modules", () => {
    assert.ok(cortex.runCortex);
    assert.ok(router.classifyHeuristic);
    assert.ok(cache.SemanticToolCache);
    assert.ok(fanout.runFanout);
  });
});
