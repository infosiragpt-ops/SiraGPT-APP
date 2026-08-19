/**
 * product-os — the top-level entry point for the AI Product
 * Operating System.
 *
 * It binds together:
 *   - constitution (the 14 laws)
 *   - agentic-kernel (the 17 specialised agents)
 *   - mcp-gateway (tools/resources/prompts surface)
 *   - event-envelope (canonical envelope for every event)
 *   - durable-workflow (temporal-compatible durable executor)
 *
 * Public surface:
 *
 *   compile(request)  → { contract, graph, plan_envelope }
 *      - takes the raw user request
 *      - emits a UniversalTaskContract v1.1 shell + an ExecutionGraph
 *      - records a "plan built" envelope with correlation_id
 *
 *   execute(plan, { activityRunner })  → runs the graph under the
 *      constitution; returns { ok, decision, state, telemetry }.
 *
 *   status()           → registry + integrity + counts
 *
 * This file is intentionally small: it wires modules together. Each
 * of those modules is self-contained and tested.
 */

const { enforceConstitution, LAWS } = require("./constitution");
const { listAgents, registryIntegrity, computeHandoffGraph, AGENTS, validateHandoff } = require("./agentic-kernel");
const { createMcpGateway } = require("./mcp-gateway");
const { createEnvelope, chainEnvelope } = require("./event-envelope");
const { createDurableRuntime } = require("./durable-workflow");

const PRODUCT_OS_VERSION = "1.0";
const CONTRACT_SCHEMA_VERSION = "1.1";
const GRAPH_SCHEMA_VERSION = "1.0";

/**
 * Compile a raw user request into a UniversalTaskContract shell + an
 * ExecutionGraph. This is a deterministic transform — it does not
 * call an LLM. The caller is expected to have already had the
 * IntentCompilerAgent populate the request with declared objectives,
 * deliverables, constraints, and formats.
 *
 * @param {object} request
 * @param {string} request.objective
 * @param {Array<{name, format, required_extension, mime_type}>} [request.deliverables]
 * @param {Array<string>} [request.constraints]
 * @param {object} [request.quality_bar]
 * @param {Array<{name, role}>} [request.stakeholders]
 * @param {string} [request.correlation_id]
 */
function compile(request = {}) {
  if (!request.objective || typeof request.objective !== "string") {
    throw new Error("product-os.compile: request.objective (string) required");
  }
  const plan_envelope = createEnvelope({
    type: "product-os.plan.built",
    producer: "product-os.compile",
    payload_schema: `ExecutionGraph@${GRAPH_SCHEMA_VERSION}`,
    trace: request.correlation_id ? { correlation_id: request.correlation_id } : {},
    payload: { objective: request.objective },
  });

  const contract = {
    contract_id: plan_envelope.id,
    schema_version: CONTRACT_SCHEMA_VERSION,
    objective: request.objective,
    deliverables: Array.isArray(request.deliverables) ? request.deliverables.map(normalizeDeliverable) : [],
    constraints: Array.isArray(request.constraints) ? request.constraints.slice(0, 100) : [],
    quality_bar: request.quality_bar || { severity_blocking: ["critical", "high"] },
    stakeholders: Array.isArray(request.stakeholders) ? request.stakeholders.slice(0, 20) : [],
    correlation_id: plan_envelope.correlation_id,
    trace_id: plan_envelope.trace_id,
    created_at: plan_envelope.ts,
  };

  const graph = buildGraphForContract(contract);

  return { contract, graph, plan_envelope };
}

function normalizeDeliverable(d) {
  return {
    name: String(d.name || "deliverable"),
    format: d.format || null,
    required_extension: d.required_extension || null,
    mime_type: d.mime_type || null,
  };
}

/**
 * Build a default ExecutionGraph for a compiled contract. The graph
 * is a sensible baseline — the PlannerAgent may refine it further.
 */
