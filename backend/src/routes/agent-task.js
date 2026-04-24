/**
 * agent-task — Claude-style agentic task runner.
 *
 * POST /api/agent/task (SSE)
 *   body: { goal: string, chatId?: string, model?: string, maxSteps?: number, maxRuntimeMs?: number }
 *
 *   Emits an event stream of structured "step cards" the frontend
 *   renders as collapsible tiles (title → code preview → ✓ Listo →
 *   optional file-artifact download).
 *
 *   Event shapes:
 *     { type: "meta",         goal, model, tools: string[] }
 *     { type: "step_start",   id, label, icon?: "python"|"bash"|"search"|"doc"|"thought" }
 *     { type: "tool_call",    stepId, tool, preview, language?, codePreview? }
 *     { type: "tool_output",  stepId, tool, ok, preview, partial? }
 *     { type: "step_done",    id, ok, summary? }
 *     { type: "file_artifact", id, filename, mime, sizeBytes, downloadUrl }
 *     { type: "final_text",   markdown }
 *     { type: "done",         stoppedReason, stats }
 *     { type: "error",        message }
 *
 * GET /api/agent/artifact/:id
 *   Serves a previously-created artifact as an attachment download.
 *
 * The route intentionally stays thin: the heavy lifting is in
 * services/react-agent.js (the iterative tool loop) and
 * services/agents/task-tools.js (the tools the agent can call).
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const OpenAI = require('openai');

const { authenticateToken } = require('../middleware/auth');
const reactAgent = require('../services/react-agent');
const { buildTaskTools, ARTIFACT_DIR } = require('../services/agents/task-tools');
const taskStore = require('../services/agents/task-store');
const auditLog = require('../services/agents/audit-log');
const metrics = require('../services/agents/metrics');
const {
  buildExecutionProfile,
  buildExecutionProfilePrompt,
  validateFinalize,
} = require('../services/agents/agentic-execution-profile');
const {
  buildUserIntentAlignmentProfile,
  buildUserIntentAlignmentPrompt,
} = require('../services/agents/user-intent-alignment');
const {
  buildAgentTaskPlan,
  buildAgentTaskPlanPrompt,
} = require('../services/agents/agent-task-plan');
const { resolveTaskContract } = require('../services/agents/task-contract-resolver');
const {
  buildUniversalTaskContract,
  deriveLegacyTaskContract,
  enforceLegacyTaskContract,
  buildUniversalContractPrompt,
} = require('../services/agents/universal-task-contract');
const {
  buildEnterpriseExecutionGraph,
  buildEnterpriseRuntimeProfile,
  buildEnterpriseExecutionPrompt,
} = require('../services/agents/enterprise-agentic-runtime');

const prisma = (() => {
  try { return require('../config/database'); } catch { return null; }
})();

const router = express.Router();
const ACTIVE_AGENT_TASKS = new Map();
const TASK_RETENTION_MS = 6 * 60 * 60 * 1000;
const TASK_EVENT_LIMIT = 600;

const TASK_SYSTEM_PROMPT = `You are siraGPT's task agent. You work like Claude Code: plan briefly, then call tools to reach a deliverable answer.

Rules:
- When the user needs data, call web_search (Web of Science / Scopus / OpenAlex / SciELO / Semantic Scholar / Crossref / PubMed / DOAJ) instead of guessing. Do not fabricate citations.
- When the user refers to uploaded/private documents, previous project knowledge, PDFs, or "según mis archivos":
    · If they want a CONCRETE ANSWER grounded on those docs (a question, a claim, a quote, a number) → call self_rag_answer. It runs the Self-RAG reflection-token loop (ISREL/ISSUP/ISUSE per segment, beam ranking) and returns a cited answer you can quote verbatim in finalize — do NOT rewrite supported segments, only compose around them.
    · If you only need RAW CHUNKS to combine with other data (build a table, cross-check with web_search, etc.) → call rag_retrieve instead.
- When the user asks for a file (Excel, Word, PPT, PDF), use create_document. Write a complete Python script that writes to os.environ["OUT_PATH"]. Prefer openpyxl / python-docx / python-pptx / reportlab.
- Use python_exec for data wrangling, verification, numeric work — ANY time you'd otherwise "estimate" a number.
- For academic/scientific/market research, collect enough evidence first, keep DOI/URL/year/journal/source metadata, and separate verified findings from assumptions.
- For strict academic deliverables (for example "40 articles", "only DOI", "only open access", "only Latin America", "2022-2026"), do not pad the file with weak or unverified sources. Refine web_search queries until the requested count is met; if verified sources are still fewer than requested, state the exact verified count and label the missing gap instead of inventing rows.
- In Excel/Word bibliographic deliverables, DOI cells/URLs must use canonical https://doi.org/<doi> links when a DOI exists, and the file must include validation/status columns when the user asks for real sources.
- For long-running software/design work, iterate: inspect requirements, implement or generate, run tests/verification, repair failures, and only then finalize.
- When you generate non-trivial CODE (functions, classes, scripts), you MUST call run_tests with a small test_source that calls _check(name, condition, detail) for each invariant the user asked for. If any test fails, repair the source and re-run before finalize. Use python for python solutions, node/javascript for JS.
- Every tool call must be justified by a one-sentence thought in the assistant text preceding the call.
- **MANDATORY self-supervision**: after EVERY create_document call, you MUST call verify_artifact with the returned id. Read the structured summary it returns:
  · For an Excel: confirm the sheet exists, the row/column count matches what the user asked for, the headers are exactly what was requested.
  · For a Word/PDF: confirm the paragraph/page count is reasonable for the brief.
  · For a CSV/JSON: confirm the row count and columns/keys match.
  If verification reveals a gap (wrong count, missing column, wrong header), call create_document AGAIN with a corrected script. Do not finalize until verify_artifact returns a result that satisfies the original request.
- If web_search returned fewer sources than the user asked for, call web_search again with a refined query before building the deliverable.
- When ready, call the \`finalize\` tool with markdown that summarises what you delivered (numbers verified, file location, key findings). Do NOT write the final answer as free text — only via finalize.
- Respond in the same language as the user. Keep thoughts short (1-2 sentences); save the depth for the finalize markdown. Each thought line should describe what you're about to do in concrete terms ("Construyendo el Excel con 30 filas en hoja 'Fuentes'", not just "Working on Excel").`;

// ─── GET /api/agent/artifact/:id ────────────────────────────────────────

router.get('/artifact/:id', authenticateToken, (req, res) => {
  const id = String(req.params.id || '').replace(/[^a-f0-9]/gi, '');
  if (!id || id.length > 40) return res.status(400).json({ error: 'bad id' });

  // Find the file by stored-name prefix. We only stored one file per
  // id (content-addressed), so a single readdir is enough.
  if (!fs.existsSync(ARTIFACT_DIR)) return res.status(404).json({ error: 'no artifacts yet' });
  const entry = fs.readdirSync(ARTIFACT_DIR).find(f => f.startsWith(`${id}-`));
  if (!entry) return res.status(404).json({ error: 'artifact not found' });

  const metadata = readArtifactMetadata(id);
  if (!metadata?.ownerUserId) {
    return res.status(403).json({ error: 'artifact ownership metadata missing' });
  }
  if (String(metadata.ownerUserId) !== String(req.user?.id)) {
    return res.status(403).json({ error: 'artifact not found' });
  }

  const full = path.join(ARTIFACT_DIR, entry);
  const userSuppliedName = typeof req.query.name === 'string' ? req.query.name : entry.slice(id.length + 1);
  const safeName = userSuppliedName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'artifact';
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.sendFile(full);
});

// ─── GET /api/agent/task/:taskId ───────────────────────────────────────

router.get('/task/:taskId', authenticateToken, (req, res) => {
  const task = getTaskForUser(req.params.taskId, req.user?.id)
    || taskStore.getTaskSnapshotForUser(req.params.taskId, req.user?.id);
  if (!task) return res.status(404).json({ error: 'task not found' });

  res.json({ ok: true, ...formatTaskPayload(task) });
});

// ─── POST /api/agent/task/:taskId/cancel ───────────────────────────────

router.post('/task/:taskId/cancel', authenticateToken, (req, res) => {
  const task = getTaskForUser(req.params.taskId, req.user?.id);
  if (!task) {
    const snapshot = taskStore.getTaskSnapshotForUser(req.params.taskId, req.user?.id);
    if (!snapshot) return res.status(404).json({ error: 'task not found' });
    if (snapshot.status === 'running') {
      taskStore.markTaskStatus(snapshot, 'cancelled', {
        streamState: {
          ...(snapshot.streamState || {}),
          done: true,
          error: 'Tarea cancelada desde una sesión recuperada.',
        },
      });
    }
    return res.json({ ok: true, taskId: snapshot.taskId, status: 'cancelled' });
  }
  if (task.status !== 'running') {
    return res.json({ ok: true, taskId: task.taskId, status: task.status });
  }

  task.status = 'cancelled';
  task.cancelledAt = new Date().toISOString();
  task.updatedAt = task.cancelledAt;
  task.controller.abort();
  appendTaskEvent(task, { type: 'error', message: 'Tarea detenida por el usuario.' }, {
    ...task.streamState,
    done: true,
    error: 'Tarea detenida por el usuario.',
  });
  taskStore.markTaskStatus(task, 'cancelled', { streamState: task.streamState });
  metrics.counter('agent_task_cancellations_total', { reason: 'user' });

  res.json({ ok: true, taskId: task.taskId, status: task.status });
});

// ─── POST /api/agent/task ───────────────────────────────────────────────

router.post(
  '/task',
  [
    body('goal').isString().trim().isLength({ min: 3, max: 4000 }).withMessage('goal must be 3-4000 chars'),
    body('displayGoal').optional().isString().trim().isLength({ min: 3, max: 4000 }),
    body('systemContract').optional().isString().trim().isLength({ max: 4000 }),
    body('files').optional().isArray({ max: 20 }),
    body('files.*').optional().isString().trim().isLength({ min: 1, max: 200 }),
    body('chatId').optional().isString(),
    body('model').optional().isString(),
    body('maxSteps').optional().isInt({ min: 2, max: 120 }),
    body('maxRuntimeMs').optional().isInt({ min: 60000, max: 7200000 }),
  ],
  authenticateToken,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

    const rawGoal = String(req.body.goal || '');
    const displayGoal = normalizeDisplayGoal(req.body.displayGoal || rawGoal);
    const agentGoal = normalizeDisplayGoal(rawGoal);
    const systemContract = normalizeSystemContract(
      req.body.systemContract || extractProfessionalContract(rawGoal)
    );
    const fileIds = Array.isArray(req.body.files)
      ? req.body.files.map(String).filter(Boolean).slice(0, 20)
      : [];
    const executionProfile = buildExecutionProfile({ goal: agentGoal, fileIds });
    const intentAlignmentProfile = buildUserIntentAlignmentProfile({ request: agentGoal, fileIds });
    const universalTaskContract = buildUniversalTaskContract({
      rawUserRequest: agentGoal,
      fileIds,
    });
    const finalizeProfile = buildFinalizeProfile(executionProfile, universalTaskContract);
    // The UniversalTaskContract is now the source of truth. The
    // legacy TaskContract is only the ArtifactReviewer adapter. LLM
    // resolution may add tests, but it cannot override extension/MIME
    // sovereignty.
    let taskContract = deriveLegacyTaskContract(universalTaskContract);
    let taskContractSource = 'fallback';
    try {
      const bootOpenAI = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const resolved = await resolveTaskContract({
        goal: agentGoal,
        openai: bootOpenAI,
        fileIds,
        fallback: () => deriveLegacyTaskContract(universalTaskContract),
      });
      taskContract = enforceLegacyTaskContract(resolved.contract || taskContract, universalTaskContract);
      taskContractSource = resolved.source || taskContractSource;
    } catch (err) {
      console.warn('[agent-task] task-contract resolver failed, using fallback:', err?.message);
    }
    const taskPlan = buildAgentTaskPlan({
      goal: agentGoal,
      executionProfile,
      intentAlignmentProfile,
      universalTaskContract,
      fileIds,
      maxRuntimeMs: Number.isFinite(Number.parseInt(req.body.maxRuntimeMs, 10))
        ? Number.parseInt(req.body.maxRuntimeMs, 10)
        : 2 * 60 * 60 * 1000,
    });
    const taskId = crypto.randomUUID();
    const enterpriseExecutionGraph = buildEnterpriseExecutionGraph({
      contract: universalTaskContract,
      taskId,
      userId: req.user?.id || null,
      chatId: typeof req.body.chatId === 'string' ? req.body.chatId : null,
    });
    const enterpriseRuntimeProfile = buildEnterpriseRuntimeProfile(universalTaskContract, enterpriseExecutionGraph);
    const taskStartedAt = Date.now();
    const chatId = typeof req.body.chatId === 'string' ? req.body.chatId : null;
    auditLog.audit({
      event: 'contract_created',
      taskId,
      userId: req.user?.id || null,
      chatId,
      pipeline: universalTaskContract.pipeline,
      requiredExtension: universalTaskContract.required_extension,
      riskLevel: universalTaskContract.risk_level,
    });
    auditLog.audit({
      event: 'execution_graph_created',
      taskId,
      userId: req.user?.id || null,
      chatId,
      graphId: enterpriseExecutionGraph.graph_id,
      nodes: enterpriseExecutionGraph.nodes.length,
      layers: enterpriseExecutionGraph.architecture_layers,
      hitlRequired: enterpriseExecutionGraph.human_in_the_loop.required,
    });
    const controller = new AbortController();
    const model = typeof req.body.model === 'string' && req.body.model.length > 0 ? req.body.model : 'gpt-4o';
    const parsedMaxSteps = Number.parseInt(req.body.maxSteps, 10);
    const parsedMaxRuntimeMs = Number.parseInt(req.body.maxRuntimeMs, 10);
    const maxSteps = Number.isFinite(parsedMaxSteps) ? parsedMaxSteps : 60;
    const maxRuntimeMs = Number.isFinite(parsedMaxRuntimeMs) ? parsedMaxRuntimeMs : 2 * 60 * 60 * 1000;
    let streamState = initialAgentState();
    const task = createTaskRecord({
      taskId,
      userId: req.user?.id,
      chatId,
      displayGoal,
      model,
      controller,
      maxSteps,
      maxRuntimeMs,
      streamState,
      executionProfile,
      intentAlignmentProfile,
      taskPlan,
      universalTaskContract,
      enterpriseExecutionGraph,
      enterpriseRuntimeProfile,
    });
    metrics.counter('agent_task_invocations_total', { status: 'started' });
    auditLog.audit({
      event: 'agent_task_started',
      taskId,
      userId: req.user?.id || null,
      chatId,
      model,
      maxSteps,
      maxRuntimeMs,
      requiredTools: executionProfile.requiredTools,
      planPhases: taskPlan.phases.map((phase) => phase.id),
      contractPipeline: universalTaskContract.pipeline,
      contractRequiredExtension: universalTaskContract.required_extension,
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let clientConnected = true;
    const send = (obj) => {
      if (!clientConnected || res.writableEnded) return;
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ }
    };
    req.on('close', () => {
      clientConnected = false;
      // If the task belongs to a chat, keep it running and persist the
      // final trace. This is the practical "continue while I leave the
      // browser" path. Orphaned requests are aborted to avoid leaks.
      if (!chatId) controller.abort();
    });

    const heartbeat = setInterval(() => {
      if (!clientConnected || res.writableEnded) return;
      try { res.write(': keep-alive\n\n'); } catch { /* client gone */ }
    }, 25000);

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const tools = buildTaskTools();
    const runtimeTimer = setTimeout(() => controller.abort(), maxRuntimeMs + 5000);

    let assistantMessageId = null;
    let persistTimer = null;
    let lastPersistAt = 0;
    const persistTaskState = async (status = 'running') => {
      if (!assistantMessageId || !prisma) return;
      task.status = status;
      task.updatedAt = new Date().toISOString();
      lastPersistAt = Date.now();
      taskStore.markTaskStatus(task, status, { streamState });
      try {
        await prisma.message.update({
          where: { id: assistantMessageId },
          data: {
            content: serializeAgentState(streamState),
            tokens: Math.ceil(serializeAgentState(streamState).length / 4),
            metadata: {
              source: 'agent-task',
              taskId,
              status,
              displayGoal,
              artifacts,
              executionProfile,
              intentAlignmentProfile,
              taskPlan,
              universalTaskContract,
              enterpriseExecutionGraph,
              enterpriseRuntimeProfile,
              maxSteps,
              maxRuntimeMs,
              updatedAt: task.updatedAt,
            },
          },
        });
      } catch (e) { /* non-fatal */ }
    };
    const schedulePersistTaskState = (status = 'running') => {
      if (!assistantMessageId || !prisma) return;
      const elapsed = Date.now() - lastPersistAt;
      const delay = elapsed >= 1500 ? 0 : 1500 - elapsed;
      if (delay === 0) {
        void persistTaskState(status);
        return;
      }
      if (!persistTimer) {
        persistTimer = setTimeout(() => {
          persistTimer = null;
          void persistTaskState(status);
        }, delay);
      }
    };

    const applyEvent = (obj) => {
      streamState = reduceAgentState(streamState, obj);
      appendTaskEvent(task, obj, streamState);
      return obj;
    };
    const emit = (obj) => {
      const applied = applyEvent(obj);
      send(applied);
      metrics.counter('agent_task_events_total', { type: obj.type || 'unknown' });
      schedulePersistTaskState();
      return applied;
    };

    emit({
      type: 'meta',
      taskId,
      goal: displayGoal,
      model,
      tools: tools.map(t => t.name),
      executionProfile,
      intentAlignmentProfile,
      taskPlan,
      universalTaskContract,
      enterpriseExecutionGraph,
      enterpriseRuntimeProfile,
      taskContract,
      taskContractSource,
    });

    // Per-step id counter shared with the tool event bus so the UI
    // can group tool_call + tool_output events under the step card
    // the user is watching.
    let stepIdCounter = 0;
    let currentStepId = null;
    const artifacts = [];

    const toolCtx = {
      userId: req.user?.id,
      userEmail: req.user?.email,
      openai,
      signal: controller.signal,
      chatId,
      taskId,
      fileIds,
      displayGoal,
      // The TaskContract is the authoritative source of truth for
      // every downstream validation. Tools that produce artifacts
      // run the ArtifactReviewer against this contract and feed any
      // failed tests back to the agent as part of their tool_result,
      // so the next ReAct turn can self-repair instead of finalize.
      taskContract,
      universalTaskContract,
      onEvent: (evt) => {
        // Forward tool-level events (tool_call / tool_output / file_artifact)
        // to the client with the active stepId so it can nest them.
        const payload = { ...evt, stepId: currentStepId };
        if (evt.type === 'file_artifact') {
          artifacts.push(evt.artifact);
        }
        emit(payload);
      },
    };

    // Persist the user turn and a live assistant placeholder up front so a chat
    // reload shows progress instead of losing the trace while the agent keeps
    // working in the background.
    if (chatId && prisma) {
      try {
        const chat = await prisma.chat.findFirst({ where: { id: chatId, userId: req.user.id } });
        if (chat) {
          await prisma.message.create({
            data: { chatId, role: 'USER', content: displayGoal, timestamp: new Date() },
          });
          const assistant = await prisma.message.create({
            data: {
              chatId,
              role: 'ASSISTANT',
              content: serializeAgentState(streamState),
              timestamp: new Date(),
              metadata: {
                source: 'agent-task',
                taskId,
                status: 'running',
                displayGoal,
                artifacts,
                executionProfile,
                intentAlignmentProfile,
              taskPlan,
              universalTaskContract,
              enterpriseExecutionGraph,
              enterpriseRuntimeProfile,
              maxSteps,
              maxRuntimeMs,
              updatedAt: new Date().toISOString(),
              },
            },
          });
          assistantMessageId = assistant.id;
          task.assistantMessageId = assistant.id;
        }
      } catch (e) { /* non-fatal */ }
    }

    try {
      const result = await reactAgent.run(openai, {
        query: agentGoal,
        tools,
        maxSteps,
        maxRuntimeMs,
        model,
        extraSystem: buildAgentSystemPrompt(
          systemContract,
          fileIds,
          executionProfile,
          intentAlignmentProfile,
          taskPlan,
          taskContract,
          universalTaskContract,
          enterpriseExecutionGraph,
          enterpriseRuntimeProfile
        ),
        ctx: toolCtx,
        finalizeGuard: ({ steps }) => validateFinalize(finalizeProfile, steps),
        onStepStart: (step) => {
          // react-agent gives us THE assistant turn (thought + tool
          // invocations). We turn the `thought` line into a
          // step_start card so the UI has an immediate tile to show,
          // and the ctx.onEvent hook inside each tool emits the
          // tool_call / tool_output frames that nest under it.
          stepIdCounter += 1;
          currentStepId = `s${stepIdCounter}`;
          const thought = (step.thought || '').trim();
          const firstAction = step.actions?.[0];
          const label = thought || firstAction?.tool || 'Pensando…';
          const icon = inferIconFor(firstAction?.tool);
          emit({ type: 'step_start', id: currentStepId, label: shortLabel(label), icon });
        },
        onStepDone: (step) => {
          const firstAction = step.actions?.[0];
          // tool_call / tool_output already streamed via toolCtx.onEvent
          emit({ type: 'step_done', id: currentStepId, ok: !firstAction?.observation?.error });
          currentStepId = null;
        },
      });

      if (result.finalAnswer) {
        emit({ type: 'final_text', markdown: result.finalAnswer });
      }

      const doneEvent = applyEvent({
        type: 'done',
        stoppedReason: result.stoppedReason,
        stats: { steps: result.steps.length, artifacts: artifacts.length },
      });

      // Persist the final assistant message with artifacts metadata.
      let dbMessage = null;
      if (chatId && prisma && (result.finalAnswer || streamState.steps.length || artifacts.length)) {
        try {
          const data = {
              content: serializeAgentState(streamState),
              tokens: Math.ceil((result.finalAnswer || serializeAgentState(streamState)).length / 4),
              metadata: {
                source: 'agent-task',
                taskId,
                status: result.stoppedReason === 'aborted' ? 'cancelled' : 'completed',
                displayGoal,
                artifacts,
                executionProfile,
                intentAlignmentProfile,
                taskPlan,
                universalTaskContract,
                enterpriseExecutionGraph,
                enterpriseRuntimeProfile,
                stoppedReason: result.stoppedReason,
                maxSteps,
                maxRuntimeMs,
                updatedAt: new Date().toISOString(),
              },
            };
          if (assistantMessageId) {
            dbMessage = await prisma.message.update({ where: { id: assistantMessageId }, data });
          } else {
            dbMessage = await prisma.message.create({
              data: { chatId, role: 'ASSISTANT', timestamp: new Date(), ...data },
            });
          }
        } catch (e) { /* non-fatal */ }
      }

      const outboundDoneEvent = {
        ...doneEvent,
        dbMessageId: dbMessage?.id || null,
      };
      task.status = result.stoppedReason === 'aborted' ? 'cancelled' : 'completed';
      task.updatedAt = new Date().toISOString();
      taskStore.markTaskStatus(task, task.status, {
        streamState,
        stats: {
          steps: result.steps.length,
          artifacts: artifacts.length,
          durationMs: Date.now() - taskStartedAt,
          stoppedReason: result.stoppedReason,
        },
        artifacts,
      });
      metrics.counter('agent_task_invocations_total', { status: task.status });
      metrics.observe('agent_task_duration_ms', { status: task.status }, Date.now() - taskStartedAt);
      metrics.counter('agent_task_artifacts_total', { status: task.status }, artifacts.length);
      auditLog.audit({
        event: 'agent_task_finished',
        taskId,
        userId: req.user?.id || null,
        chatId,
        status: task.status,
        stoppedReason: result.stoppedReason,
        steps: result.steps.length,
        artifacts: artifacts.length,
        durationMs: Date.now() - taskStartedAt,
      });
      send(outboundDoneEvent);
      clearTimeout(runtimeTimer);
      clearInterval(heartbeat);
      if (persistTimer) clearTimeout(persistTimer);
      try { res.end(); } catch { /* already closed */ }
    } catch (err) {
      console.error('[agent-task] fatal:', err);
      const message = controller.signal.aborted ? 'Tarea detenida por el usuario.' : (err.message || 'agent task failed');
      task.status = controller.signal.aborted ? 'cancelled' : 'error';
      emit({ type: 'error', message });
      taskStore.markTaskStatus(task, task.status, {
        streamState,
        stats: { durationMs: Date.now() - taskStartedAt, error: message },
      });
      metrics.counter('agent_task_invocations_total', { status: task.status });
      metrics.observe('agent_task_duration_ms', { status: task.status }, Date.now() - taskStartedAt);
      auditLog.audit({
        event: 'agent_task_failed',
        taskId,
        userId: req.user?.id || null,
        chatId,
        status: task.status,
        error: message,
        durationMs: Date.now() - taskStartedAt,
      });
      await persistTaskState(task.status);
      clearTimeout(runtimeTimer);
      clearInterval(heartbeat);
      if (persistTimer) clearTimeout(persistTimer);
      try { res.end(); } catch { /* already closed */ }
    }
  }
);

