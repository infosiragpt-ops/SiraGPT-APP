/**
 * execution-graph — typed DAG that compiles a UniversalTaskContract
 * into a durable, resumable execution plan.
 *
 * An ExecutionGraph is the contract of HOW we'll do the work, the
 * same way a UniversalTaskContract is the contract of WHAT must be
 * delivered. Each node is one tool invocation (or sub-graph) with:
 *
 *   - id                 stable node identifier
 *   - tool               manifest name (must exist in the ToolRegistry)
 *   - inputs             JSON — typed input args
 *   - outputs            map of { name: "string" } — what the node exports
 *   - depends_on         predecessors whose outputs feed `inputs`
 *   - state              pending | running | done | failed | retrying | cancelled | skipped
 *   - retry_policy       { max_retries, backoff_ms, jitter_ms, on_error }
 *   - timeout_policy     { ms, on_timeout }
 *   - idempotency_key    stable hash so re-runs don't duplicate side-effects
 *   - cost_budget        { usd_max, tokens_max }
 *   - latency_budget     { ms_soft, ms_hard }
 *   - validation_gate    { tests[], blocking }
 *   - release_gate       { requires_human, approvers[] }
 *
 * Durability: the graph is a pure data structure; callers persist it
 * wherever they like (Postgres row, Redis hash, task-store). Replay
 * is a matter of re-hydrating the same shape; node state transitions
 * are explicit so crash recovery is well-defined.
 *
 * This module stays free of side effects: it builds, validates,
 * topologically-sorts, and state-transitions graphs. It does NOT
 * execute tools — the orchestrator does that, using this as the
 * book of record.
 */

const crypto = require("crypto");

const NODE_STATES = Object.freeze([
  "pending",
  "running",
  "done",
  "failed",
  "retrying",
  "cancelled",
  "skipped",
]);

const ON_ERROR_POLICIES = Object.freeze([
  "fail-fast",
  "continue",
  "retry-then-fail",
  "retry-then-skip",
  "rollback",
]);

const ON_TIMEOUT_POLICIES = Object.freeze([
  "fail",
  "soft-warning",
  "cancel-downstream",
]);

const DEFAULT_RETRY = Object.freeze({
  max_retries: 2,
  backoff_ms: 1500,
  jitter_ms: 300,
  on_error: "retry-then-fail",
});

const DEFAULT_TIMEOUT = Object.freeze({
  ms: 60000,
  on_timeout: "fail",
});

const DEFAULT_COST_BUDGET = Object.freeze({
  usd_max: 1.0,
  tokens_max: 40000,
});

const DEFAULT_LATENCY_BUDGET = Object.freeze({
  ms_soft: 60000,
  ms_hard: 300000,
});

/**
 * Build a single node descriptor with defaults filled in.
 */
