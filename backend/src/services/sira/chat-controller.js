/**
 * chat-controller — Sira's canonical chat handler (MASTER_SPEC §27).
 *
 * Wraps engine + runtime + storage + policies + model-adapter into the
 * single function the /api/sira/chat endpoint calls per user turn.
 *
 *   handleChatTurn({
 *     conversationId, userId,
 *     userMessage, attachments, history,
 *     selectedModel,                    // MUST be user-selected; never auto-routed
 *     userPlan, dryRun?
 *   }, { storage, registry, providers })
 *     → { stage, envelope, intent_frame, plan_frame, tool_call_frame,
 *         artifact_frame, validation_frame, final_response_frame,
 *         response, runtime, persisted_ids, summary }
 *
 * Flow per turn:
 *
 *   1. Persist the user message
 *   2. Run the Sira engine (envelope + 5 frames + dry response)
 *   3. Apply clarification + safety policies
 *   4. If clarification needed → return early WITHOUT executing tools
 *   5. Drive the runtime (tool execution + artifact frame + validation)
 *   6. Persist envelope, tool calls, artifacts, validation
 *   7. Persist the assistant response message
 *   8. Audit-log every transition
 */

const ciraEngine = require("./engine");
const ciraRuntime = require("./runtime");
const { createInMemoryStorage, createSiraStorage } = require("./storage-schema");
const { evaluatePolicyForEnvelope, SIRA_CLARIFICATION_POLICY, SIRA_SAFETY_POLICY } = require("./policies");
const { guardAgainstAutoRouting } = require("./model-adapter");
const { createDefaultRegistry } = require("./tool-registry");
const { createSessionActorQueue, buildChatTurnActorKey } = require("./session-actor-queue");
const { buildTokenUsageFrame } = require("./token-ledger");

const defaultChatTurnQueue = createSessionActorQueue();

async function handleChatTurn({
  conversationId,
  userId,
  userMessage,
  attachments = [],
  history = [],
  selectedModel,
  userPlan = "FREE",
  permissions = ["none", "read_uploaded_file", "write_artifact", "execute_sandboxed_code", "external_api_access"],
  toolArgs = {},
  dryRun = true,
  bypassSessionQueue = false,
} = {}, deps = {}) {
  const actorKey = buildChatTurnActorKey({ conversationId, userId });
  const queue = deps.sessionQueue || defaultChatTurnQueue;
  if (bypassSessionQueue || !queue || typeof queue.run !== "function") {
    return handleChatTurnUnlocked({
      conversationId,
      userId,
      userMessage,
      attachments,
      history,
      selectedModel,
      userPlan,
      permissions,
      toolArgs,
      dryRun,
    }, deps);
  }
  return queue.run(actorKey, () => handleChatTurnUnlocked({
    conversationId,
    userId,
    userMessage,
    attachments,
    history,
    selectedModel,
    userPlan,
    permissions,
    toolArgs,
    dryRun,
  }, deps));
}