// ─── helpers ────────────────────────────────────────────────────────────

function shortLabel(s, max = 160) {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max) + '…' : one;
}

function inferIconFor(toolName) {
  switch (toolName) {
    case 'python_exec':     return 'python';
    case 'bash_exec':       return 'bash';
    case 'web_search':      return 'search';
    case 'create_document': return 'doc';
    case 'verify_artifact': return 'verify';
    case 'run_tests':       return 'verify';
    case 'rag_retrieve':    return 'search';
    case 'self_rag_answer': return 'verify';
    case 'finalize':        return 'check';
    default:                return 'thought';
  }
}

function buildFinalizeProfile(executionProfile, universalTaskContract) {
  const executableContractTools = new Set(
    (universalTaskContract?.required_tools || [])
      .filter((tool) => tool !== 'finalize')
      .filter((tool) => [
        'web_search',
        'create_document',
        'verify_artifact',
        'rag_retrieve',
        'self_rag_answer',
        'python_exec',
        'run_tests',
      ].includes(tool))
  );
  const requiredTools = Array.from(new Set([
    ...(executionProfile?.requiredTools || []),
    ...executableContractTools,
  ]));
  return {
    ...(executionProfile || {}),
    requiredTools,
    minimumToolCalls: {
      ...(executionProfile?.minimumToolCalls || {}),
      ...(universalTaskContract?.source_requirements?.verification_policy === 'strict' && executableContractTools.has('web_search')
        ? { web_search: Math.max(2, executionProfile?.minimumToolCalls?.web_search || 0) }
        : {}),
    },
  };
}

