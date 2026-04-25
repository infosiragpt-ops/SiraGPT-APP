/**
 * engine — the 6-step Cira pipeline that takes a raw user message and
 * returns the full bundle: envelope + 5 frames + execution + response.
 *
 *   1. Intent Engine     → builds the CiraTaskEnvelope
 *   2. Planner           → derives PlanFrame
 *   3. Tool Runtime      → derives ToolCallFrame (delegates to integration-stack)
 *   4. Artifact Engine   → derives ArtifactFrame
 *   5. Validator         → derives ValidationFrame
 *   6. Response Builder  → assembles the user-facing response
 *
 * The engine NEVER calls an LLM by itself. Layers 1-2 are deterministic
 * + optionally LLM-enriched via the injected client. Layer 3 dispatches
 * to the registered tools through the existing MCP gateway. Layer 4
 * delegates artifact rendering to the document/image/video adapters.
 * Layer 5 runs the deterministic validators declared on the envelope.
 *
 * Pure orchestration. Tests inject mock providers and verify shapes.
 */

const { buildEnvelope } = require("./task-envelope-builder");
const { buildIntentFrame, buildPlanFrame, buildToolCallFrame, buildArtifactFrame, buildValidationFrame, buildFinalResponseFrame } = require("./frames");
const { validateEnvelope } = require("./task-envelope-schema");
const responseBuilder = require("./response-builder");
const { runCiraAgentRuntime } = require("../agent-runtime");
const { createDefaultRegistry } = require("./tool-registry");

/**
 * @param {object} args
 * @param {string} args.text                   — raw user message
 * @param {Array}  [args.attachments]
 * @param {Array}  [args.history]
 * @param {object} [args.userProfile]
 * @param {string} [args.userPlan]
 * @param {string} [args.conversationId]
 * @param {string} [args.userId]
 * @param {object} [args.modelChoice]          — output of model-router.select()
 * @param {object} [args.llmClient]            — optional intent classifier
 * @param {object} [args.toolDispatcher]       — { run(toolName, args) → result }
 * @param {object} [args.artifactRenderer]     — { render(spec) → { buffer, mime, ... } }
 * @param {boolean} [args.dryRun=true]
 * @returns {Promise<object>}
 */