function makeNode(partial) {
  if (!partial || typeof partial !== "object") throw new Error("makeNode: descriptor required");
  if (!partial.id || typeof partial.id !== "string") throw new Error("makeNode: id is required");
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(partial.id)) {
    throw new Error(`makeNode: id "${partial.id}" must match [a-zA-Z][a-zA-Z0-9_-]{0,63}`);
  }
  if (!partial.tool || typeof partial.tool !== "string") throw new Error(`makeNode(${partial.id}): tool required`);
  const depends_on = Array.isArray(partial.depends_on) ? [...partial.depends_on] : [];
  for (const d of depends_on) {
    if (typeof d !== "string" || !d) throw new Error(`makeNode(${partial.id}): depends_on must be strings`);
  }
  const retry = { ...DEFAULT_RETRY, ...(partial.retry_policy || {}) };
  if (!ON_ERROR_POLICIES.includes(retry.on_error)) {
    throw new Error(`makeNode(${partial.id}): unknown on_error "${retry.on_error}"`);
  }
  const timeout = { ...DEFAULT_TIMEOUT, ...(partial.timeout_policy || {}) };
  if (!ON_TIMEOUT_POLICIES.includes(timeout.on_timeout)) {
    throw new Error(`makeNode(${partial.id}): unknown on_timeout "${timeout.on_timeout}"`);
  }
  const cost = { ...DEFAULT_COST_BUDGET, ...(partial.cost_budget || {}) };
  const latency = { ...DEFAULT_LATENCY_BUDGET, ...(partial.latency_budget || {}) };
  const inputs = partial.inputs && typeof partial.inputs === "object" ? { ...partial.inputs } : {};
  const outputs = partial.outputs && typeof partial.outputs === "object" ? { ...partial.outputs } : {};

  // idempotency_key defaults to a stable hash of (tool + inputs + depends_on)
  // so re-running the exact same node doesn't duplicate side-effects.
  const idem = partial.idempotency_key || hashIdempotency({ tool: partial.tool, inputs, depends_on });

  return {
    id: partial.id,
    tool: partial.tool,
    label: typeof partial.label === "string" ? partial.label : partial.id,
    inputs,
    outputs,
    depends_on,
    state: partial.state && NODE_STATES.includes(partial.state) ? partial.state : "pending",
    attempt: typeof partial.attempt === "number" ? partial.attempt : 0,
    retry_policy: retry,
    timeout_policy: timeout,
    idempotency_key: idem,
    cost_budget: cost,
    latency_budget: latency,
    validation_gate: Array.isArray(partial.validation_gate?.tests)
      ? { tests: [...partial.validation_gate.tests], blocking: partial.validation_gate.blocking !== false }
      : { tests: [], blocking: true },
    release_gate: partial.release_gate && typeof partial.release_gate === "object"
      ? {
          requires_human: Boolean(partial.release_gate.requires_human),
          approvers: Array.isArray(partial.release_gate.approvers) ? [...partial.release_gate.approvers] : [],
        }
      : { requires_human: false, approvers: [] },
    result: partial.result === undefined ? null : partial.result,
    error: partial.error || null,
    startedAt: partial.startedAt || null,
    finishedAt: partial.finishedAt || null,
  };
}

function hashIdempotency({ tool, inputs, depends_on }) {
  const h = crypto.createHash("sha1");
  h.update(String(tool || ""));
  h.update(JSON.stringify(inputs || {}));
  h.update(JSON.stringify(depends_on || []));
  return h.digest("hex").slice(0, 16);
}

/**
 * Validate that `nodes` form a correct DAG: unique ids, every
 * depends_on refers to an existing node, no cycles, no self-loops.
 * Throws on failure.
 */
function validateGraph(nodes) {
  if (!Array.isArray(nodes)) throw new Error("validateGraph: nodes must be an array");
  const byId = new Map();
  for (const n of nodes) {
    if (!n || typeof n !== "object") throw new Error("validateGraph: node must be an object");
    if (!n.id) throw new Error("validateGraph: node.id required");
    if (byId.has(n.id)) throw new Error(`validateGraph: duplicate node id "${n.id}"`);
    byId.set(n.id, n);
  }
  for (const n of nodes) {
    for (const d of n.depends_on || []) {
      if (d === n.id) throw new Error(`validateGraph: node "${n.id}" depends on itself`);
      if (!byId.has(d)) throw new Error(`validateGraph: node "${n.id}" depends on missing "${d}"`);
    }
  }
  // Cycle detection via DFS colouring.
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(nodes.map(n => [n.id, WHITE]));
  function visit(id, trail) {
    if (color.get(id) === GRAY) {
      throw new Error(`validateGraph: cycle detected at ${trail.concat(id).join(" → ")}`);
    }
    if (color.get(id) === BLACK) return;
    color.set(id, GRAY);
    const node = byId.get(id);
    for (const d of node.depends_on || []) {
      visit(d, trail.concat(id));
    }
    color.set(id, BLACK);
  }
  for (const n of nodes) visit(n.id, []);
  return true;
}

/**
 * Kahn's topological sort. Returns an array of node ids in a legal
 * execution order (parents before children). Throws when the graph
 * has a cycle.
 */
function topoSort(nodes) {
  validateGraph(nodes);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const inDeg = new Map(nodes.map(n => [n.id, 0]));
  for (const n of nodes) for (const d of n.depends_on || []) inDeg.set(n.id, inDeg.get(n.id) + 1);
  const q = [];
  for (const [id, deg] of inDeg.entries()) if (deg === 0) q.push(id);
  const order = [];
  while (q.length) {
    const id = q.shift();
    order.push(id);
    for (const m of nodes) {
      if ((m.depends_on || []).includes(id)) {
        inDeg.set(m.id, inDeg.get(m.id) - 1);
        if (inDeg.get(m.id) === 0) q.push(m.id);
      }
    }
  }
  if (order.length !== nodes.length) throw new Error("topoSort: cycle detected (or disconnected components)");
  return order;
}