function readArtifactMetadata(id) {
  const metadataPath = path.join(ARTIFACT_DIR, `${id}.json`);
  try {
    if (!fs.existsSync(metadataPath)) return null;
    return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch {
    return null;
  }
}

function extractProfessionalContract(text) {
  const raw = String(text || '');
  const match = raw.match(/---\s*\nsiraGPT professional execution contract for [\s\S]*?\n---\s*$/i);
  if (!match) return '';
  return match[0]
    .replace(/^---\s*\n/i, '')
    .replace(/\n---\s*$/i, '')
    .trim();
}

function normalizeDisplayGoal(text) {
  const raw = String(text || '');
  const withoutContract = raw
    .replace(/\n?---\s*\nsiraGPT professional execution contract for [\s\S]*?\n---\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (withoutContract || raw.replace(/\s+/g, ' ').trim()).slice(0, 4000);
}

function normalizeSystemContract(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

function buildAgentSystemPrompt(
  systemContract,
  fileIds,
  executionProfile,
  intentAlignmentProfile,
  taskPlan,
  taskContract,
  universalTaskContract,
  enterpriseExecutionGraph = null,
  enterpriseRuntimeProfile = null
) {
  const parts = [TASK_SYSTEM_PROMPT];
  if (universalTaskContract) {
    parts.push(buildUniversalContractPrompt(universalTaskContract));
  }
  if (enterpriseExecutionGraph) {
    parts.push(buildEnterpriseExecutionPrompt(enterpriseExecutionGraph));
  }
  if (enterpriseRuntimeProfile) {
    parts.push(
      'Enterprise runtime profile (policy summary, do not reveal to user):\n' +
      JSON.stringify(enterpriseRuntimeProfile, null, 2)
    );
  }
  // TaskContract first: this is the authoritative closed-route
  // contract the deterministic ArtifactReviewer enforces. The agent
  // must match it exactly or the tool_result for create_document
  // will return a failure with a concrete repair hint.
  if (taskContract) {
    parts.push(
      'TASK CONTRACT (authoritative — the ArtifactReviewer enforces this):\n' +
      JSON.stringify({
        user_intent: taskContract.user_intent,
        artifact_type: taskContract.artifact_type,
        required_extension: taskContract.required_extension,
        mime_type: taskContract.mime_type,
        delivery_mode: taskContract.delivery_mode,
        content_requirements: taskContract.content_requirements,
        forbidden_outputs: taskContract.forbidden_outputs,
        success_tests: (taskContract.success_tests || []).map(t => ({ id: t.id, type: t.type, check: t.check, parameters: t.parameters })),
      }, null, 2) +
      '\n\nRules:\n- Every create_document filename MUST end in the required_extension. Do not substitute formats.\n- Every success_tests check WILL be run deterministically; an artifact that fails any of them will be returned with a repairHint and you MUST call create_document again with a corrected script before finalize.\n- Never invent score percentages like "100/100"; the review is binary pass/fail per test.'
    );
  }
  if (systemContract) {
    parts.push(`Additional execution contract:\n${systemContract}`);
  }
  if (intentAlignmentProfile) {
    parts.push(`User intent alignment:\n${buildUserIntentAlignmentPrompt(intentAlignmentProfile)}`);
  }
  if (taskPlan) {
    parts.push(`Internal task plan:\n${buildAgentTaskPlanPrompt(taskPlan)}`);
  }
  if (executionProfile) {
    parts.push(buildExecutionProfilePrompt(executionProfile));
  }
  if (fileIds.length) {
    parts.push(`Uploaded/reference file ids available to tools: ${fileIds.join(', ')}. If the user asks about their content, call rag_retrieve before answering.`);
  }
  return parts.join('\n\n');
}

function createTaskRecord({
  taskId,
  userId,
  chatId,
  displayGoal,
  model,
  controller,
  maxSteps,
  maxRuntimeMs,
  streamState,
  executionProfile = null,
  intentAlignmentProfile = null,
  taskPlan = null,
  universalTaskContract = null,
  enterpriseExecutionGraph = null,
  enterpriseRuntimeProfile = null,
}) {
  pruneOldTasks();
  const now = new Date().toISOString();
  const record = {
    taskId,
    userId: String(userId || ''),
    chatId,
    displayGoal,
    model,
    controller,
    maxSteps,
    maxRuntimeMs,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    streamState,
    executionProfile,
    intentAlignmentProfile,
    taskPlan,
    universalTaskContract,
    enterpriseExecutionGraph,
    enterpriseRuntimeProfile,
    events: [],
    assistantMessageId: null,
  };
  ACTIVE_AGENT_TASKS.set(taskId, record);
  try {
    taskStore.writeTaskSnapshot(record);
  } catch (err) {
    console.warn('[agent-task] durable task write failed:', err.message);
  }
  return record;
}

function getTaskForUser(taskId, userId) {
  pruneOldTasks();
  const cleanId = String(taskId || '');
  const task = ACTIVE_AGENT_TASKS.get(cleanId);
  if (!task || String(task.userId) !== String(userId || '')) return null;
  return task;
}

function appendTaskEvent(task, event, streamState) {
  if (!task) return;
  task.events.push({ ...event, ts: new Date().toISOString() });
  if (task.events.length > TASK_EVENT_LIMIT) {
    task.events.splice(0, task.events.length - TASK_EVENT_LIMIT);
  }
  task.streamState = streamState;
  task.updatedAt = new Date().toISOString();
  try {
    taskStore.appendTaskEvent(task, event, streamState, { eventLimit: TASK_EVENT_LIMIT });
  } catch (err) {
    console.warn('[agent-task] durable event write failed:', err.message);
  }
}

function pruneOldTasks() {
  const cutoff = Date.now() - TASK_RETENTION_MS;
  for (const [id, task] of ACTIVE_AGENT_TASKS.entries()) {
    const updated = Date.parse(task.updatedAt || task.createdAt || 0);
    if (Number.isFinite(updated) && updated < cutoff && task.status !== 'running') {
      ACTIVE_AGENT_TASKS.delete(id);
    }
  }
}

function formatTaskPayload(task) {
  return {
    taskId: task.taskId,
    status: task.status,
    displayGoal: task.displayGoal,
    model: task.model,
    chatId: task.chatId || null,
    assistantMessageId: task.assistantMessageId || null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt || null,
    cancelledAt: task.cancelledAt || null,
    failedAt: task.failedAt || null,
    streamState: task.streamState,
    events: task.events || [],
    executionProfile: task.executionProfile || null,
    intentAlignmentProfile: task.intentAlignmentProfile || null,
    taskPlan: task.taskPlan || null,
    universalTaskContract: task.universalTaskContract || null,
    enterpriseExecutionGraph: task.enterpriseExecutionGraph || null,
    enterpriseRuntimeProfile: task.enterpriseRuntimeProfile || null,
    stats: task.stats || null,
    checkpoints: task.checkpoints || [],
  };
}

function initialAgentState() {
  return { steps: [], artifacts: [], finalText: '', done: false };
}

function reduceAgentState(state, evt) {
  switch (evt.type) {
    case 'meta':
      return { ...state, meta: { taskId: evt.taskId, goal: evt.goal, model: evt.model, tools: evt.tools, executionProfile: evt.executionProfile, intentAlignmentProfile: evt.intentAlignmentProfile, taskPlan: evt.taskPlan, universalTaskContract: evt.universalTaskContract, enterpriseExecutionGraph: evt.enterpriseExecutionGraph, enterpriseRuntimeProfile: evt.enterpriseRuntimeProfile } };
    case 'step_start':
      return {
        ...state,
        steps: [...state.steps, {
          id: evt.id,
          label: evt.label,
          icon: evt.icon,
          status: 'running',
          toolCalls: [],
        }],
      };
    case 'tool_call': {
      const stepId = evt.stepId || `tool-${state.steps.length + 1}`;
      const steps = state.steps.some(step => step.id === stepId)
        ? state.steps
        : [...state.steps, {
          id: stepId,
          label: evt.tool,
          icon: 'thought',
          status: 'running',
          toolCalls: [],
        }];
      return {
        ...state,
        steps: steps.map(step =>
          step.id === stepId
            ? { ...step, toolCalls: [...step.toolCalls, { tool: evt.tool, preview: evt.preview, language: evt.language, codePreview: evt.codePreview }] }
            : step
        ),
      };
    }
    case 'tool_output': {
      const stepId = evt.stepId || `tool-${state.steps.length + 1}`;
      const steps = state.steps.some(step => step.id === stepId)
        ? state.steps
        : [...state.steps, {
          id: stepId,
          label: evt.tool,
          icon: 'thought',
          status: 'running',
          toolCalls: [{ tool: evt.tool, preview: '' }],
        }];
      return {
        ...state,
        steps: steps.map(step => {
          if (step.id !== stepId) return step;
          const toolCalls = [...step.toolCalls];
          let attached = false;
          for (let i = toolCalls.length - 1; i >= 0; i--) {
            if (toolCalls[i].tool === evt.tool && !toolCalls[i].output) {
              toolCalls[i] = { ...toolCalls[i], output: { ok: evt.ok, preview: evt.preview } };
              attached = true;
              break;
            }
          }
          if (!attached) {
            toolCalls.push({ tool: evt.tool, preview: '', output: { ok: evt.ok, preview: evt.preview } });
          }
          return { ...step, toolCalls };
        }),
      };
    }
    case 'step_done':
      return {
        ...state,
        steps: state.steps.map(step =>
          step.id === evt.id ? { ...step, status: evt.ok ? 'done' : 'error' } : step
        ),
      };
    case 'file_artifact':
      return { ...state, artifacts: [...state.artifacts, evt.artifact] };
    case 'final_text':
      return { ...state, finalText: evt.markdown };
    case 'done':
      return { ...state, done: true, stoppedReason: evt.stoppedReason };
    case 'error':
      return { ...state, done: true, error: evt.message };
    default:
      return state;
  }
}

function serializeAgentState(state) {
  const fenced = '```agent-task-state\n' + JSON.stringify(state) + '\n```';
  return state.finalText ? `${fenced}\n\n${state.finalText}` : fenced;
}

router.INTERNAL = {
  ACTIVE_AGENT_TASKS,
  TASK_EVENT_LIMIT,
  appendTaskEvent,
  buildAgentSystemPrompt,
  createTaskRecord,
  extractProfessionalContract,
  formatTaskPayload,
  getTaskForUser,
  initialAgentState,
  normalizeDisplayGoal,
  normalizeSystemContract,
  reduceAgentState,
  serializeAgentState,
};

module.exports = router;
