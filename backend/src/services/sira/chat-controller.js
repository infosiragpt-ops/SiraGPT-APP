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
const { assessTokenBudget } = require("./token-budget-policy");
const { IngressError } = require("./pipeline-errors");
const siraMetrics = require("./metrics");
const chatModes = require("./chat-modes");
const projectWorkspace = require("./project-workspace");
const { compactContext } = require("./context-compactor");
const { buildCitationFrame } = require("./citation-frame");
const { createNoOpEvents } = require("./turn-events");
const { validateScope: validateMemoryScope } = require("./memory-store");

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
  requestId = null,
  // Optional caller-supplied mode override. When absent, the
  // controller falls back to the envelope hint, then the family
  // mapping, then `chat`.
  mode = null,
  // Optional project workspace. When set, the controller loads
  // docs/instructions/permissions/recent-conversations and surfaces
  // the result on the response. Forbidden access raises
  // ProjectAccessError → 403.
  projectId = null,
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
      requestId,
      mode,
      projectId,
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
    requestId,
    mode,
    projectId,
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
  // Caller-supplied request id (HTTP `X-Request-Id` from the route). When
  // present it is threaded into the envelope, every audit event from the
  // very first one (`turn_started`), and back out to the response. This
  // is the single id that ties the access log, audit log, envelope, and
  // any downstream tooling to a single chat turn.
  requestId = null,
  mode = null,
  projectId = null,
} = {}, {
  storage = null,
  registry = null,
  providers = null,
  tokenLedger = null,
  tokenBudgetCaps = null,
  tokenBudgetMode = "enforce",
  // Adapters for project-workspace lookups. When projectId is null
  // these are never called; when projectId is set, missing adapters
  // make `loadProjectContext` degrade to safe defaults (no
  // membership row → ProjectAccessError on access; otherwise empty
  // docs / instructions / recents).
  projectWorkspaceDeps = null,
  // Optional turn-events sink. When the route handler wants to
  // stream the turn to the client, it passes `createSSEEvents(res)`
  // here; everywhere else (HTTP-RPC callers, tests, eval harness)
  // the no-op default keeps the call free.
  events = createNoOpEvents(),
  // Optional MemoryStore (composite or single-tier). When wired,
  // the controller recalls semantic + project memory before the
  // engine and puts the user message into conversation memory
  // after runtime. Missing → both calls become no-ops.
  memoryStore = null,
  // Per-turn memory-tier limits. Caller can tune; default keeps
  // the prompt tight.
  memoryRecallLimit = 5,
} = {}) {
  // Stage-aware errors so `siraErrorHandler` can map them straight to
  // an HTTP 4xx with `{ code, stage, request_id, ... }` and the audit
  // log gets a structured payload instead of a string. requestId is
  // attached when present so the access log, audit log, and HTTP
  // response all share one correlation id even on early failures.
  if (!userMessage || typeof userMessage !== "string") {
    throw new IngressError({
      code: "ingress.missing_user_message",
      message: "chat-controller: userMessage required",
      details: { field: "userMessage" },
      requestId,
    });
  }
  if (!conversationId || !userId) {
    throw new IngressError({
      code: "ingress.missing_identity",
      message: "chat-controller: conversationId + userId required",
      details: { missing: { conversationId: !conversationId, userId: !userId } },
      requestId,
    });
  }
  if (!selectedModel || !selectedModel.provider || !selectedModel.modelId) {
    throw new IngressError({
      code: "ingress.missing_selected_model",
      message: "chat-controller: selectedModel { provider, modelId } required (no auto-routing)",
      details: { selectedModel: selectedModel || null },
      requestId,
    });
  }
  const originalSelection = { ...selectedModel };
  // Pinned at the very top so every return path can compute one
  // duration. Prometheus histograms read this via `recordTurn`.
  const turnStartedAtMs = Date.now();

  const store = storage || createSiraStorage({ adapter: createInMemoryStorage() });
  const reg = registry || createDefaultRegistry();
  const persistedIds = {};

  // ── 1. Persist user message + start audit trail ──────────────────
  // Audits emitted before the engine runs carry whatever requestId the
  // caller threaded in (may be null in non-HTTP contexts). After the
  // envelope is built, we switch to `bundle.envelope.request_id`, which
  // resolves to the same value when the caller provided one — making
  // every audit row in a turn share one id.
  const auditMeta = requestId ? { userId, requestId } : { userId };
  persistedIds.user_message_id = await store.addMessage({
    conversationId, role: "user",
    content: { text: userMessage, attachments },
    selectedModel,
  });
  const turnStartedPayload = { conversationId, userMessage_len: userMessage.length, attachment_count: attachments.length };
  await store.audit("turn_started", turnStartedPayload, auditMeta);
  events.emit("turn_started", { ...turnStartedPayload, request_id: requestId });

  // ── 1.5. Load project workspace context (best-effort) ────────────
  // Runs before the engine so the envelope-builder (in a follow-up
  // commit) can fold project instructions into the system prompt and
  // the RAG path can scope retrieval to project docs. A forbidden
  // access is fatal — surfaces as an early return so we don't waste
  // budget on a turn the caller is not allowed to make. Anything
  // else (missing adapters, transient errors) degrades to a null
  // context.
  let projectContext = null;
  if (typeof projectId === "string" && projectId.length > 0) {
    try {
      projectContext = await projectWorkspace.loadProjectContext({
        projectId,
        userId,
        deps: projectWorkspaceDeps || {},
      });
      const projectLoadedPayload = {
        project_id: projectId,
        member_role: projectContext.member?.role || null,
        capability_count: projectContext.capabilities.length,
        doc_count: projectContext.docs.length,
        recent_conversation_count: projectContext.recent_conversations.length,
      };
      await store.audit("project_context_loaded", projectLoadedPayload, auditMeta);
      events.emit("project_context_loaded", { ...projectLoadedPayload, request_id: requestId });
    } catch (err) {
      if (err && err.code === "project.forbidden") {
        await store.audit("project_access_denied", {
          project_id: projectId,
          reason: "not_a_member",
        }, auditMeta);
        events.emit("project_access_denied", { project_id: projectId, reason: "not_a_member", request_id: requestId });
        siraMetrics.recordTurn({
          stage: "project_forbidden", status: "blocked", plan: userPlan,
          durationMs: Date.now() - turnStartedAtMs,
        });
        events.end();
        return {
          stage: "project_forbidden",
          request_id: requestId,
          error: { code: "project.forbidden", project_id: projectId },
          persisted_ids: persistedIds,
        };
      }
      // Best-effort: a non-forbidden error in the project loader
      // (e.g. a missing adapter) leaves the turn project-less rather
      // than failing closed; the audit row preserves the cause.
      await store.audit("project_context_error", {
        project_id: projectId,
        error_code: err && err.code ? String(err.code) : "unknown",
      }, auditMeta);
      projectContext = null;
    }
  }

  const tokenBudget = assessTokenBudget({
    userId,
    conversationId,
    userPlan,
    userMessage,
    attachments,
    history,
    selectedModel,
    tokenLedger,
    caps: tokenBudgetCaps,
    mode: tokenBudgetMode,
  });
  const budgetCheckedPayload = {
    decision: tokenBudget.decision,
    enforcement_mode: tokenBudget.enforcement_mode,
    projected_usage: tokenBudget.projected_usage,
    caps: tokenBudget.caps,
    violations: tokenBudget.violations,
  };
  await store.audit("token_budget_checked", budgetCheckedPayload, auditMeta);
  events.emit("token_budget_checked", { ...budgetCheckedPayload, request_id: requestId });
  siraMetrics.recordTokenBudgetDecision({
    decision: tokenBudget.decision,
    plan: userPlan,
    enforcement_mode: tokenBudget.enforcement_mode,
  });
  if (tokenBudget.decision === "blocked") {
    const blockedText = "La solicitud supera el presupuesto de tokens configurado para esta sesión. Reduce el tamaño del mensaje, divide la tarea o aumenta el plan antes de continuar.";
    persistedIds.assistant_message_id = await store.addMessage({
      conversationId,
      role: "assistant",
      content: {
        text: blockedText,
        token_budget: tokenBudget,
        ready_to_deliver: false,
      },
      selectedModel,
    });
    const blockedPayload = {
      decision: tokenBudget.decision,
      violations: tokenBudget.violations,
      projected_usage: tokenBudget.projected_usage,
    };
    await store.audit("turn_blocked_token_budget", blockedPayload, auditMeta);
    events.emit("turn_blocked_token_budget", { ...blockedPayload, request_id: requestId });
    siraMetrics.recordTurn({
      stage: "token_budget_exceeded", status: "blocked", plan: userPlan,
      durationMs: Date.now() - turnStartedAtMs,
    });
    events.end();
    return {
      stage: "token_budget_exceeded",
      request_id: requestId,
      token_budget: tokenBudget,
      persisted_ids: persistedIds,
      summary: {
        stage: "token_budget_exceeded",
        violations: tokenBudget.violations.map(v => v.code),
        projected_tokens: tokenBudget.projected_usage.projected_turn_tokens,
      },
    };
  }

  // ── 1.7. Memory recall (semantic + project, best-effort) ────────
  // Pulls the top-N relevant items from the unified MemoryStore so
  // the envelope-builder (and downstream prompt assemblers) can fold
  // them into the system prompt. Failures are non-fatal: recall
  // errors degrade to an empty list rather than blocking the turn.
  // The result is shaped so it can be persisted on the envelope for
  // replay / observability without leaking raw items into the audit
  // log.
  let recalledMemory = { semantic: [], project: [] };
  if (memoryStore && typeof memoryStore.recall === "function") {
    const recallTasks = [];
    if (userId) {
      recallTasks.push(
        memoryStore.recall({ tier: "semantic", scope: { userId }, query: userMessage, limit: memoryRecallLimit })
          .then((r) => { recalledMemory.semantic = Array.isArray(r) ? r : []; })
          .catch(() => { recalledMemory.semantic = []; }),
      );
    }
    if (projectId && userId) {
      recallTasks.push(
        memoryStore.recall({ tier: "project", scope: { projectId, userId }, query: userMessage, limit: memoryRecallLimit })
          .then((r) => { recalledMemory.project = Array.isArray(r) ? r : []; })
          .catch(() => { recalledMemory.project = []; }),
      );
    }
    if (recallTasks.length > 0) {
      await Promise.all(recallTasks);
      const recallSummary = {
        semantic_count: recalledMemory.semantic.length,
        project_count: recalledMemory.project.length,
      };
      await store.audit("memory_recalled", recallSummary, auditMeta);
      events.emit("memory_recalled", { ...recallSummary, request_id: requestId });
    }
  }

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
    requestId,
  });
  if (bundle.stage === "envelope" || bundle.ok === false) {
    await store.audit("envelope_invalid", { errors: bundle.errors }, auditMeta);
    events.emit("envelope_invalid", { errors: bundle.errors, request_id: requestId });
    siraMetrics.recordEnvelopeInvalid();
    siraMetrics.recordTurn({
      stage: "envelope_invalid", status: "error", plan: userPlan,
      durationMs: Date.now() - turnStartedAtMs,
    });
    events.end();
    return {
      stage: "envelope_invalid",
      request_id: requestId,
      errors: bundle.errors || ["unknown_envelope_failure"],
      token_budget: tokenBudget,
      persisted_ids: persistedIds,
    };
  }
  // After this point, every emit can use bundle.envelope.request_id
  // (which is the same as requestId when the caller threaded one in,
  // or the freshly-minted one otherwise).
  events.emit("envelope_built", {
    request_id: bundle.envelope.request_id,
    primary_intent: bundle.envelope.intent_analysis?.primary_intent?.id || null,
    workflow_node_count: bundle.envelope.workflow_graph?.nodes?.length || 0,
  });

  // Persist the envelope ASAP so it can be replayed even if the run dies later.
  persistedIds.envelope_id = await store.persistEnvelope({ envelope: bundle.envelope, conversationId, userId });

  // ── 2.5. Resolve chat mode + apply tool-plan filter ──────────────
  // Mode resolution prefers caller > envelope hint > family fallback >
  // default ("chat"). The filter prunes tools that the active mode
  // forbids; downstream `tool-policy` will catch any that slip
  // through but pruning here keeps the runtime DAG honest.
  const modeResolution = chatModes.resolveMode({ callerMode: mode, envelope: bundle.envelope });
  const modeFilter = chatModes.applyModeToToolPlan(bundle.envelope, modeResolution.mode);
  if (modeFilter.tool_plan) bundle.envelope.tool_plan = modeFilter.tool_plan;
  const modeResolvedPayload = {
    mode: modeResolution.mode,
    source: modeResolution.source,
    dropped_required_tools: modeFilter.dropped_required,
  };
  await store.audit("chat_mode_resolved", modeResolvedPayload, { userId, requestId: bundle.envelope.request_id });
  events.emit("chat_mode_resolved", { ...modeResolvedPayload, request_id: bundle.envelope.request_id });

  // ── 2.6. Compact the context window (stats-only audit) ───────────
  // Runs the unified compactor over (current message + history) so
  // the audit log captures the per-turn shrinking decision: how many
  // messages got deduped, how many fell outside the budget, total
  // tokens kept. We don't yet replace the runtime's history input
  // with `compaction.messages` — that swap is a separate commit so
  // the call-site contract here can be reviewed independently of
  // the consumer side. Emitting the summary unconditionally gives
  // dashboards real numbers from day one.
  const messagesForCompaction = [
    ...history,
    { role: "user", content: userMessage },
  ];
  const compaction = await compactContext({
    messages: messagesForCompaction,
    model: selectedModel.modelId,
    ragChunks: [],
    memoryGists: [],
  }).catch(() => null);
  if (compaction) {
    await store.audit("context_compacted", compaction.stats, {
      userId,
      requestId: bundle.envelope.request_id,
    });
    events.emit("context_compacted", { ...compaction.stats, request_id: bundle.envelope.request_id });
    // Keep the summary on the envelope for replay/observability tools.
    bundle.envelope.context_compaction_summary = compaction.stats;
  }

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
    const clarificationPayload = {
      questions: bundle.envelope.clarification_policy?.questions || [],
      reasons: policyVerdict.clarification.reasons,
    };
    await store.audit("clarification_requested", clarificationPayload, { userId, requestId: bundle.envelope.request_id });
    events.emit("clarification_requested", { ...clarificationPayload, request_id: bundle.envelope.request_id });
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
    siraMetrics.recordClarificationRequested();
    siraMetrics.recordTurn({
      stage: "needs_clarification", status: "needs_clarification", plan: userPlan,
      durationMs: Date.now() - turnStartedAtMs,
    });
    events.end();
    return {
      stage: "needs_clarification",
      request_id: bundle.envelope.request_id,
      envelope: bundle.envelope,
      intent_frame: bundle.intent_frame,
      plan_frame: bundle.plan_frame,
      clarifying_questions: bundle.envelope.clarification_policy?.questions || [],
      policy: policyVerdict,
      token_usage: tokenUsage,
      token_budget: tokenBudget,
      persisted_ids: persistedIds,
      mode: modeResolution,
      project_context: projectContext,
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
  if (runtimeResult.execution_trace_frame) {
    const tracePayload = {
      request_id: bundle.envelope.request_id,
      status: runtimeResult.execution_trace_frame.status,
      duration_ms: runtimeResult.execution_trace_frame.duration_ms,
      counters: runtimeResult.execution_trace_frame.counters,
    };
    await store.audit("execution_trace_recorded", tracePayload, { userId, requestId: bundle.envelope.request_id });
    events.emit("runtime_completed", tracePayload);
  }

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
      token_budget: tokenBudget,
    },
    selectedModel,
  });
  const turnCompletedPayload = {
    request_id: bundle.envelope.request_id,
    ready_to_deliver: runtimeResult.validation_frame.ready_to_deliver,
    artifact_count: runtimeResult.artifact_frame.artifacts.length,
    tool_count: runtimeResult.tool_results.length,
    token_usage: tokenUsage.usage,
    execution_trace: runtimeResult.execution_trace_frame?.counters || null,
  };
  await store.audit("turn_completed", turnCompletedPayload, { userId, requestId: bundle.envelope.request_id });
  events.emit("turn_completed", turnCompletedPayload);

  // ── 8.7. Memory persistence (conversation tier, best-effort) ─────
  // The user message is the canonical thing to persist on every turn:
  // a future recall("semantic", { userId, query: "what did we
  // discuss about X?" }) should be able to find it. Long-term-memory's
  // own background extraction handles the semantic tier; here we
  // only own the conversation tier (cheap append).
  if (memoryStore && typeof memoryStore.put === "function" && conversationId) {
    try {
      await memoryStore.put({
        tier: "conversation",
        scope: { conversationId },
        item: { role: "user", text: userMessage, ts: Date.now() },
      });
      const persistedPayload = { tier: "conversation", role: "user" };
      await store.audit("memory_persisted", persistedPayload, { userId, requestId: bundle.envelope.request_id });
      events.emit("memory_persisted", { ...persistedPayload, request_id: bundle.envelope.request_id });
    } catch (_e) {
      // Memory writes must never poison a successful turn.
    }
  }

  const finalStage = runtimeResult.validation_frame.ready_to_deliver ? "delivered" : "needs_repair";
  siraMetrics.recordTurn({
    stage: finalStage,
    status: finalStage === "delivered" ? "success" : "needs_repair",
    plan: userPlan,
    durationMs: Date.now() - turnStartedAtMs,
  });

  // ── 8.5. Citation frame ──────────────────────────────────────────
  // Build a typed `citation_frame` so the client can render
  // attributions on the same footing as the other frames. Inputs:
  //   - response text: `bundle.response.user_visible_summary` (the
  //     user-facing answer that may carry [Source: N] markers).
  //   - chunks: extracted from runtime tool results that emitted a
  //     RAG-style hit array (any tool result whose `output.chunks`
  //     or `output.hits` is an array of {text/title/source/score}).
  // When neither input yields anything, `buildCitationFrame` returns
  // a no-citations frame, so this call is safe to wire unconditionally.
  const citationChunks = collectCitationChunks(runtimeResult.tool_results || []);
  const citationFrame = buildCitationFrame({
    response: bundle.response?.user_visible_summary || "",
    chunks: citationChunks,
    language: bundle.envelope.normalized_request?.language || "en",
    requestId: bundle.envelope.request_id,
  });
  if (citationFrame.has_citations) {
    const citationPayload = {
      sources_provided: citationFrame.coverage.sources_provided,
      sources_cited: citationFrame.coverage.sources_cited,
      coverage_ratio: citationFrame.coverage.coverage_ratio,
    };
    await store.audit("citation_frame_built", citationPayload, { userId, requestId: bundle.envelope.request_id });
    events.emit("citation_frame_built", { ...citationPayload, request_id: bundle.envelope.request_id });
  }
  // Final flush: end the event stream after the last emit so any
  // SSE consumer can close cleanly. Subsequent return statement
  // returns the same payload as before — non-streaming callers see
  // no behavioural change.
  events.end();

  return {
    stage: finalStage,
    request_id: bundle.envelope.request_id,
    envelope: bundle.envelope,
    intent_frame: bundle.intent_frame,
    plan_frame: bundle.plan_frame,
    tool_call_frame: bundle.tool_call_frame,
    artifact_frame: runtimeResult.artifact_frame,
    validation_frame: runtimeResult.validation_frame,
    final_response_frame: bundle.final_response_frame,
    citation_frame: citationFrame,
    response: bundle.response,
    runtime: runtimeResult,
    policy: policyVerdict,
    token_usage: tokenUsage,
    token_budget: tokenBudget,
    persisted_ids: persistedIds,
    mode: modeResolution,
    project_context: projectContext,
    recalled_memory: recalledMemory,
    summary: {
      stage: finalStage,
      mode: modeResolution.mode,
      project_id: projectContext ? projectContext.project_id : null,
      tool_count: runtimeResult.tool_results.length,
      artifact_count: runtimeResult.artifact_frame.artifacts.length,
      validation_score: runtimeResult.validation_frame.aggregate_score,
      citations: citationFrame.has_citations ? citationFrame.citations.length : 0,
      coverage_ratio: citationFrame.coverage.coverage_ratio,
      token_usage: tokenUsage.usage,
      execution_trace: runtimeResult.execution_trace_frame?.counters || null,
    },
  };
}

/**
 * Walk the runtime tool results and collect any chunk arrays that
 * look RAG-shaped. We accept several common shapes — `output.chunks`,
 * `output.hits`, `output.results` — because different tools emit
 * different keys, but all of them carry the same `{text, title?,
 * source?, score?}` triple. Tools that don't emit chunks contribute
 * nothing to the citation frame.
 */
function collectCitationChunks(toolResults) {
  if (!Array.isArray(toolResults) || toolResults.length === 0) return [];
  const out = [];
  for (const tc of toolResults) {
    const output = tc?.output;
    if (!output || typeof output !== "object") continue;
    const arrays = [output.chunks, output.hits, output.results];
    for (const arr of arrays) {
      if (Array.isArray(arr)) {
        for (const c of arr) {
          if (c && typeof c === "object" && (c.text || c.title || c.source)) {
            out.push({
              text: typeof c.text === "string" ? c.text : "",
              title: c.title || c.source || null,
              source: c.source || c.title || null,
              score: typeof c.score === "number" ? c.score : null,
            });
          }
        }
      }
    }
  }
  return out;
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