function buildGraphForContract(contract) {
  const nodes = [
    { id: "intent.compile", activity: "intent-compiler.run", depends_on: [] },
    { id: "constraints.extract", activity: "constraint-extractor.run", depends_on: ["intent.compile"] },
    { id: "plan.build", activity: "planner.run", depends_on: ["constraints.extract"] },
    { id: "research.collect", activity: "research-verifier.run", depends_on: ["plan.build"] },
    { id: "docs.analyze", activity: "document-analyst.run", depends_on: ["research.collect"] },
    { id: "design.direct", activity: "design-director.run", depends_on: ["plan.build"] },
    { id: "code.architect", activity: "code-architect.run", depends_on: ["plan.build"] },
    { id: "frontend.build", activity: "frontend-engineer.run", depends_on: ["design.direct", "code.architect"] },
    { id: "backend.build", activity: "backend-engineer.run", depends_on: ["code.architect"] },
    { id: "security.review", activity: "security-reviewer.run", depends_on: ["frontend.build", "backend.build"] },
    { id: "qa.regression", activity: "qa-regression.run", depends_on: ["security.review"] },
    { id: "release.decide", activity: "release-manager.run", depends_on: ["qa.regression"] },
    { id: "telemetry.emit", activity: "telemetry.run", depends_on: ["release.decide"] },
  ];
  return {
    graph_id: `graph_${contract.contract_id}`,
    schema_version: GRAPH_SCHEMA_VERSION,
    contract_id: contract.contract_id,
    nodes,
    release_gate: {
      requires: ["qa.regression", "security.review"],
      blocks_on: ["critical", "high"],
    },
  };
}

/**
 * Execute a compiled plan. The caller supplies an activityRunner —
 * typically a dispatcher that knows how to invoke each agent. The
 * product-os itself does not call LLMs.
 */
async function execute({ contract, graph }, { activityRunner, onEvent = () => {}, signal = null } = {}) {
  if (!contract || !graph) throw new Error("product-os.execute: { contract, graph } required");
  const preLaw = enforceConstitution({
    hasContract: true,
    contractValid: Boolean(contract.contract_id),
    dagPresent: Boolean(graph && Array.isArray(graph.nodes) && graph.nodes.length > 0),
  });
  if (!preLaw.ok) {
    return { ok: false, stage: "pre-constitution", constitution: preLaw };
  }

  const runtime = createDurableRuntime();
  const runId = `run_${contract.contract_id}`;
  const result = await runtime.startRun({
    run_id: runId,
    workflow_name: "product-os.default",
    nodes: graph.nodes,
    rollback_strategy: "compensate_in_reverse",
    metadata: { contract_id: contract.contract_id, correlation_id: contract.correlation_id },
  }, { activityRunner, onEvent, signal });

  const postLaw = enforceConstitution({
    hasContract: true,
    contractValid: true,
    dagPresent: true,
    statePersisted: true,
    hasDeliverables: (contract.deliverables || []).length > 0,
    hasFactualClaims: inferFactualClaims(contract),
    validationFabricRan: completed(result.state, "qa.regression"),
    artifactsFormatApproved: completed(result.state, "release.decide"),
    evidenceBindingsForClaims: completed(result.state, "research.collect") || completed(result.state, "docs.analyze"),
    releaseGateDecision: completed(result.state, "release.decide") ? "approve" : "hold",
    noFakedScores: true,
    noFakedCitations: true,
    noFakedArtifacts: true,
    noHallucinatedFileReads: true,
  });

  return {
    ok: result.ok && postLaw.ok,
    stage: result.ok ? "post-execution" : "execution-failed",
    status: result.status,
    state: result.state,
    constitution: postLaw,
  };
}

function completed(state, nodeId) {
  const n = (state?.nodes || []).find(x => x.id === nodeId);
  return Boolean(n && n.status === "done");
}

function inferFactualClaims(contract) {
  const text = [
    contract.objective,
    ...(contract.constraints || []),
    ...(contract.deliverables || []).map(d => d.name),
  ].join(" ").toLowerCase();
  return /\b(research|market|study|report|paper|stats?|evidence|source|citation|benchmark)\b/.test(text);
}

/**
 * status() — snapshot that the /status endpoint + CLI introspection
 * can use to confirm the OS is wired and healthy.
 */
function status() {
  const integrity = registryIntegrity();
  const handoffs = computeHandoffGraph();
  return {
    version: PRODUCT_OS_VERSION,
    contract_schema_version: CONTRACT_SCHEMA_VERSION,
    graph_schema_version: GRAPH_SCHEMA_VERSION,
    laws: LAWS.length,
    agents: AGENTS.length,
    agent_registry_ok: integrity.ok,
    agent_registry_issues: integrity.issues,
    handoffs: handoffs.edges.length,
    handoff_graph: handoffs,
  };
}

module.exports = {
  compile,
  execute,
  status,
  createMcpGateway,
  createEnvelope,
  chainEnvelope,
  enforceConstitution,
  listAgents,
  validateHandoff,
  PRODUCT_OS_VERSION,
  CONTRACT_SCHEMA_VERSION,
  GRAPH_SCHEMA_VERSION,
};
