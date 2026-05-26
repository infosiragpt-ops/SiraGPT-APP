/**
 * planner-agent — turns a RouterDecision + ToolRegistry into a
 * concrete ExecutionGraph that the durable runtime can run.
 *
 * The planner is deterministic. It does NOT call an LLM — that's the
 * IntentCompilerAgent's job upstream. Given a router decision and the
 * tool registry, it emits:
 *
 *   {
 *     graph_id,
 *     contract_id,
 *     intent_primary,
 *     final_output,
 *     nodes: [{ id, activity, agent, tool, depends_on, retry_policy,
 *               timeout_ms, validation_gate, human_approval_gate,
 *               release_gate, idempotency_key }],
 *     release_gate: { requires, blocks_on },
 *     observability: { trace_id_required, span_per_node },
 *   }
 *
 * Plans are reproducible: same router decision + same registry →
 * same graph (modulo trace/span ids which the runtime adds).
 *
 * The planner enforces a few invariants:
 *   - intent-compiler always runs first
 *   - planner node never appears in the graph it produces (avoid loop)
 *   - if intent needs evidence, research-verifier and document-analyst
 *     are wired before the build phase
 *   - security-reviewer is added before release-manager whenever code/
 *     web-app artefacts appear
 *   - release-manager and telemetry are always last
 */

const { byId: getTool, recommendedFor } = require("./tool-registry");
const { getAgent } = require("./agentic-kernel");

const DEFAULT_RETRY_POLICY = Object.freeze({ max_attempts: 3, backoff_ms: 250 });
const DEFAULT_TIMEOUT_MS = 30000;

function planFromDecision(decision, options = {}) {
  if (!decision || typeof decision !== "object" || !decision.intent_primary) {
    throw new Error("planner-agent: RouterDecision required");
  }
  const intent = decision.intent_primary;
  const contractId = options.contract_id || `contract_${Math.random().toString(16).slice(2, 12)}`;
  const graphId = `graph_${contractId}`;

  // Validate every agent + tool against the registries.
  const agents = (decision.required_agents || [])
    .filter(id => getAgent(id))
    .filter((id, i, a) => a.indexOf(id) === i);

  const tools = (decision.required_tools || [])
    .filter(id => getTool(id))
    .filter((id, i, a) => a.indexOf(id) === i);

  // Always include intent-compiler.
  const ensure = (id) => { if (!agents.includes(id)) agents.unshift(id); };
  ensure("intent-compiler");

  // Phase planner — the canonical 5-phase shape.
  const phases = computePhases(intent, agents, tools, decision, options);

  const nodes = [];
  let prevPhaseTail = null;

  for (const phase of phases) {
    const phaseNodes = phase.nodes;
    if (phaseNodes.length === 0) continue;
    for (const n of phaseNodes) {
      const id = n.id;
      const depends_on = n.depends_on != null
        ? n.depends_on
        : (prevPhaseTail ? [prevPhaseTail] : []);
      nodes.push({
        id,
        activity: n.activity,
        agent: n.agent,
        tool: n.tool || null,
        depends_on,
        retry_policy: { ...DEFAULT_RETRY_POLICY, ...(n.retry_policy || {}) },
        timeout_ms: n.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        validation_gate: n.validation_gate || null,
        human_approval_gate: n.human_approval_gate || null,
        release_gate: n.release_gate || null,
        idempotency_key: n.idempotency_key || `${graphId}.${id}`,
      });
    }
    prevPhaseTail = phaseNodes[phaseNodes.length - 1].id;
  }

  return {
    graph_id: graphId,
    contract_id: contractId,
    intent_primary: intent,
    final_output: decision.final_output,
    nodes,
    release_gate: {
      requires: nodes.filter(n => n.id.startsWith("validate.") || n.id.startsWith("qa.") || n.id.startsWith("security.")).map(n => n.id),
      blocks_on: ["critical", "high"],
    },
    observability: {
      trace_id_required: true,
      span_per_node: true,
    },
    trace: {
      decision_tier: decision.tier || "regex",
      decision_confidence: decision.confidence,
      needs_clarification: Boolean(decision.needs_clarification),
    },
  };
}

/**
 * Compute the canonical phases — intent → constraints → research →
 * build → validate → release → telemetry. Phases that don't apply for
 * the given intent are pruned.
 */
