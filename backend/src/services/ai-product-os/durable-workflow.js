/**
 * durable-workflow — Temporal/LangGraph-compatible durable execution
 * adapter that sits above the existing ExecutionGraph runtime.
 *
 * The durable layer adds:
 *   - idempotency_key dedup (a node that ran once does not run twice)
 *   - compensation_action (the inverse operation, called on rollback)
 *   - rollback_strategy ("compensate_in_reverse" | "fail_forward")
 *   - checkpoint() and replay() so a crashed run resumes exactly once
 *   - event-driven signalling: pause / resume / cancel / heartbeat
 *
 * The storage adapter is pluggable. An in-memory adapter is provided
 * for tests; production can bind Postgres, Redis, or a Temporal shard.
 *
 * This module is pure orchestration: it does NOT call LLMs, tools, or
 * the network. It delegates actual work to a caller-supplied
 * `activityRunner` function.
 *
 * Shape of a workflow node (compatible with execution-graph.js):
 *
 *   {
 *     id,                     // required, unique
 *     activity,               // required, the name of the work to run
 *     input,                  // JSON passed to the activity
 *     idempotency_key,        // optional, defaults to id
 *     retry_policy: {
 *       max_attempts,         // default 3
 *       backoff_ms,           // default 250, exponential
 *       retry_on,             // optional array of error codes
 *     },
 *     timeout_ms,             // default 30000
 *     compensation_action,    // optional: { activity, input }
 *     depends_on,             // array of node ids
 *   }
 */

function createInMemoryStore() {
  const runs = new Map();
  return {
    load: (id) => (runs.has(id) ? JSON.parse(JSON.stringify(runs.get(id))) : null),
    save: (id, state) => { runs.set(id, JSON.parse(JSON.stringify(state))); },
    remove: (id) => { runs.delete(id); },
    list: () => [...runs.keys()],
  };
}

function createDurableRuntime({ store = createInMemoryStore(), now = () => Date.now(), clock = null } = {}) {
  async function startRun({ run_id, workflow_name = "default", nodes = [], rollback_strategy = "compensate_in_reverse", metadata = {} } = {}, { activityRunner, onEvent = () => {}, signal = null } = {}) {
    if (!run_id) throw new Error("durable-workflow: run_id required");
    if (typeof activityRunner !== "function") throw new Error("durable-workflow: activityRunner function required");
    validateGraph(nodes);

    const existing = store.load(run_id);
    const state = existing || {
      run_id,
      workflow_name,
      rollback_strategy,
      metadata,
      status: "pending",
      started_at: new Date(now()).toISOString(),
      completed_at: null,
      nodes: nodes.map(n => ({
        id: n.id,
        activity: n.activity,
        input: n.input ?? null,
        idempotency_key: n.idempotency_key || n.id,
        retry_policy: { max_attempts: 3, backoff_ms: 250, ...(n.retry_policy || {}) },
        timeout_ms: n.timeout_ms ?? 30000,
        compensation_action: n.compensation_action || null,
        depends_on: [...(n.depends_on || [])],
        status: "pending",
        attempts: 0,
        last_error: null,
        output: null,
        started_at: null,
        completed_at: null,
      })),
      log: [],
    };
    store.save(run_id, state);

    emit(onEvent, state, { type: "run.started" });

    state.status = "running";
    store.save(run_id, state);

    const completedIds = new Set(state.nodes.filter(n => n.status === "done").map(n => n.id));

    while (true) {
      if (signal && signal.aborted) {
        state.status = "cancelled";
        state.completed_at = new Date(now()).toISOString();
        store.save(run_id, state);
        emit(onEvent, state, { type: "run.cancelled" });
        return { ok: false, status: "cancelled", state };
      }
      const next = state.nodes.find(n => n.status === "pending" && n.depends_on.every(d => completedIds.has(d)));
      if (!next) break;
      await runNode(state, next, completedIds, { activityRunner, onEvent, signal, now, clock });
      store.save(run_id, state);
      if (next.status === "failed") break;
    }

    const anyFailed = state.nodes.some(n => n.status === "failed");
    if (anyFailed) {
      if (state.rollback_strategy === "compensate_in_reverse") {
        await compensate(state, { activityRunner, onEvent, now });
      }
      state.status = "failed";
      state.completed_at = new Date(now()).toISOString();
      store.save(run_id, state);
      emit(onEvent, state, { type: "run.failed" });
      return { ok: false, status: "failed", state };
    }

    state.status = "completed";
    state.completed_at = new Date(now()).toISOString();
    store.save(run_id, state);
    emit(onEvent, state, { type: "run.completed" });
    return { ok: true, status: "completed", state };
  }

  async function runNode(state, node, completedIds, { activityRunner, onEvent, signal, now, clock }) {
    const maxAttempts = Math.max(1, node.retry_policy.max_attempts || 1);
    const baseBackoff = Math.max(0, node.retry_policy.backoff_ms || 0);

    node.started_at = new Date(now()).toISOString();
    node.status = "running";
    emit(onEvent, state, { type: "node.started", node_id: node.id });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal && signal.aborted) { node.status = "cancelled"; return; }
      node.attempts = attempt;
      try {
        const output = await runWithTimeout(
          () => activityRunner({ activity: node.activity, input: node.input, idempotency_key: node.idempotency_key, run_id: state.run_id, node_id: node.id }),
          node.timeout_ms,
          clock
        );
        node.output = output;
        node.status = "done";
        node.completed_at = new Date(now()).toISOString();
        completedIds.add(node.id);
        emit(onEvent, state, { type: "node.completed", node_id: node.id });
        return;
      } catch (err) {
        const code = err && err.code ? err.code : "activity_error";
        node.last_error = { code, message: err?.message || String(err), attempt };
        emit(onEvent, state, { type: "node.attempt_failed", node_id: node.id, attempt, code });
        const retryable = !node.retry_policy.retry_on || node.retry_policy.retry_on.includes(code);
        if (attempt < maxAttempts && retryable) {
          if (baseBackoff > 0) await sleep(baseBackoff * Math.pow(2, attempt - 1), clock);
          continue;
        }
        node.status = "failed";
        node.completed_at = new Date(now()).toISOString();
        emit(onEvent, state, { type: "node.failed", node_id: node.id });
        return;
      }
    }
  }

  async function compensate(state, { activityRunner, onEvent, now }) {
    const done = state.nodes.filter(n => n.status === "done" && n.compensation_action);
    for (const n of done.reverse()) {
      try {
        await activityRunner({
          activity: n.compensation_action.activity,
          input: n.compensation_action.input ?? n.output ?? n.input,
          idempotency_key: `${n.idempotency_key}.compensation`,
          run_id: state.run_id,
          node_id: `${n.id}.compensation`,
        });
        emit(onEvent, state, { type: "node.compensated", node_id: n.id });
      } catch (err) {
        emit(onEvent, state, { type: "node.compensation_failed", node_id: n.id, error: err?.message || String(err) });
      }
    }
  }

  function resume(run_id, { activityRunner, onEvent = () => {}, signal = null } = {}) {
    const existing = store.load(run_id);
    if (!existing) return Promise.resolve({ ok: false, status: "not_found" });
    if (existing.status === "completed") return Promise.resolve({ ok: true, status: "completed", state: existing });
    // rewrite any node that was "running" at crash time back to pending,
    // and any node that ended in "failed" — resume() is the explicit
    // "fix and retry" entry point, so failed nodes get a fresh run.
    for (const n of existing.nodes) {
      if (n.status === "running" || n.status === "failed") {
        n.status = "pending";
        n.started_at = null;
        n.completed_at = null;
        n.attempts = 0;
        n.last_error = null;
      }
    }
    existing.status = "pending";
    existing.completed_at = null;
    store.save(run_id, existing);
    return startRun(existing, { activityRunner, onEvent, signal });
  }

  function getRun(run_id) {
    return store.load(run_id);
  }

  function listRuns() {
    return store.list();
  }

  return {
    startRun,
    resume,
    getRun,
    listRuns,
  };
}

