/**
 * constitution — the 14 internal laws of the AI Product Operating System.
 *
 * Every request that enters the product-os MUST be evaluated against
 * this constitution before execution. A violation is a hard block;
 * the system does not "try to be helpful" around a violated law.
 *
 * These laws are the difference between a chatbot that answers freely
 * and a verifiable agentic factory:
 *
 *   1.  do_not_answer_freely             — every response emerges from a
 *                                          compiled contract, not from
 *                                          free-text inference.
 *   2.  compile_request_to_contract      — user intent must be compiled
 *                                          into a UniversalTaskContract
 *                                          before any tool runs.
 *   3.  validate_contract_before_execution — ajv/zod/pydantic validation
 *                                          must pass on the compiled
 *                                          contract.
 *   4.  select_tools_only_from_registry  — no tool invocation outside
 *                                          the ToolManifest registry.
 *   5.  execute_as_dag                   — work is driven through an
 *                                          ExecutionGraph DAG, not a
 *                                          straight-line script.
 *   6.  persist_state                    — every node transition is
 *                                          checkpointed so the run is
 *                                          resumable after a crash.
 *   7.  require_evidence_for_factual_claims — factual output must have
 *                                          ≥ 1 source binding in the
 *                                          evidence ledger.
 *   8.  require_format_sovereignty       — deliverables must satisfy
 *                                          the required file extension
 *                                          + MIME + structural checks.
 *   9.  run_deterministic_validators     — the ValidationFabric runs
 *                                          the Artifact Reviewer and
 *                                          relevant QA critics before
 *                                          release.
 *  10.  repair_before_delivery           — on a failed validator, a
 *                                          self-repair loop must be
 *                                          attempted before giving up.
 *  11.  block_release_if_validation_fails — under no circumstances ship
 *                                          an artefact whose release
 *                                          gate is not green.
 *  12.  never_fake_scores                — severity/boolean only; the
 *                                          system never emits a made-up
 *                                          numeric quality score.
 *  13.  never_fake_file_reading          — if a file/URL can't be read,
 *                                          say so — do not hallucinate
 *                                          contents.
 *  14.  never_fake_citations             — citations must point to real
 *                                          evidence ledger entries with
 *                                          verifiable quotes.
 *  15.  never_fake_artifacts             — artefacts must be produced by
 *                                          real tools, not by describing
 *                                          what the output "would look
 *                                          like".
 *
 * Pure JS, deterministic, zero deps.
 */

const LAWS = Object.freeze([
  { id: "L01", key: "do_not_answer_freely", severity: "critical", gate: "pre-compile",
    rationale: "Every response must emerge from a compiled contract, not free-form inference." },
  { id: "L02", key: "compile_request_to_contract", severity: "critical", gate: "pre-execute",
    rationale: "User intent must be compiled into a UniversalTaskContract before any tool runs." },
  { id: "L03", key: "validate_contract_before_execution", severity: "critical", gate: "pre-execute",
    rationale: "ajv/zod/pydantic validation must pass on the compiled contract." },
  { id: "L04", key: "select_tools_only_from_registry", severity: "high", gate: "per-node",
    rationale: "No tool invocation outside the ToolManifest registry." },
  { id: "L05", key: "execute_as_dag", severity: "high", gate: "per-execution",
    rationale: "Work is driven through an ExecutionGraph DAG, not a linear script." },
  { id: "L06", key: "persist_state", severity: "high", gate: "per-node",
    rationale: "Every node transition is checkpointed so the run is resumable after a crash." },
  { id: "L07", key: "require_evidence_for_factual_claims", severity: "critical", gate: "pre-release",
    rationale: "Factual output must have ≥ 1 source binding in the evidence ledger." },
  { id: "L08", key: "require_format_sovereignty", severity: "high", gate: "pre-release",
    rationale: "Deliverables must satisfy required extension + MIME + structural checks." },
  { id: "L09", key: "run_deterministic_validators", severity: "high", gate: "pre-release",
    rationale: "ValidationFabric runs the Artifact Reviewer and relevant QA critics." },
  { id: "L10", key: "repair_before_delivery", severity: "medium", gate: "pre-release",
    rationale: "On validator failure, a self-repair loop must be attempted before giving up." },
  { id: "L11", key: "block_release_if_validation_fails", severity: "critical", gate: "release",
    rationale: "Never ship an artefact whose release gate is not green." },
  { id: "L12", key: "never_fake_scores", severity: "high", gate: "per-output",
    rationale: "Severity / boolean only — no invented numeric quality scores." },
  { id: "L13", key: "never_fake_file_reading", severity: "critical", gate: "per-tool-call",
    rationale: "If a file/URL can't be read, say so — do not hallucinate contents." },
  { id: "L14", key: "never_fake_citations", severity: "critical", gate: "per-output",
    rationale: "Citations must point to real evidence-ledger entries with verifiable quotes." },
  { id: "L15", key: "never_fake_artifacts", severity: "critical", gate: "pre-release",
    rationale: "Artefacts must be produced by real tools, not by describing what they'd look like." },
]);

const KEYS = Object.freeze(LAWS.map(l => l.key));