/**
 * Build an ExecutionGraph wrapper: { version, nodes, meta, counts }.
 * @param {object} args
 * @param {Array<object>} args.nodes
 * @param {object} [args.meta] — free-form (taskId, contractId, ...)
 */
function buildExecutionGraph({ nodes, meta }) {
  const resolved = (nodes || []).map(makeNode);
  validateGraph(resolved);
  const counts = countStates(resolved);
  return {
    version: "1.0",
    meta: meta && typeof meta === "object" ? { ...meta } : {},
    nodes: resolved,
    order: topoSort(resolved),
    counts,
    createdAt: new Date().toISOString(),
  };
}

function countStates(nodes) {
  const counts = { pending: 0, running: 0, done: 0, failed: 0, retrying: 0, cancelled: 0, skipped: 0 };
  for (const n of nodes || []) {
    if (counts[n.state] !== undefined) counts[n.state]++;
  }
  return counts;
}

/**
 * Return the ids of nodes that are ready to execute right now
 * (state=pending AND all dependencies are state=done|skipped).
 */
function readyNodes(graph) {
  const done = new Set(graph.nodes.filter(n => n.state === "done" || n.state === "skipped").map(n => n.id));
  return graph.nodes
    .filter(n => n.state === "pending" && (n.depends_on || []).every(d => done.has(d)))
    .map(n => n.id);
}

/**
 * Transition a node to a new state with optional metadata; returns
 * the updated node. Throws on illegal transition.
 */
function transitionNode(graph, id, nextState, patch = {}) {
  const n = graph.nodes.find(x => x.id === id);
  if (!n) throw new Error(`transitionNode: node "${id}" not found`);
  if (!NODE_STATES.includes(nextState)) throw new Error(`transitionNode: unknown state "${nextState}"`);
  const cur = n.state;
  const legal = {
    // pending → failed permits the deadlock-sweep path where an
    // upstream failure blocks a node we never got to run.
    pending:   new Set(["running", "cancelled", "skipped", "failed"]),
    // running → skipped / cancelled covers timeout-soft + retry-
    // then-skip policies without the caller having to two-step
    // through `failed` first.
    running:   new Set(["done", "failed", "retrying", "cancelled", "skipped"]),
    retrying:  new Set(["running", "failed", "cancelled", "skipped"]),
    done:      new Set([]),
    failed:    new Set(["retrying", "cancelled", "skipped"]),
    cancelled: new Set([]),
    skipped:   new Set([]),
  };
  if (!legal[cur]?.has(nextState)) {
    throw new Error(`transitionNode: illegal transition ${cur} → ${nextState} for "${id}"`);
  }
  n.state = nextState;
  if (nextState === "running" && !n.startedAt) n.startedAt = new Date().toISOString();
  if (["done", "failed", "cancelled", "skipped"].includes(nextState)) n.finishedAt = new Date().toISOString();
  if (patch.result !== undefined) n.result = patch.result;
  if (patch.error !== undefined) n.error = patch.error;
  if (typeof patch.attempt === "number") n.attempt = patch.attempt;
  graph.counts = countStates(graph.nodes);
  return n;
}

/**
 * Whether the entire graph has reached a terminal state — every
 * node is done/failed/cancelled/skipped.
 */
function isComplete(graph) {
  return graph.nodes.every(n => ["done", "failed", "cancelled", "skipped"].includes(n.state));
}

function overallOutcome(graph) {
  if (!isComplete(graph)) return "in-progress";
  if (graph.nodes.some(n => n.state === "failed")) return "failed";
  if (graph.nodes.some(n => n.state === "cancelled")) return "cancelled";
  return "done";
}

module.exports = {
  NODE_STATES,
  ON_ERROR_POLICIES,
  ON_TIMEOUT_POLICIES,
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT,
  DEFAULT_COST_BUDGET,
  DEFAULT_LATENCY_BUDGET,
  makeNode,
  validateGraph,
  topoSort,
  buildExecutionGraph,
  countStates,
  readyNodes,
  transitionNode,
  isComplete,
  overallOutcome,
  hashIdempotency,
};
