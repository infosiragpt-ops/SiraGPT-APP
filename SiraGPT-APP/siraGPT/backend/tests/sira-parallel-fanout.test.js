/**
 * sira-parallel-fanout — verifies bounded concurrency, per-task
 * timeout, aggregate timeout, failure policies, abort cascade,
 * reducer integration and stats.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  runFanout,
  FAILURE_POLICIES,
  _internals,
} = require("../src/services/sira/parallel-fanout");

const { computeStats, defaultReducer } = _internals;

// ── happy path ─────────────────────────────────────────────────────

describe("runFanout — happy path", () => {
  test("returns survivors and reduced output", async () => {
    const tasks = [
      { id: "a", run: async () => 1 },
      { id: "b", run: async () => 2 },
      { id: "c", run: async () => 3 },
    ];
    const out = await runFanout({ tasks, concurrency: 2 });
    assert.equal(out.ok, true);
    assert.deepEqual(out.reduced, [1, 2, 3]);
    assert.equal(out.stats.fulfilled, 3);
    assert.equal(out.results.length, 3);
    assert.equal(out.results[0].status, "fulfilled");
  });
  test("empty tasks returns immediately", async () => {
    const out = await runFanout({ tasks: [] });
    assert.equal(out.ok, true);
    assert.deepEqual(out.reduced, []);
    assert.equal(out.stats.total, 0);
  });
  test("reducer customizes output", async () => {
    const tasks = [
      { id: "a", run: async () => 5 },
      { id: "b", run: async () => 7 },
    ];
    const out = await runFanout({
      tasks,
      reducer: (results) => results.reduce((acc, r) => acc + (r.ok ? r.value : 0), 0),
    });
    assert.equal(out.reduced, 12);
  });
});

// ── bounded concurrency ────────────────────────────────────────────

describe("runFanout — concurrency", () => {
  test("never exceeds the cap", async () => {
    let inflight = 0;
    let peak = 0;
    const make = (i) => ({
      id: `t${i}`,
      run: async () => {
        inflight += 1;
        if (inflight > peak) peak = inflight;
        await new Promise((r) => setTimeout(r, 5));
        inflight -= 1;
        return i;
      },
    });
    const tasks = Array.from({ length: 10 }, (_, i) => make(i));
    const out = await runFanout({ tasks, concurrency: 3 });
    assert.equal(out.ok, true);
    assert.ok(peak <= 3, `peak ${peak} exceeded cap 3`);
  });
});

// ── failure policies ───────────────────────────────────────────────

describe("runFanout — failure policies", () => {
  test("continue policy collects partial failures", async () => {
    const tasks = [
      { id: "a", run: async () => 1 },
      { id: "b", run: async () => { throw new Error("boom"); } },
      { id: "c", run: async () => 3 },
    ];
    const out = await runFanout({ tasks, failurePolicy: FAILURE_POLICIES.CONTINUE });
    assert.equal(out.ok, false);
    assert.equal(out.stats.fulfilled, 2);
    assert.equal(out.stats.rejected, 1);
    assert.deepEqual(out.reduced, [1, 3]);
  });
  test("abort policy cancels pending on first failure", async () => {
    let executed = 0;
    const tasks = [
      {
        id: "a",
        run: async () => { executed += 1; throw new Error("boom"); },
      },
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `t${i}`,
        run: async ({ signal }) => {
          executed += 1;
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, 200);
            signal.addEventListener("abort", () => {
              clearTimeout(t);
              reject(new Error("aborted"));
            });
          });
          return i;
        },
      })),
    ];
    const out = await runFanout({
      tasks,
      concurrency: 2,
      failurePolicy: FAILURE_POLICIES.ABORT,
      taskTimeoutMs: 5_000,
    });
    assert.equal(out.ok, false);
    assert.ok(out.stoppedReason);
  });
});

// ── timeouts ───────────────────────────────────────────────────────

describe("runFanout — timeouts", () => {
  test("per-task timeout fires", async () => {
    const tasks = [
      { id: "slow", run: () => new Promise((r) => setTimeout(r, 200)) },
    ];
    const out = await runFanout({ tasks, taskTimeoutMs: 25 });
    assert.equal(out.ok, false);
    assert.equal(out.results[0].status, "timeout");
    assert.equal(out.stats.timeouts, 1);
  });
  test("aggregate timeout aborts the group", async () => {
    const tasks = Array.from({ length: 3 }, (_, i) => ({
      id: `t${i}`,
      run: () => new Promise((r) => setTimeout(r, 1000)),
    }));
    const out = await runFanout({
      tasks,
      concurrency: 1,
      taskTimeoutMs: 5000,
      aggregateTimeoutMs: 30,
    });
    assert.equal(out.ok, false);
    assert.ok(out.stats.aborted + out.stats.timeouts >= 1);
  });
});

// ── abort cascade ──────────────────────────────────────────────────

describe("runFanout — upstream abort", () => {
  test("aborts all tasks on signal", async () => {
    const ac = new AbortController();
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      id: `t${i}`,
      run: ({ signal }) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 1000);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          });
        }),
    }));
    const p = runFanout({
      tasks,
      concurrency: 5,
      taskTimeoutMs: 5000,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 20);
    const out = await p;
    assert.equal(out.ok, false);
    const aborted = out.results.filter((r) => r.status === "aborted").length;
    assert.ok(aborted >= 1);
  });
});

// ── input validation ───────────────────────────────────────────────

describe("runFanout — input validation", () => {
  test("rejects non-array tasks", async () => {
    await assert.rejects(() => runFanout({ tasks: null }), TypeError);
  });
  test("rejects bad concurrency", async () => {
    await assert.rejects(() => runFanout({ tasks: [], concurrency: 0 }), TypeError);
  });
  test("ignores tasks with non-function run", async () => {
    const out = await runFanout({
      tasks: [{ id: "x", run: null }, { id: "y", run: async () => 1 }],
    });
    assert.equal(out.results[0].ok, false);
    assert.equal(out.results[1].ok, true);
  });
});

// ── helpers ────────────────────────────────────────────────────────

describe("computeStats", () => {
  test("counts each status correctly", () => {
    const results = [
      { status: "fulfilled" },
      { status: "fulfilled" },
      { status: "rejected" },
      { status: "timeout" },
      { status: "aborted" },
    ];
    const s = computeStats(results, Date.now());
    assert.equal(s.fulfilled, 2);
    assert.equal(s.rejected, 1);
    assert.equal(s.timeouts, 1);
    assert.equal(s.aborted, 1);
    assert.equal(s.total, 5);
  });
});

describe("defaultReducer", () => {
  test("returns ok values in order", () => {
    const results = [
      { ok: true, value: "a" },
      { ok: false, value: "x" },
      { ok: true, value: "c" },
    ];
    assert.deepEqual(defaultReducer(results), ["a", "c"]);
  });
});