/**
 * Evaluate whether a runtime `ctx` satisfies the constitution.
 *
 * @param {object} ctx
 *   Expected keys (any of): hasContract, contractValid, dagPresent,
 *   toolCallsInRegistry, artifactsFormatApproved, evidenceBindingsForClaims,
 *   validationFabricRan, releaseGateDecision, noHallucinatedFileReads,
 *   noFakedCitations, noFakedArtifacts, noFakedScores, selfRepairAttempted,
 *   statePersisted, freeAnswerAttempted
 *
 * @returns {{ ok, violations: Array, warnings: Array, evaluatedLaws: Array }}
 */
function enforceConstitution(ctx = {}) {
  const violations = [];
  const warnings = [];
  const evaluated = [];

  for (const law of LAWS) {
    const verdict = evaluateLaw(law, ctx);
    evaluated.push({ id: law.id, key: law.key, verdict: verdict.verdict });
    if (verdict.verdict === "violated") {
      violations.push({ id: law.id, key: law.key, severity: law.severity, gate: law.gate, reason: verdict.reason });
    } else if (verdict.verdict === "warning") {
      warnings.push({ id: law.id, key: law.key, gate: law.gate, reason: verdict.reason });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    warnings,
    evaluatedLaws: evaluated,
  };
}

function evaluateLaw(law, ctx) {
  switch (law.key) {
    case "do_not_answer_freely":
      if (ctx.freeAnswerAttempted === true) return { verdict: "violated", reason: "Free-text answer attempted without compiling to contract." };
      return { verdict: "ok" };
    case "compile_request_to_contract":
      if (ctx.hasContract === false) return { verdict: "violated", reason: "No UniversalTaskContract compiled from request." };
      if (ctx.hasContract !== true) return { verdict: "warning", reason: "hasContract flag not explicitly set." };
      return { verdict: "ok" };
    case "validate_contract_before_execution":
      if (ctx.contractValid === false) return { verdict: "violated", reason: "Contract failed schema validation." };
      if (ctx.contractValid !== true) return { verdict: "warning", reason: "contractValid flag not explicitly set." };
      return { verdict: "ok" };
    case "select_tools_only_from_registry":
      if (Array.isArray(ctx.unregisteredToolCalls) && ctx.unregisteredToolCalls.length > 0) {
        return { verdict: "violated", reason: `${ctx.unregisteredToolCalls.length} tool call(s) outside the registry.` };
      }
      return { verdict: "ok" };
    case "execute_as_dag":
      if (ctx.dagPresent === false) return { verdict: "violated", reason: "Execution did not use an ExecutionGraph DAG." };
      if (ctx.dagPresent !== true) return { verdict: "warning", reason: "dagPresent flag not explicitly set." };
      return { verdict: "ok" };
    case "persist_state":
      if (ctx.statePersisted === false) return { verdict: "violated", reason: "Node transitions not checkpointed." };
      if (ctx.statePersisted !== true) return { verdict: "warning", reason: "statePersisted flag not explicitly set." };
      return { verdict: "ok" };
    case "require_evidence_for_factual_claims":
      if (ctx.hasFactualClaims && ctx.evidenceBindingsForClaims !== true) {
        return { verdict: "violated", reason: "Factual claims present but no evidence bindings recorded." };
      }
      return { verdict: "ok" };
    case "require_format_sovereignty":
      if (ctx.hasDeliverables && ctx.artifactsFormatApproved === false) {
        return { verdict: "violated", reason: "Deliverables failed format-sovereignty gate." };
      }
      return { verdict: "ok" };
    case "run_deterministic_validators":
      if (ctx.hasDeliverables && ctx.validationFabricRan !== true) {
        return { verdict: "violated", reason: "Deliverables not checked by ValidationFabric." };
      }
      return { verdict: "ok" };
    case "repair_before_delivery":
      if (ctx.validatorsFailed && ctx.selfRepairAttempted !== true) {
        return { verdict: "violated", reason: "Validators failed but no self-repair loop was attempted." };
      }
      return { verdict: "ok" };
    case "block_release_if_validation_fails":
      if (ctx.releaseGateDecision === "reject" && ctx.releasedAnyway === true) {
        return { verdict: "violated", reason: "Artefact released despite release_gate rejection." };
      }
      return { verdict: "ok" };
    case "never_fake_scores":
      if (ctx.noFakedScores === false) return { verdict: "violated", reason: "Output contains a made-up numeric quality score." };
      return { verdict: "ok" };
    case "never_fake_file_reading":
      if (ctx.noHallucinatedFileReads === false) return { verdict: "violated", reason: "Output includes file content that was never actually read." };
      return { verdict: "ok" };
    case "never_fake_citations":
      if (ctx.noFakedCitations === false) return { verdict: "violated", reason: "Output includes citations not present in the evidence ledger." };
      return { verdict: "ok" };
    case "never_fake_artifacts":
      if (ctx.noFakedArtifacts === false) return { verdict: "violated", reason: "Output describes artefacts that were never produced by a tool." };
      return { verdict: "ok" };
    default:
      return { verdict: "warning", reason: `Unknown law key "${law.key}"` };
  }
}

function listLaws() {
  return LAWS.map(l => ({ ...l }));
}

function getLaw(key) {
  return LAWS.find(l => l.key === key || l.id === key) || null;
}

module.exports = {
  LAWS,
  KEYS,
  listLaws,
  getLaw,
  enforceConstitution,
};
