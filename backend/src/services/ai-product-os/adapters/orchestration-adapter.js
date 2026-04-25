/**
 * orchestration-adapter — contract for the "Orquestación avanzada" layer.
 *
 * Designed to bind cleanly to:
 *   - LangGraph  (stateful agent graphs, persistent state, human-in-loop)
 *   - DBOS       (workflows that resume from the last completed step)
 *   - Temporal   (durable workflow executions, signals, timers)
 *
 * The adapter is a CONTRACT. The platform never imports any of those
 * libraries directly; the caller passes a `provider` that satisfies
 * the interface below. Default is an in-memory deterministic stub
 * built on the existing durable-workflow.js runtime.
 *
 * Public methods:
 *
 *   defineWorkflow({ id, version, schema, handler })
 *     → registers a workflow definition the runtime can replay.
 *
 *   startWorkflow(workflow_id, input, { idempotency_key, signal })
 *     → returns { run_id, status } and starts execution.
 *
 *   getRun(run_id)        → { status, history, output? }
 *
 *   signal(run_id, name, payload)  → injects an external event.
 *
 *   pause(run_id) / resume(run_id) / cancel(run_id)
 *
 *   describeCheckpoint(run_id)  → last persisted state for replay.
 */

const { createDurableRuntime, createInMemoryStore } = require("../durable-workflow");

const VENDORS = Object.freeze(["langgraph", "dbos", "temporal", "stub"]);

function createOrchestrationAdapter({ provider = null, vendor = "stub" } = {}) {
  if (!VENDORS.includes(vendor)) throw new Error(`orchestration-adapter: unknown vendor "${vendor}"`);
  const impl = provider || createStubProvider();
  validateProvider(impl);

  return {
    vendor,
    provider: impl,

    defineWorkflow(def) {
      validateDef(def);
      return impl.defineWorkflow(def);
    },
    startWorkflow(workflowId, input, opts = {}) {
      if (!workflowId) throw new Error("orchestration-adapter.startWorkflow: workflowId required");
      return impl.startWorkflow(workflowId, input, opts);
    },
    getRun(runId) { return impl.getRun(runId); },
    signal(runId, name, payload) { return impl.signal(runId, name, payload); },
    pause(runId) { return impl.pause(runId); },
    resume(runId) { return impl.resume(runId); },
    cancel(runId) { return impl.cancel(runId); },
    describeCheckpoint(runId) { return impl.describeCheckpoint(runId); },

    capabilities() {
      return {
        vendor,
        durable: true,
        supports_signals: Boolean(impl.supports_signals),
        supports_human_in_the_loop: Boolean(impl.supports_human_in_the_loop),
        supports_long_running: Boolean(impl.supports_long_running),
        supports_replay: Boolean(impl.supports_replay),
      };
    },
  };
}

function validateDef(def) {
  if (!def || typeof def !== "object") throw new Error("orchestration-adapter.defineWorkflow: def required");
  if (!def.id) throw new Error("orchestration-adapter.defineWorkflow: id required");
  if (typeof def.handler !== "function" && !Array.isArray(def.nodes)) {
    throw new Error("orchestration-adapter.defineWorkflow: handler() or nodes[] required");
  }
}

function validateProvider(p) {
  for (const m of ["defineWorkflow", "startWorkflow", "getRun", "signal", "pause", "resume", "cancel", "describeCheckpoint"]) {
    if (typeof p[m] !== "function") throw new Error(`orchestration-adapter: provider missing ${m}()`);
  }
}

/**
 * Deterministic stub built on top of the existing durable-workflow.js
 * runtime. Real LangGraph / Temporal / DBOS implementations replace
 * this object at construction time.
 */
function createStubProvider() {
  const definitions = new Map();   // workflow_id → definition
  const store = createInMemoryStore();
  const runtime = createDurableRuntime({ store });
  let runSeq = 0;

  return {
    supports_signals: true,
    supports_human_in_the_loop: true,
    supports_long_running: true,
    supports_replay: true,

    defineWorkflow(def) {
      definitions.set(def.id, def);
      return { id: def.id, version: def.version || "1.0", registered_at: new Date().toISOString() };
    },

    async startWorkflow(workflowId, input, opts = {}) {
      const def = definitions.get(workflowId);
      if (!def) throw new Error(`orchestration-adapter: workflow "${workflowId}" not defined`);
      const runId = opts.run_id || `${workflowId}.${++runSeq}_${Math.random().toString(16).slice(2, 8)}`;
      const nodes = def.nodes && def.nodes.length > 0 ? def.nodes : [{ id: "main", activity: workflowId, input }];
      const r = await runtime.startRun({
        run_id: runId,
        workflow_name: workflowId,
        nodes,
        rollback_strategy: def.rollback_strategy || "compensate_in_reverse",
        metadata: { idempotency_key: opts.idempotency_key || runId },
      }, {
        activityRunner: async ({ activity, input: nodeInput }) => {
          if (typeof def.handler === "function") return def.handler({ activity, input: nodeInput });
          return { activity, output: nodeInput };
        },
        signal: opts.signal,
      });
      return { run_id: runId, status: r.status };
    },

    getRun(runId) {
      const state = runtime.getRun(runId);
      if (!state) return null;
      return { status: state.status, history: state.log || [], output: state.nodes?.slice(-1)[0]?.output ?? null };
    },

    signal(runId, name, payload) {
      const state = runtime.getRun(runId);
      if (!state) return { ok: false, reason: "run_not_found" };
      state.log = state.log || [];
      state.log.push({ ts: new Date().toISOString(), type: `signal.${name}`, payload, run_id: runId });
      return { ok: true };
    },

    pause(runId) {
      const state = runtime.getRun(runId);
      if (!state) return { ok: false };
      state.status = "paused";
      return { ok: true };
    },
    resume(runId) {
      return runtime.resume(runId, { activityRunner: async ({ input }) => ({ output: input, resumed: true }) });
    },
    cancel(runId) {
      const state = runtime.getRun(runId);
      if (!state) return { ok: false };
      state.status = "cancelled";
      return { ok: true };
    },
    describeCheckpoint(runId) {
      return runtime.getRun(runId);
    },
  };
}

module.exports = {
  createOrchestrationAdapter,
  createStubProvider,
  VENDORS,
};