async function handleChatTurnUnlocked({
  conversationId,
  userId,
  userMessage,
  attachments = [],
  history = [],
  selectedModel,
  userPlan = "FREE",
  permissions = ["none", "read_uploaded_file", "write_artifact", "execute_sandboxed_code", "external_api_access"],
  toolArgs = {},
  dryRun = true,
} = {}, { storage = null, registry = null, providers = null, tokenLedger = null } = {}) {
  if (!userMessage || typeof userMessage !== "string") {
    throw new Error("chat-controller: userMessage required");
  }
  if (!conversationId || !userId) {
    throw new Error("chat-controller: conversationId + userId required");
  }
  if (!selectedModel || !selectedModel.provider || !selectedModel.modelId) {
    throw new Error("chat-controller: selectedModel { provider, modelId } required (no auto-routing)");
  }
  const originalSelection = { ...selectedModel };

  const store = storage || createSiraStorage({ adapter: createInMemoryStorage() });
  const reg = registry || createDefaultRegistry();
  const persistedIds = {};

  // ── 1. Persist user message + start audit trail ──────────────────
  persistedIds.user_message_id = await store.addMessage({
    conversationId, role: "user",
    content: { text: userMessage, attachments },
    selectedModel,
  });
  await store.audit("turn_started", { conversationId, userMessage_len: userMessage.length, attachment_count: attachments.length }, { userId });

  // ── 2. Run engine (envelope + 5 frames + dry response) ───────────
  const bundle = await ciraEngine.runUserMessage({
    text: userMessage,
    attachments,
    history,
    userPlan,
    userId,
    conversationId,
    modelChoice: { model: selectedModel },
    dryRun: true,
  });
  if (bundle.stage === "envelope" || bundle.ok === false) {
    await store.audit("envelope_invalid", { errors: bundle.errors }, { userId });
    return {
      stage: "envelope_invalid",
      errors: bundle.errors || ["unknown_envelope_failure"],
      persisted_ids: persistedIds,
    };
  }

  // Persist the envelope ASAP so it can be replayed even if the run dies later.
  persistedIds.envelope_id = await store.persistEnvelope({ envelope: bundle.envelope, conversationId, userId });

  // ── 3. Policies — clarification + safety ─────────────────────────
  const policyVerdict = evaluatePolicyForEnvelope(bundle.envelope);

  if (policyVerdict.summary === "ask_user_clarification" || bundle.stage === "needs_clarification") {
    const clarificationText = "Necesito una aclaración para continuar.";
    const tokenUsage = await recordTokenUsage({
      store,
      tokenLedger,
      envelope: bundle.envelope,
      userMessage,
      attachments,
      history,
      selectedModel,
      responseText: clarificationText,
    });
    await store.audit("clarification_requested", {
      questions: bundle.envelope.clarification_policy?.questions || [],
      reasons: policyVerdict.clarification.reasons,
    }, { userId, requestId: bundle.envelope.request_id });
    persistedIds.assistant_message_id = await store.addMessage({
      conversationId, role: "assistant",
      content: {
        text: clarificationText,
        clarifying_questions: bundle.envelope.clarification_policy?.questions || [],
        reasons: policyVerdict.clarification.reasons,
        token_usage: tokenUsage,
      },
      selectedModel,
    });
    return {
      stage: "needs_clarification",
      envelope: bundle.envelope,
      intent_frame: bundle.intent_frame,
      plan_frame: bundle.plan_frame,
      clarifying_questions: bundle.envelope.clarification_policy?.questions || [],
      policy: policyVerdict,
      token_usage: tokenUsage,
      persisted_ids: persistedIds,
    };
  }

  // ── 4. Drive the runtime (tool execution + artifacts + validation) ─
  const runtimeResult = await ciraRuntime.runWorkflow({
    envelope: bundle.envelope,
    registry: reg,
    permissions,
    toolArgs,
    dryRun,
    context: { selectedModel, userId, conversationId },
  });

  // Persist tool calls + artifacts + validation report
  for (const tc of runtimeResult.tool_results || []) {
    await store.recordToolCall({
      requestId: bundle.envelope.request_id,
      toolName: tc.tool,
      input: tc.input || toolArgs[tc.tool] || {},
      output: tc.output ?? null,
      status: tc.status || "success",
      error: tc.error || null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
  }
  for (const a of runtimeResult.artifact_frame.artifacts || []) {
    await store.persistArtifact({
      requestId: bundle.envelope.request_id,
      userId,
      artifactType: a.type,
      format: a.format,
      filename: a.filename,
      storageUrl: a.download_url || `inline://${a.artifact_id}`,
      previewUrl: a.preview_url || null,
      validationStatus: a.validation_status || "pending",
      metadata: { source_tool: a.source_tool || null, source_node: a.source_node || null },
    });
  }
  await store.persistValidation({
    requestId: bundle.envelope.request_id,
    overallScore: runtimeResult.validation_frame.aggregate_score,
    readyToDeliver: runtimeResult.validation_frame.ready_to_deliver,
    checks: runtimeResult.validation_frame.checks,
  });

  // ── 5. Guard against accidental auto-routing ─────────────────────
  guardAgainstAutoRouting(originalSelection, selectedModel);

  // ── 6. Persist assistant response + audit ────────────────────────
  const assistantText = bundle.response?.user_visible_summary || bundle.response?.summary || "Tarea preparada.";
  const tokenUsage = await recordTokenUsage({
    store,
    tokenLedger,
    envelope: bundle.envelope,
    userMessage,
    attachments,
    history,
    selectedModel,
    runtimeResult,
    responseText: assistantText,
  });
  persistedIds.assistant_message_id = await store.addMessage({
    conversationId, role: "assistant",
    content: {
      text: assistantText,
      delivery_mode: bundle.response?.delivery_mode || bundle.envelope.final_answer_contract?.delivery_mode,
      artifacts: runtimeResult.artifact_frame.artifacts,
      ready_to_deliver: runtimeResult.validation_frame.ready_to_deliver,
      token_usage: tokenUsage,
    },
    selectedModel,
  });
  await store.audit("turn_completed", {
    request_id: bundle.envelope.request_id,
    ready_to_deliver: runtimeResult.validation_frame.ready_to_deliver,
    artifact_count: runtimeResult.artifact_frame.artifacts.length,
    tool_count: runtimeResult.tool_results.length,
    token_usage: tokenUsage.usage,
  }, { userId, requestId: bundle.envelope.request_id });

  return {
    stage: runtimeResult.validation_frame.ready_to_deliver ? "delivered" : "needs_repair",
    envelope: bundle.envelope,
    intent_frame: bundle.intent_frame,
    plan_frame: bundle.plan_frame,
    tool_call_frame: bundle.tool_call_frame,
    artifact_frame: runtimeResult.artifact_frame,
    validation_frame: runtimeResult.validation_frame,
    final_response_frame: bundle.final_response_frame,
    response: bundle.response,
    runtime: runtimeResult,
    policy: policyVerdict,
    token_usage: tokenUsage,
    persisted_ids: persistedIds,
    summary: {
      stage: runtimeResult.validation_frame.ready_to_deliver ? "delivered" : "needs_repair",
      tool_count: runtimeResult.tool_results.length,
      artifact_count: runtimeResult.artifact_frame.artifacts.length,
      validation_score: runtimeResult.validation_frame.aggregate_score,
      token_usage: tokenUsage.usage,
    },
  };
}

async function recordTokenUsage({
  store,
  tokenLedger,
  envelope,
  userMessage,
  attachments,
  history,
  selectedModel,
  runtimeResult = null,
  responseText = "",
}) {
  const tokenUsage = buildTokenUsageFrame({
    envelope,
    userMessage,
    attachments,
    history,
    selectedModel,
    runtimeResult,
    responseText,
  });

  if (tokenLedger && typeof tokenLedger.record === "function") {
    try {
      tokenLedger.record(tokenUsage);
    } catch (error) {
      await store.audit("token_usage_ledger_error", {
        request_id: tokenUsage.request_id,
        error: error && error.message ? error.message : String(error),
      }, { userId: tokenUsage.user_id, requestId: tokenUsage.request_id });
    }
  }

  await store.audit("token_usage_recorded", {
    request_id: tokenUsage.request_id,
    dimensions: tokenUsage.dimensions,
    usage: tokenUsage.usage,
    accounting_method: tokenUsage.accounting_method,
    estimated: tokenUsage.estimated,
  }, { userId: tokenUsage.user_id, requestId: tokenUsage.request_id });

  return tokenUsage;
}

module.exports = {
  handleChatTurn,
  handleChatTurnUnlocked,
  defaultChatTurnQueue,
  buildChatTurnActorKey,
  POLICIES: { SIRA_CLARIFICATION_POLICY, SIRA_SAFETY_POLICY },
};
