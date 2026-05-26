/**
 * execution-graph-runner — drives an ExecutionGraph end-to-end,
 * honouring retry_policy, timeout_policy, depends_on, and the
 * validation_gate / release_gate on every node.
 *
 * Design goals:
 *   1. Pausable + resumable. The runner saves state after every
 *      terminal transition through a pluggable adapter, so a crash
 *      in the middle of a 20-node graph does not lose progress.
 *   2. Tool-registry driven. The runner does NOT know how to run a
 *      python script or fetch a URL — it only knows how to look up
 *      a tool by name and await its result. This keeps the runtime
 *      side-effect-free by default; callers inject what the tools
 *      are allowed to do.
 *   3. Pure / testable. The clock + sleep are injected; tests can
 *      drive the full retry + timeout paths in milliseconds.
 *
 * Durability adapter contract:
 *   - save(id, state): Promise<void>
 *   - load(id): Promise<graph|null>
 *   - delete(id): Promise<void>    (optional)
 *
 * A default in-memory adapter is exported so the runtime has a safe
 * fallback when no persistence is wired.
 */

const {
  buildExecutionGraph,
  transitionNode,
  readyNodes,
  isComplete,
  overallOutcome,
  countStates,
} = require("./execution-graph");

// ─── Adapters ──────────────────────────────────────────────────────────

