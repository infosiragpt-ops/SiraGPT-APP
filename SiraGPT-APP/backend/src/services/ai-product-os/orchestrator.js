/**
 * orchestrator — end-to-end pipeline that ties every layer of the
 * AI Product OS into one call:
 *
 *   Usuario
 *     → AI Gateway / Model Router      (model-router.js)
 *     → Intent Understanding Engine    (semantic-intent-router.js)
 *     → Skill resolution               (skill-system.js)
 *     → Memory recall                  (memory-layer.js)
 *     → Planner Agent                  (planner-agent.js)
 *     → Constitution check             (constitution.js)
 *     → Agent Runtime / Graph runner   (durable-workflow.js / product-os.execute)
 *     → Verifier / Critic / Evaluator  (validation-fabric / qa-board)
 *     → Final response + artefact + evidence
 *
 * The orchestrator does NOT call LLMs by itself. It composes the
 * pieces and invokes them in the right order, with the constitution
 * acting as a hard gate at every transition.
 *
 * Public:
 *   runUserRequest({ prompt, history, context, userId, userPlan,
 *                    llmClient, memory, activityRunner })
 *     → { decision, skill, plan, planValidation, contextRecall,
 *         constitutionPre, executionResult, constitutionPost,
 *         model, evidenceTrail }
 *
 * Pure orchestration. Adapters injectable; defaults are in-memory
 * for tests.
 */

const intentRouter = require("./semantic-intent-router");
const skillSystem = require("./skill-system");
const planner = require("./planner-agent");
const modelRouter = require("./model-router");
const memoryLayer = require("./memory-layer");
const constitution = require("./constitution");
const productOs = require("./product-os");
const { createEnvelope } = require("./event-envelope");

/**
 * @param {object} args
 * @param {string} args.prompt
 * @param {Array} [args.history]
 * @param {object} [args.context]
 * @param {string} [args.userId]
 * @param {string} [args.userPlan]    "FREE" | "PRO" | "ENTERPRISE"
 * @param {object} [args.llmClient]   used by intent router
 * @param {object} [args.memory]      memory facade; default in-memory
 * @param {Function} [args.activityRunner]  executes graph nodes; default echo
 * @param {boolean} [args.dryRun=true]   true = use trivial activityRunner
 * @returns {Promise<object>}
 */
async function runUserRequest({
  prompt,
  history = [],
  context = {},
  userId = null,
  userPlan = "FREE",
  llmClient = null,
  memory = null,
  activityRunner = null,
  dryRun = true,
} = {}) {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error("orchestrator.runUserRequest: prompt (non-empty string) required");
  }
  const memo = memory || memoryLayer.createMemory();
  const correlationId = `corr_${Math.random().toString(16).slice(2, 14)}`;
  const startEnvelope = createEnvelope({
    type: "orchestrator.run.started",
    payload: { prompt: prompt.slice(0, 200), userId },
    trace: { correlation_id: correlationId },
  });

  // ── 1. Intent Understanding Engine ───────────────────────────────
  const decision = await intentRouter.classifyIntent({
    prompt, history, context, llmClient,
  });

  // ── 2. Skill resolution ──────────────────────────────────────────
  const skill = skillSystem.resolveSkillForIntent(decision, { userPlan });
  const enrichedDecision = skillSystem.mergeDecisionWithSkill(decision, skill);

  // ── 3. Model selection ───────────────────────────────────────────
  const modelReq = modelRouter.reqFromDecision(enrichedDecision, {
    user_plan: userPlan,
    language: context.locale || "es",
  });
  const modelChoice = modelRouter.select(modelReq);

  // ── 4. Memory recall ─────────────────────────────────────────────
  let contextRecall = null;
  if (userId) {
    contextRecall = await memo.buildContextForTurn({
      userId, query: prompt, semanticCollection: "kb", topK: 4,
    }).catch(() => null);
  }

  // ── 5. Planner ───────────────────────────────────────────────────
  const { plan, validation: planValidation } = planner.buildAndValidate(enrichedDecision, {
    contract_id: correlationId,
  });

  // ── 6. Constitution pre-execution gate ───────────────────────────
  const constitutionPre = constitution.enforceConstitution({
    hasContract: true,
    contractValid: planValidation.ok,
    dagPresent: Array.isArray(plan.nodes) && plan.nodes.length > 0,
  });

  // ── 7. Execution (durable runtime) — only if pre-gate passes ─────
  let executionResult = null;
  let constitutionPost = null;
  if (constitutionPre.ok) {
    const runner = activityRunner || trivialRunner();
    const ranOk = await productOs.execute(
      { contract: { contract_id: plan.contract_id, schema_version: "1.1", objective: prompt, deliverables: [], constraints: enrichedDecision.intent_secondary || [], correlation_id: correlationId }, graph: { graph_id: plan.graph_id, schema_version: "1.0", contract_id: plan.contract_id, nodes: plan.nodes.map(toGraphNode), release_gate: plan.release_gate } },
      { activityRunner: dryRun ? trivialRunner() : runner }
    );
    executionResult = ranOk;
    constitutionPost = ranOk.constitution || null;
  }

  // ── 8. Push the user turn into short-term memory ─────────────────
  if (userId) {
    await memo.pushTurn(userId, { role: "user", content: prompt }).catch(() => {});
  }

  return {
    correlation_id: correlationId,
    start_envelope_id: startEnvelope.id,
    decision: enrichedDecision,
    skill,
    model: modelChoice,
    context_recall: contextRecall,
    plan,
    plan_validation: planValidation,
    constitution_pre: constitutionPre,
    execution: executionResult,
    constitution_post: constitutionPost,
  };
}

function toGraphNode(n) {
  return {
    id: n.id,
    activity: n.activity,
    input: { agent: n.agent, tool: n.tool },
    idempotency_key: n.idempotency_key,
    retry_policy: n.retry_policy,
    timeout_ms: n.timeout_ms,
    depends_on: n.depends_on,
  };
}

function trivialRunner() {
  return async ({ activity, node_id }) => ({ activity, node_id, dry_run: true, ts: new Date().toISOString() });
}

/**
 * Compute a one-line summary of an orchestrator result, useful for
 * logs and audit records.
 */
function summarize(result) {
  if (!result) return "no_result";
  const intent = result.decision?.intent_primary || "unknown";
  const skill = result.skill?.id || "no-skill";
  const model = result.model?.model?.id || "no-model";
  const status = result.execution?.status || (result.constitution_pre?.ok ? "skipped" : "blocked");
  return `[${intent}] skill=${skill} model=${model} status=${status} corr=${result.correlation_id}`;
}

module.exports = {
  runUserRequest,
  summarize,
};