function computePhases(intent, agents, tools, decision, options) {
  const has = (id) => agents.includes(id);
  const phaseList = [];

  // Phase 1: intent compilation — always.
  phaseList.push({
    name: "intent",
    nodes: [{
      id: "intent.compile",
      agent: "intent-compiler",
      activity: "intent-compiler.run",
      tool: null,
    }],
  });

  // Phase 2: constraints + planning.
  const planningNodes = [];
  if (has("constraint-extractor")) {
    planningNodes.push({
      id: "constraints.extract",
      agent: "constraint-extractor",
      activity: "constraint-extractor.run",
      tool: null,
      depends_on: ["intent.compile"],
    });
  }
  if (has("planner") && intent !== "small_talk" && intent !== "text_answer") {
    planningNodes.push({
      id: "plan.build",
      agent: "planner",
      activity: "planner.run",
      tool: null,
      depends_on: planningNodes.length > 0 ? [planningNodes[planningNodes.length - 1].id] : ["intent.compile"],
    });
  }
  if (planningNodes.length > 0) phaseList.push({ name: "planning", nodes: planningNodes });

  // Phase 3: evidence (research + docintel + db + scraping).
  const evidenceNodes = [];
  const evidenceDep = planningNodes.length > 0 ? planningNodes[planningNodes.length - 1].id : "intent.compile";
  if (has("research-verifier") && tools.some(t => t === "research.agenticBatch" || t === "self_rag.answer" || t === "rag.retrieve")) {
    evidenceNodes.push({
      id: "research.collect",
      agent: "research-verifier",
      activity: "research-verifier.run",
      tool: tools.find(t => t === "research.agenticBatch") || tools.find(t => t === "rag.retrieve") || "self_rag.answer",
      depends_on: [evidenceDep],
    });
  }
  if (has("document-analyst") && tools.some(t => t.startsWith("docintel."))) {
    evidenceNodes.push({
      id: "docs.analyze",
      agent: "document-analyst",
      activity: "document-analyst.run",
      tool: tools.find(t => t === "docintel.analyze") || "docintel.ground",
      depends_on: evidenceNodes.length > 0 ? [evidenceNodes[evidenceNodes.length - 1].id] : [evidenceDep],
    });
  }
  if (has("database") && tools.includes("sql.safety.analyze")) {
    evidenceNodes.push({
      id: "db.introspect",
      agent: "database",
      activity: "database.run",
      tool: "sql.safety.analyze",
      depends_on: [evidenceDep],
      validation_gate: { deterministic_checks: ["read_only_default", "no_ddl", "prepared_statements_only"] },
      human_approval_gate: decision.intent_primary === "database_query" && options.write_intent ? { required: true } : null,
    });
  }
  if (has("scraping") && tools.some(t => t.startsWith("web."))) {
    evidenceNodes.push({
      id: "web.scrape",
      agent: "scraping",
      activity: "scraping.run",
      tool: tools.find(t => t === "web.html.extract") || "web.url.canonical",
      depends_on: [evidenceDep],
      validation_gate: { deterministic_checks: ["robots_respected", "no_captcha_paywall_bypass", "rate_limit_ok"] },
    });
  }
  if (evidenceNodes.length > 0) phaseList.push({ name: "evidence", nodes: evidenceNodes });

  // Phase 4: build (design + code + bi).
  const buildNodes = [];
  const buildDep = evidenceNodes.length > 0
    ? evidenceNodes[evidenceNodes.length - 1].id
    : (planningNodes.length > 0 ? planningNodes[planningNodes.length - 1].id : "intent.compile");
  if (has("design-director") && tools.some(t => t.startsWith("design.") || t.startsWith("wcag."))) {
    buildNodes.push({
      id: "design.direct",
      agent: "design-director",
      activity: "design-director.run",
      tool: tools.find(t => t === "design.tokens.build") || "wcag.contrast.check",
      depends_on: [buildDep],
    });
  }
  if (has("code-architect")) {
    buildNodes.push({
      id: "code.architect",
      agent: "code-architect",
      activity: "code-architect.run",
      tool: tools.find(t => t === "scaffolder.preview") || null,
      depends_on: [buildDep],
    });
  }
  if (has("frontend-engineer")) {
    buildNodes.push({
      id: "frontend.build",
      agent: "frontend-engineer",
      activity: "frontend-engineer.run",
      tool: tools.find(t => t === "scaffolder.nextjs") || tools.find(t => t === "create_document") || null,
      depends_on: buildNodes.find(b => b.id === "design.direct") || buildNodes.find(b => b.id === "code.architect")
        ? [buildNodes[buildNodes.length - 1].id]
        : [buildDep],
    });
  }
  if (has("backend-engineer")) {
    buildNodes.push({
      id: "backend.build",
      agent: "backend-engineer",
      activity: "backend-engineer.run",
      tool: tools.find(t => t === "scaffolder.fastapi") || null,
      depends_on: buildNodes.find(b => b.id === "code.architect") ? ["code.architect"] : [buildDep],
    });
  }
  if (has("bi-analyst")) {
    buildNodes.push({
      id: "bi.compile",
      agent: "bi-analyst",
      activity: "bi-analyst.run",
      tool: tools.find(t => t === "bi.semanticModel.compile") || tools.find(t => t === "bi.market.framework") || null,
      depends_on: [buildDep],
    });
  }
  if (buildNodes.length > 0) phaseList.push({ name: "build", nodes: buildNodes });

  // Phase 5: validate (security + qa).
  const validateNodes = [];
  const validateDep = buildNodes.length > 0 ? buildNodes[buildNodes.length - 1].id : buildDep;
  if (has("security-reviewer")) {
    validateNodes.push({
      id: "security.review",
      agent: "security-reviewer",
      activity: "security-reviewer.run",
      tool: tools.find(t => t === "asvs.evaluate") || "secret-scanner.scan",
      depends_on: [validateDep],
      validation_gate: { deterministic_checks: ["asvs_l1", "secret_scan_clean", "dependency_audit_clean"] },
    });
  }
  if (has("qa-regression")) {
    validateNodes.push({
      id: "qa.regression",
      agent: "qa-regression",
      activity: "qa-regression.run",
      tool: "verify_artifact",
      depends_on: validateNodes.length > 0 ? [validateNodes[validateNodes.length - 1].id] : [validateDep],
      validation_gate: { deterministic_checks: ["artifact_reviewer", "format_sovereignty", "qa_board"] },
    });
  }
  if (validateNodes.length > 0) phaseList.push({ name: "validate", nodes: validateNodes });

  // Phase 6: release.
  const releaseNodes = [];
  const releaseDep = validateNodes.length > 0
    ? validateNodes[validateNodes.length - 1].id
    : (buildNodes.length > 0 ? buildNodes[buildNodes.length - 1].id : "intent.compile");
  if (has("release-manager")) {
    releaseNodes.push({
      id: "release.decide",
      agent: "release-manager",
      activity: "release-manager.run",
      tool: null,
      depends_on: [releaseDep],
      release_gate: { requires_all_validated: true },
    });
  }
  if (releaseNodes.length > 0) phaseList.push({ name: "release", nodes: releaseNodes });

  // Phase 7: telemetry — always last when present.
  const telemetryNodes = [];
  if (has("telemetry")) {
    const telDep = releaseNodes.length > 0 ? "release.decide" : releaseDep;
    telemetryNodes.push({
      id: "telemetry.emit",
      agent: "telemetry",
      activity: "telemetry.run",
      tool: "observability.span.create",
      depends_on: [telDep],
    });
  }
  if (telemetryNodes.length > 0) phaseList.push({ name: "telemetry", nodes: telemetryNodes });

  return phaseList;
}