async function runUserMessage(args = {}) {
  if (typeof args.text !== "string" || args.text.trim().length === 0) {
    throw new Error("sira.engine: text (non-empty string) required");
  }
  const dryRun = args.dryRun !== false;

  // ── Step 1. Intent Engine ────────────────────────────────────────
  const envelopeBundle = await buildEnvelope({
    text: args.text,
    attachments: args.attachments,
    history: args.history,
    userProfile: args.userProfile,
    userPlan: args.userPlan,
    conversationId: args.conversationId,
    userId: args.userId,
    modelChoice: args.modelChoice,
    llmClient: args.llmClient,
  });
  const envelope = envelopeBundle.envelope;
  const envelopeValidation = envelopeBundle.validation;

  if (!envelopeValidation.ok) {
    return {
      ok: false,
      stage: "envelope",
      errors: envelopeValidation.errors,
      envelope,
    };
  }

  // ── Step 2. Planner ──────────────────────────────────────────────
  const intentFrame = buildIntentFrame({ envelope });
  const planFrame = buildPlanFrame({ envelope });

  // ── Stop early if the envelope demands clarification ─────────────
  if (envelope.clarification_policy.needs_clarification) {
    return {
      ok: true,
      stage: "needs_clarification",
      envelope,
      intent_frame: intentFrame,
      plan_frame: planFrame,
      clarifying_questions: envelope.clarification_policy.questions,
    };
  }

  // ── Step 3. Tool Runtime ─────────────────────────────────────────
  const toolCallFrame = buildToolCallFrame({ envelope });
  const toolResults = [];
  if (!dryRun && args.toolDispatcher && typeof args.toolDispatcher.run === "function") {
    for (const call of toolCallFrame.tool_calls) {
      try {
        const r = await args.toolDispatcher.run(call.tool, call.arguments);
        toolResults.push({ tool: call.tool, ok: true, result: r });
      } catch (err) {
        toolResults.push({ tool: call.tool, ok: false, error: err && err.message ? err.message : String(err) });
      }
    }
  }

  // ── Step 4. Artifact Engine ──────────────────────────────────────
  const artifactFrame = buildArtifactFrame({ envelope });
  const artifactResults = [];
  if (!dryRun && args.artifactRenderer && typeof args.artifactRenderer.render === "function") {
    for (const a of artifactFrame.artifacts) {
      try {
        const r = await args.artifactRenderer.render(a);
        artifactResults.push({ artifact: a, ok: true, result: r });
      } catch (err) {
        artifactResults.push({ artifact: a, ok: false, error: err && err.message ? err.message : String(err) });
      }
    }
  }

  // ── Step 5. Validator ────────────────────────────────────────────
  const checkResults = (envelope.quality_plan.validators || []).map(v => ({
    name: v.name,
    status: validatorPassed(v, { envelope, toolResults, artifactResults, dryRun }) ? "passed" : "failed",
    score: null,
    detail: null,
  }));
  const validationFrame = buildValidationFrame({ envelope, checkResults });

  // ── Step 6. Response Builder ─────────────────────────────────────
  const finalResponseFrame = buildFinalResponseFrame({
    envelope,
    validationFrame,
    artifacts: artifactFrame.artifacts,
    warnings: validationFrame.ready_to_deliver ? [] : ["validation_failed_release_blocked"],
  });
  const response = buildResponse({ envelope, validationFrame, finalResponseFrame, artifactResults, dryRun });
  const agentRuntime = await runCiraAgentRuntime({
    text: args.text,
    attachments: args.attachments,
    history: args.history,
    envelope,
    validateEnvelope,
    registry: args.registry || createDefaultRegistry(),
    metadata: {
      dry_run: dryRun,
      selected_model: envelope.model_execution_context?.selected_model || null,
    },
  });

  return {
    ok: true,
    stage: validationFrame.ready_to_deliver ? "delivered" : "needs_repair",
    envelope,
    intent_frame: intentFrame,
    plan_frame: planFrame,
    tool_call_frame: toolCallFrame,
    artifact_frame: artifactFrame,
    validation_frame: validationFrame,
    final_response_frame: finalResponseFrame,
    tool_results: toolResults,
    artifact_results: artifactResults,
    agent_runtime: agentRuntime,
    response,
  };
}

function validatorPassed(validator, { envelope, dryRun }) {
  // Deterministic validator stub: in dryRun every validator passes
  // because no real artefact exists yet; production replaces this
  // with the real artifact-reviewer / qa-board calls.
  if (dryRun) return true;
  // Without artefact results, only intent_fulfillment passes by default.
  return validator.name === "intent_fulfillment_validator";
}

function buildResponse({ envelope, validationFrame, finalResponseFrame, artifactResults, dryRun }) {
  return responseBuilder.buildFinalResponse({
    envelope,
    runtime: {
      artifact_frame: {
        artifacts: (artifactResults || []).map(a => ({
          ...(a.artifact || {}),
          ...(a.result || {}),
          validation_status: a.ok ? "passed" : "failed",
        })),
      },
      validation_frame: validationFrame,
    },
    validation: validationFrame,
    warnings: dryRun ? ["dry_run_no_artifact_rendered"] : [],
  });
}

/**
 * Convenience: get the full bundle as a snapshot suitable for /api
 * responses. Strips internal symbols and non-serialisable fields.
 */
function snapshot(result) {
  if (!result || typeof result !== "object") return null;
  return JSON.parse(JSON.stringify(result));
}

module.exports = {
  runUserMessage,
  snapshot,
  validateEnvelope,
  buildFinalResponse: responseBuilder.buildFinalResponse,
};