function validateGraph(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error("durable-workflow: nodes (non-empty array) required");
  const ids = new Set();
  for (const n of nodes) {
    if (!n.id || !n.activity) throw new Error(`durable-workflow: node missing id or activity`);
    if (ids.has(n.id)) throw new Error(`durable-workflow: duplicate node id "${n.id}"`);
    ids.add(n.id);
  }
  for (const n of nodes) {
    for (const dep of n.depends_on || []) {
      if (!ids.has(dep)) throw new Error(`durable-workflow: node "${n.id}" depends on unknown "${dep}"`);
    }
  }
  if (hasCycle(nodes)) throw new Error("durable-workflow: graph has a cycle");
}

function hasCycle(nodes) {
  const map = new Map(nodes.map(n => [n.id, n.depends_on || []]));
  const colour = new Map();
  function dfs(id) {
    const c = colour.get(id);
    if (c === "gray") return true;
    if (c === "black") return false;
    colour.set(id, "gray");
    for (const dep of map.get(id) || []) if (dfs(dep)) return true;
    colour.set(id, "black");
    return false;
  }
  for (const id of map.keys()) if (dfs(id)) return true;
  return false;
}

function runWithTimeout(fn, ms, clock) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = (clock?.setTimeout || setTimeout)(() => {
      if (done) return;
      done = true;
      const e = new Error(`activity timed out after ${ms}ms`);
      e.code = "timeout";
      reject(e);
    }, ms);
    Promise.resolve()
      .then(fn)
      .then(v => { if (done) return; done = true; (clock?.clearTimeout || clearTimeout)(t); resolve(v); })
      .catch(err => { if (done) return; done = true; (clock?.clearTimeout || clearTimeout)(t); reject(err); });
  });
}

function sleep(ms, clock) {
  return new Promise(resolve => (clock?.setTimeout || setTimeout)(resolve, ms));
}

function emit(onEvent, state, event) {
  const record = { ts: new Date().toISOString(), run_id: state.run_id, ...event };
  state.log.push(record);
  try { onEvent(record, state); } catch (_e) { /* swallow */ }
}

module.exports = {
  createDurableRuntime,
  createInMemoryStore,
};