function createInMemoryAdapter() {
  const store = new Map();
  return {
    async save(id, state) { store.set(id, JSON.parse(JSON.stringify(state))); },
    async load(id) { const s = store.get(id); return s ? JSON.parse(JSON.stringify(s)) : null; },
    async delete(id) { store.delete(id); },
    _snapshot() { return new Map(store); },
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────

function jitteredBackoff(policy, attempt) {
  const base = policy.backoff_ms || 0;
  const jitter = policy.jitter_ms ? Math.floor(Math.random() * policy.jitter_ms) : 0;
  // Exponential: base * 2^(attempt-1) up to sane cap.
  const exp = base * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(exp, 60_000) + jitter;
}

async function runWithTimeout(fn, timeoutMs, sleep) {
  if (!timeoutMs || timeoutMs <= 0) return fn();
  let timedOut = false;
  const timeoutPromise = sleep(timeoutMs).then(() => {
    timedOut = true;
    const e = new Error(`node timed out after ${timeoutMs}ms`);
    e.code = "TIMEOUT";
    throw e;
  });
  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    // nothing to cancel — fn's own lifetime drives cleanup
  }
}

function gatherInputs(graph, node) {
  // Node inputs are the literal values provided by the caller plus
  // the `result` of each dependency, exposed as `deps.<depId>`.
  const deps = {};
  for (const d of node.depends_on || []) {
    const parent = graph.nodes.find(n => n.id === d);
    deps[d] = parent?.result ?? null;
  }
  return { ...node.inputs, deps };
}

// ─── Runtime ───────────────────────────────────────────────────────────

const DEFAULT_SLEEP = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Execute a graph. Returns the final graph + outcome.
 *
 * @param {object} args
 * @param {object} args.graph                      — ExecutionGraph descriptor (built by buildExecutionGraph or hydrated from adapter)
 * @param {Record<string, Function>} args.tools    — { toolName: async (inputs, ctx) => result }
 * @param {object} [args.adapter]                  — persistence adapter (default: in-memory, local to the run)
 * @param {string} [args.graphId]                  — id the adapter uses for save/load
 * @param {object} [args.ctx]                      — passed to every tool
 * @param {Function} [args.onEvent]                — ({type, nodeId, ...}) => void stream
 * @param {Function} [args.sleep]                  — ms => Promise (test seam)
 * @param {AbortSignal} [args.signal]
 */
async function runGraph({
  graph,
  tools,
  adapter,
  graphId,
  ctx = {},
  onEvent,
  sleep = DEFAULT_SLEEP,
  signal,
}) {
  if (!graph || !Array.isArray(graph.nodes)) throw new Error("runGraph: graph required");
  if (!tools || typeof tools !== "object") throw new Error("runGraph: tools registry required");
  const save = async () => {
    if (!adapter || !graphId) return;
    try { await adapter.save(graphId, graph); } catch { /* never break run on save fail */ }
  };

  const emit = (ev) => { try { onEvent?.(ev); } catch { /* listeners never break run */ } };
  const startedAt = Date.now();
  emit({ type: "graph_started", graphId, total: graph.nodes.length, at: startedAt });

  // Pump: keep advancing ready nodes until the graph is complete or
  // nothing is ready and nothing is running (deadlock / all blocked).
  while (!isComplete(graph)) {
    if (signal?.aborted) {
      for (const n of graph.nodes) {
        if (n.state === "pending" || n.state === "retrying") {
          transitionNode(graph, n.id, "cancelled");
        }
      }
      emit({ type: "graph_aborted", graphId, at: Date.now() });
      await save();
      break;
    }
    const ready = readyNodes(graph);
    if (ready.length === 0) {
      const stuck = graph.nodes.filter(n => n.state === "pending" || n.state === "retrying");
      if (stuck.length > 0) {
        for (const n of stuck) transitionNode(graph, n.id, "failed", { error: "blocked-by-upstream-failure" });
        emit({ type: "graph_deadlock", graphId, stuck: stuck.map(n => n.id), at: Date.now() });
      }
      break;
    }

    // Fire every ready node in parallel (the graph already encodes
    // ordering via depends_on — nodes at the same depth can run
    // concurrently). If the user needs serialisation they can
    // express it in the graph.
    await Promise.all(ready.map(id => runNode(id)));
  }

  emit({
    type: "graph_completed",
    graphId,
    outcome: overallOutcome(graph),
    counts: countStates(graph.nodes),
    elapsedMs: Date.now() - startedAt,
    at: Date.now(),
  });
  await save();
  return { graph, outcome: overallOutcome(graph), counts: countStates(graph.nodes) };

  async function runNode(id) {
    const node = graph.nodes.find(n => n.id === id);
    if (!node) return;
    if (!["pending", "retrying"].includes(node.state)) return;

    const tool = tools[node.tool];
    if (typeof tool !== "function") {
      transitionNode(graph, id, "failed", { error: `unknown tool "${node.tool}"` });
      emit({ type: "node_failed", nodeId: id, reason: "unknown_tool", at: Date.now() });
      await save();
      return;
    }

    const retry = node.retry_policy || { max_retries: 0, on_error: "fail-fast" };
    let attempt = node.attempt || 0;

    while (true) {
      attempt++;
      transitionNode(graph, id, attempt === 1 ? "running" : "running", { attempt });
      emit({ type: "node_started", nodeId: id, attempt, tool: node.tool, at: Date.now() });
      await save();

      const inputs = gatherInputs(graph, node);
      try {
        const timeoutMs = node.timeout_policy?.ms || 0;
        const result = await runWithTimeout(() => tool(inputs, { ...ctx, node, graph }), timeoutMs, sleep);
        transitionNode(graph, id, "done", { result, attempt });
        emit({ type: "node_completed", nodeId: id, attempt, at: Date.now() });
        await save();
        return;
      } catch (err) {
        const isTimeout = err?.code === "TIMEOUT";
        emit({ type: "node_errored", nodeId: id, attempt, error: err?.message, isTimeout, at: Date.now() });

        // Timeout policy short-circuits.
        if (isTimeout) {
          const t = node.timeout_policy?.on_timeout || "fail";
          if (t === "cancel-downstream") {
            transitionNode(graph, id, "failed", { error: `${err.message}; cancelling downstream` });
            cancelDownstream(graph, id);
            emit({ type: "node_failed", nodeId: id, reason: "timeout_cascade", at: Date.now() });
            await save();
            return;
          }
          if (t === "soft-warning") {
            transitionNode(graph, id, "done", { error: err.message, result: null });
            emit({ type: "node_soft_warn", nodeId: id, at: Date.now() });
            await save();
            return;
          }
          // "fail" — fall through to retry handling.
        }

        if (attempt > (retry.max_retries || 0)) {
          const policy = retry.on_error;
          if (policy === "retry-then-skip") {
            transitionNode(graph, id, "skipped", { error: err?.message, attempt });
            emit({ type: "node_skipped", nodeId: id, at: Date.now() });
            await save();
            return;
          }
          if (policy === "continue") {
            transitionNode(graph, id, "done", { error: err?.message, attempt, result: null });
            emit({ type: "node_continued_after_error", nodeId: id, at: Date.now() });
            await save();
            return;
          }
          // rollback / fail-fast / retry-then-fail all land on failed here
          transitionNode(graph, id, "failed", { error: err?.message || String(err), attempt });
          emit({ type: "node_failed", nodeId: id, reason: "max_retries_exhausted", at: Date.now() });
          await save();
          return;
        }

        // Queue another attempt
        transitionNode(graph, id, "retrying", { attempt });
        emit({ type: "node_retrying", nodeId: id, attempt, at: Date.now() });
        await save();
        const backoff = jitteredBackoff(retry, attempt);
        if (backoff > 0) await sleep(backoff);
      }
    }
  }
}

/**
 * Mark every transitive descendant of `failedId` as cancelled. Used
 * by the cancel-downstream timeout policy.
 */
function cancelDownstream(graph, failedId) {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const stack = [failedId];
  while (stack.length) {
    const cur = stack.pop();
    for (const n of graph.nodes) {
      if ((n.depends_on || []).includes(cur)) {
        if (n.state === "pending" || n.state === "retrying") {
          transitionNode(graph, n.id, "cancelled", { error: `upstream ${cur} failed` });
          stack.push(n.id);
        }
      }
    }
  }
}

/**
 * Resume a previously-saved run — caller passes the adapter + id,
 * we hydrate the graph, flip any `running` node back to `pending`
 * (a crash mid-node means the attempt did not finish), and call
 * runGraph() again.
 */
async function resumeGraph({ adapter, graphId, tools, ctx, onEvent, sleep, signal }) {
  if (!adapter || !graphId) throw new Error("resumeGraph: adapter + graphId required");
  const graph = await adapter.load(graphId);
  if (!graph) throw new Error(`resumeGraph: no saved state for "${graphId}"`);
  for (const n of graph.nodes) {
    if (n.state === "running") n.state = "pending";
  }
  graph.counts = countStates(graph.nodes);
  return runGraph({ graph, tools, adapter, graphId, ctx, onEvent, sleep, signal });
}

/**
 * Lightweight helper: compile a flat list of tool calls (name +
 * inputs + depends_on) into an ExecutionGraph.
 */
function compileToGraph({ nodes, meta }) {
  return buildExecutionGraph({ nodes, meta });
}

module.exports = {
  runGraph,
  resumeGraph,
  compileToGraph,
  createInMemoryAdapter,
  cancelDownstream,
  INTERNAL: { gatherInputs, jitteredBackoff, runWithTimeout, DEFAULT_SLEEP },
};