/**
 * Validate a plan produced by planFromDecision against simple
 * structural invariants. Returns { ok, issues[] }.
 */
function validatePlan(plan) {
  const issues = [];
  if (!plan || !Array.isArray(plan.nodes)) {
    return { ok: false, issues: ["plan_missing_nodes"] };
  }
  const ids = new Set();
  for (const n of plan.nodes) {
    if (ids.has(n.id)) issues.push(`duplicate_node_id:${n.id}`);
    ids.add(n.id);
    for (const d of n.depends_on || []) {
      if (!ids.has(d)) issues.push(`forward_dependency:${n.id}->${d}`);
    }
    if (n.agent && !getAgent(n.agent)) issues.push(`unknown_agent:${n.agent}@${n.id}`);
    if (n.tool && !getTool(n.tool)) issues.push(`unknown_tool:${n.tool}@${n.id}`);
  }
  if (plan.nodes[0] && plan.nodes[0].id !== "intent.compile") {
    issues.push("intent_compile_must_be_first");
  }
  return { ok: issues.length === 0, issues };
}

/**
 * Convenience wrapper used by the route — given a prompt + decision,
 * compute the plan and validate it.
 */
function buildAndValidate(decision, options = {}) {
  const plan = planFromDecision(decision, options);
  const validation = validatePlan(plan);
  return { plan, validation };
}

module.exports = {
  planFromDecision,
  validatePlan,
  buildAndValidate,
  DEFAULT_RETRY_POLICY,
  DEFAULT_TIMEOUT_MS,
};
