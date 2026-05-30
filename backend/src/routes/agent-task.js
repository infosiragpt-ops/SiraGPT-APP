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
const { enforcePlanQuota } = require('../middleware/enforce-plan-quota');
const { resolveRateLimitConfig, makeJwtAwareKeyGenerator, extractBearerToken } = require('../middleware/rate-limit-policy');
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
const { buildToolRuntimePlan } = require('../services/agents/enterprise-tool-gateway');
const { buildAgenticQaBoardReview } = require('../services/agents/agentic-qa-board');
const {
  buildAgenticOperatingCore,
  buildAgenticOperatingPrompt,
} = require('../services/agents/agentic-operating-core');
const durableExecutionStore = require('../services/agents/durable-execution-store');
const { buildDocumentDeliveryPolicy } = require('../services/agents/document-delivery-policy');
const { buildLangGraphLayer } = require('../services/agents/agentic-langgraph');
const { buildAgenticFrameworkStatus } = require('../services/agents/agentic-frameworks');
const {
  cancelQueuedTask,
  enqueueAgentTask,
  getQueueName,
  requireRedisUrl,
} = require('../services/agents/agent-task-queue');
const { cancelRunningTask } = require('../services/agents/agent-task-worker');
const agentTaskPersistence = require('../services/agents/agent-task-persistence');
const {
  buildUploadedFileContext,
  normalizeClientMetadata,
  resolveTranscriptionFileIds,
  serializeMessageAttachments,
} = require('../services/message-attachments');
const {
  MAX_SIMULTANEOUS_DOCUMENTS,
} = require('../config/document-batch-limits');

const prisma = (() => {
  try { return require('../config/database'); } catch { return null; }
})();

// ── Utility: safe JSON serialization ──────────────────────────────
// Never throws on circular refs, BigInt, Symbol, or undefined values.
function safeJsonStringify(obj, maxLen = 32_768) {
  const seen = new WeakSet();
  try {
    const str = JSON.stringify(obj, (key, value) => {
      if (typeof value === 'bigint') return `BigInt(${value.toString()})`;
      if (typeof value === 'symbol') return value.toString();
      if (value instanceof Error) return { message: value.message, stack: value.stack };
      if (value !== null && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      if (value === undefined) return null;
      return value;
    });
    return str.length > maxLen ? str.slice(0, maxLen) : str;
  } catch {
    return JSON.stringify({ error: 'non-serializable', type: typeof obj });
  }
}

const router = express.Router();

// ── Rate limiting for agent task creation ──────────────────────
// Blocks excessive POST requests per user (authed) or IP (anonymous).
// Skip rate limiting entirely when the env asks for it (dev/test).
const AGENT_RATE_DISABLED = process.env.AGENT_RATE_LIMIT_DISABLED === '1';
const AGENT_RATE_MAX_DEFAULT = 30;
const jwtSecret = process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET || '';
const agentKeyGen = makeJwtAwareKeyGenerator(jwtSecret);

const agentRateBuckets = new Map(); // key → { hits, resetAt }
const AGENT_RATE_WINDOW = parseInt(process.env.AGENT_RATE_LIMIT_WINDOW_MS, 10) || 60_000;
const AGENT_RATE_MAX = parseInt(process.env.AGENT_RATE_LIMIT_MAX, 10) || AGENT_RATE_MAX_DEFAULT;

function agentRateLimiter(req, res, next) {
  if (AGENT_RATE_DISABLED) return next();
  const key = agentKeyGen(req);
  const now = Date.now();
  let bucket = agentRateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { hits: 0, resetAt: now + AGENT_RATE_WINDOW };
    agentRateBuckets.set(key, bucket);
  }
  bucket.hits++;
  const remaining = Math.max(0, AGENT_RATE_MAX - bucket.hits);
  const resetSec = Math.ceil((bucket.resetAt - now) / 1000);
  res.set('X-RateLimit-Limit', String(AGENT_RATE_MAX));
  res.set('X-RateLimit-Remaining', String(remaining));
  res.set('X-RateLimit-Reset', String(resetSec));
  if (bucket.hits > AGENT_RATE_MAX) {
    return res.status(429).json({
      ok: false,
      error: 'rate_limit_exceeded',
      message: 'Demasiadas solicitudes. Intenta de nuevo más tarde.',
      retryAfterMs: bucket.resetAt - now,
    });
  }
  next();
}

// Periodic cleanup of stale buckets (every 5 min)
if (!AGENT_RATE_DISABLED) {
  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of agentRateBuckets) {
      if (now > bucket.resetAt) agentRateBuckets.delete(key);
    }
  }, 300_000).unref();
}
const ACTIVE_AGENT_TASKS = new Map();
const TASK_RETENTION_MS = 6 * 60 * 60 * 1000;
const TASK_EVENT_LIMIT = 600;

const TASK_SYSTEM_PROMPT = `You are siraGPT's task agent. You work like Claude Code: plan briefly, then call tools to reach a deliverable answer.

Rules:
- When the user needs data, call web_search (Web of Science / Scopus / OpenAlex / SciELO / Semantic Scholar / Crossref / PubMed / DOAJ) instead of guessing. Do not fabricate citations.
- When the user refers to uploaded/private documents, previous project knowledge, PDFs, or "según mis archivos":
    · First call docintel_analyze/docintel_retrieve when the task is document understanding ("analiza", "resume", "extrae", "que dice", "segun el documento", "transcribe"). These tools expose OCR coverage, chunks, tables and evidence refs. Do not show raw JSON to the user.
    · If the user asks to compare documents, versions, matrices, tables, or differences, call docintel_compare before finalizing.
    · If they want a CONCRETE ANSWER grounded on those docs (a question, a claim, a quote, a number) → call self_rag_answer. It runs the Self-RAG reflection-token loop (ISREL/ISSUP/ISUSE per segment, beam ranking) and returns a cited answer you can quote verbatim in finalize — do NOT rewrite supported segments, only compose around them.
    · If you only need RAW CHUNKS to combine with other data (build a table, cross-check with web_search, etc.) → call rag_retrieve instead.
- When the user asks to transcribe ("transcribir", "transcribe", "transcripción") and there is uploaded or pasted content, return the readable content verbatim, preserving line breaks and headings when useful. Do NOT explain what transcription is, do NOT summarize, and do NOT create a Word/PDF/PPT/Excel unless the user explicitly asks for that output format. If no readable text is available, say that clearly and ask for a readable file/audio/image.
- When the user asks for a file (Excel, Word, PPT, PDF), use create_document. The deliverable must be authored by executable code, not placeholder prose: write a complete Python script that builds the real content, visual hierarchy, tables/slides/sections and writes to os.environ["OUT_PATH"]. Prefer openpyxl / python-docx / python-pptx / reportlab.
- When the user uploads a Word/Excel/PowerPoint/PDF and asks to modify, improve, correct, fill, translate, summarize into, or continue "in my own file", treat the upload as a read-only source. Never overwrite or mutate the original. Create a new artifact in the same format unless the user explicitly asks for another format. Preserve logos/images, tables, formulas, sheet names, headers, footers, slide layouts, styling, and document order as far as the available libraries allow; change only what the user requested.
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

// ─── GET /api/agent/task/:taskId/events?after=<seq> ────────────────────

router.get('/task/:taskId/events', authenticateToken, (req, res) => {
  const task = getTaskForUser(req.params.taskId, req.user?.id)
    || taskStore.getTaskSnapshotForUser(req.params.taskId, req.user?.id);
  if (!task) return res.status(404).json({ error: 'task not found' });

  const allEvents = task.events || [];
  const afterRaw = String(req.query.after || '0');
  const numericAfter = Number.parseInt(afterRaw, 10);
  const after = Number.isFinite(numericAfter)
    ? numericAfter
    : (allEvents.find((event) => String(event.id) === afterRaw)?.seq || 0);
  const events = allEvents.filter((event) => (Number(event.seq) || 0) > after);
  res.json({
    ok: true,
    taskId: task.taskId,
    status: task.status,
    queue: task.queueName || getQueueName(),
    traceId: task.traceId || null,
    documentPolicy: task.documentPolicy || task.streamState?.documentPolicy || null,
    events,
    streamState: task.streamState || null,
    artifacts: task.artifacts || task.streamState?.artifacts || [],
  });
});

// ─── POST /api/agent/task/:taskId/approval ────────────────────────────

router.post(
  '/task/:taskId/approval',
  agentRateLimiter,
  [
    body('decision').isIn(['approve', 'reject', 'edit']).withMessage('decision must be approve, reject or edit'),
    body('payload').optional().isObject(),
  ],
  authenticateToken,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const task = getTaskForUser(req.params.taskId, req.user?.id)
      || taskStore.getTaskSnapshotForUser(req.params.taskId, req.user?.id);
    if (!task) return res.status(404).json({ error: 'task not found' });

    const event = {
      type: 'human_approval_resolved',
      taskId: task.taskId,
      approvalId: req.body.payload?.approvalId || `approval-${Date.now()}`,
      decision: req.body.decision,
      payload: req.body.payload || {},
      resolvedBy: req.user?.id || null,
    };
    const streamState = reduceAgentState(task.streamState || initialAgentState(), event);
    const written = taskStore.appendTaskEvent(task, event, streamState, { eventLimit: TASK_EVENT_LIMIT }) || task;
    task.streamState = streamState;
    task.events = written.events || task.events || [];
    task.lastEventSeq = written.lastEventSeq || task.lastEventSeq || 0;
    await agentTaskPersistence.appendAgentTaskEvent(written, written.events?.[written.events.length - 1] || event);
    await agentTaskPersistence.upsertAgentTask({ ...written, status: task.status || written.status, state: streamState });

    metrics.counter('agent_task_human_approvals_total', { decision: req.body.decision });
    auditLog.audit({
      event: 'agent_task_human_approval_resolved',
      taskId: task.taskId,
      userId: req.user?.id || null,
      decision: req.body.decision,
      approvalId: event.approvalId,
    });
    res.json({ ok: true, taskId: task.taskId, approvalId: event.approvalId, decision: req.body.decision });
  }
);

// ─── POST /api/agent/task/:taskId/cancel ───────────────────────────────

router.post('/task/:taskId/cancel', authenticateToken, async (req, res) => {
  const task = getTaskForUser(req.params.taskId, req.user?.id);
  if (!task) {
    const snapshot = taskStore.getTaskSnapshotForUser(req.params.taskId, req.user?.id);
    if (!snapshot) return res.status(404).json({ error: 'task not found' });
    let queueCancel = null;
    try { queueCancel = await cancelQueuedTask(snapshot.jobId || snapshot.taskId); } catch { /* redis unavailable */ }
    const runningCancel = await cancelRunningTask(snapshot.taskId, req.user?.id);
    if (['queued', 'running'].includes(snapshot.status)) {
      let streamState = {
        ...(snapshot.streamState || initialAgentState()),
        done: true,
        error: 'Tarea cancelada por el usuario.',
      };
      streamState = reduceAgentState(streamState, { type: 'queue_status', taskId: snapshot.taskId, status: 'cancelled', queue: snapshot.queueName || getQueueName(), jobId: snapshot.jobId || snapshot.taskId });
      const writtenCancel = taskStore.appendTaskEvent(snapshot, { type: 'error', message: 'Tarea cancelada por el usuario.' }, streamState, { eventLimit: TASK_EVENT_LIMIT });
      await agentTaskPersistence.appendAgentTaskEvent(writtenCancel || snapshot, writtenCancel?.events?.[writtenCancel.events.length - 1] || { type: 'error', message: 'Tarea cancelada por el usuario.' });
      taskStore.markTaskStatus(snapshot, 'cancelled', {
        streamState,
      });
      await agentTaskPersistence.upsertAgentTask({ ...snapshot, status: 'cancelled', state: streamState });
    }
    return res.json({ ok: true, taskId: snapshot.taskId, status: 'cancelled', queueCancel, runningCancel });
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
  if (task.durableExecution?.graphId) {
    try {
      durableExecutionStore.markExecutionStatus(task.durableExecution.graphId, task.userId, 'cancelled', {
        stats: { cancelledBy: 'user' },
      });
    } catch (err) {
      console.warn('[agent-task] durable graph cancellation write failed:', err.message);
    }
  }
  metrics.counter('agent_task_cancellations_total', { reason: 'user' });

  res.json({ ok: true, taskId: task.taskId, status: task.status });
});

// ─── POST /api/agent/task/:taskId/retry ────────────────────────────────

router.post('/task/:taskId/retry', authenticateToken, async (req, res) => {
  const snapshot = getTaskForUser(req.params.taskId, req.user?.id)
    || taskStore.getTaskSnapshotForUser(req.params.taskId, req.user?.id);
  if (!snapshot) return res.status(404).json({ error: 'task not found' });
  if (!['error', 'cancelled'].includes(snapshot.status)) {
    return res.status(409).json({ error: 'task is not retryable', status: snapshot.status });
  }

  try {
    requireRedisUrl();
    const job = await enqueueAgentTask({
      taskId: snapshot.taskId,
      traceId: snapshot.traceId || crypto.randomUUID(),
      user: { id: req.user?.id, email: req.user?.email },
      goal: snapshot.agentGoal || snapshot.displayGoal,
      displayGoal: snapshot.displayGoal,
      systemContract: snapshot.systemContract || '',
      files: snapshot.fileIds || [],
      chatId: snapshot.chatId || null,
      model: snapshot.model || 'gpt-4o',
      maxSteps: snapshot.maxSteps || 60,
      maxRuntimeMs: snapshot.maxRuntimeMs || 2 * 60 * 60 * 1000,
      retryOf: snapshot.taskId,
      documentPolicy: snapshot.documentPolicy || null,
    }, { priority: 1, jobId: `${snapshot.taskId}-retry-${Date.now()}` });

    let streamState = snapshot.streamState || initialAgentState();
    const retryEvent = {
      type: 'repair_attempt',
      attempt: (snapshot.repairs?.length || streamState.repairs?.length || 0) + 1,
      status: 'queued',
      message: 'Reintentando desde el último checkpoint durable.',
    };
    streamState = reduceAgentState(streamState, retryEvent);
    const retryWritten = taskStore.appendTaskEvent({ ...snapshot, status: 'queued', jobId: job.id, queueName: getQueueName() }, retryEvent, streamState, { eventLimit: TASK_EVENT_LIMIT });
    await agentTaskPersistence.appendAgentTaskEvent(retryWritten || snapshot, retryWritten?.events?.[retryWritten.events.length - 1] || retryEvent);
    const queueEvent = { type: 'queue_status', taskId: snapshot.taskId, status: 'queued', queue: getQueueName(), jobId: String(job.id), position: null };
    streamState = reduceAgentState(streamState, queueEvent);
    const queued = taskStore.appendTaskEvent({ ...snapshot, status: 'queued', jobId: job.id, queueName: getQueueName() }, queueEvent, streamState, { eventLimit: TASK_EVENT_LIMIT });
    taskStore.markTaskStatus({ ...queued, userId: req.user?.id }, 'queued', {
      jobId: String(job.id),
      queueName: getQueueName(),
      streamState,
    });
    await agentTaskPersistence.upsertAgentTask({
      ...snapshot,
      userId: req.user?.id,
      status: 'queued',
      jobId: String(job.id),
      queueName: getQueueName(),
      state: streamState,
    });
    res.json({ ok: true, taskId: snapshot.taskId, jobId: String(job.id), status: 'queued', queue: getQueueName() });
  } catch (err) {
    res.status(503).json({ error: err.message || 'agent retry unavailable' });
  }
});

// ─── POST /api/agent/workspace-workflow ─────────────────────────────────
// Replit-style durable chained orchestration (10–20 h budget).

const workspaceWorkflowOrchestrator = require('../services/agents/workspace-workflow-orchestrator');
const workspaceIdempotency = require('../services/agents/workspace-idempotency');
const chatTaskScope = require('../services/agents/chat-task-scope');

const WORKFLOW_RATE_MAX = parseInt(process.env.WORKFLOW_RATE_LIMIT_MAX || '6', 10);
const workflowRateBuckets = new Map();

function workspaceWorkflowRateLimiter(req, res, next) {
  if (AGENT_RATE_DISABLED) return next();
  const key = `wf:${agentKeyGen(req)}`;
  const now = Date.now();
  let bucket = workflowRateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { hits: 0, resetAt: now + AGENT_RATE_WINDOW };
    workflowRateBuckets.set(key, bucket);
  }
  bucket.hits += 1;
  if (bucket.hits > WORKFLOW_RATE_MAX) {
    return res.status(429).json({
      ok: false,
      error: 'workflow_rate_limit_exceeded',
      message: 'Demasiados workflows largos en curso. Espera antes de encolar otro.',
      retryAfterMs: bucket.resetAt - now,
    });
  }
  return next();
}

router.post(
  '/workspace-workflow',
  workspaceWorkflowRateLimiter,
  agentRateLimiter,
  [
    body('goal').isString().trim().isLength({ min: 8, max: 8000 }),
    body('model').optional().isString().trim().isLength({ min: 2, max: 120 }),
    body('maxSteps').optional().isInt({ min: 10, max: 200 }),
    body('maxRuntimeMs').optional().isInt({ min: 3_600_000, max: 72_000_000 }),
    body('chatId').optional().isString(),
    body('scopeMode').optional().isIn(['chat', 'global']),
    body('files').optional().isArray({ max: MAX_SIMULTANEOUS_DOCUMENTS }),
  ],
  authenticateToken,
  enforcePlanQuota({ surface: 'agent.task.create' }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const scope = await chatTaskScope.assertChatScopeForAgentTask({
      prisma,
      userId: req.user?.id,
      body: req.body,
    });
    if (!scope.ok) return res.status(scope.status).json(scope.body);
    req.body.chatId = scope.chatId;

    const built = workspaceWorkflowOrchestrator.buildWorkspaceWorkflowJob({
      goal: req.body.goal,
      user: req.user,
      model: req.body.model,
      maxSteps: req.body.maxSteps,
      maxRuntimeMs: req.body.maxRuntimeMs,
      chatId: req.body.chatId,
      fileIds: req.body.files,
    });
    if (!built.ok) {
      return res.status(400).json({ error: built.error });
    }

    const existing = workspaceIdempotency.findExistingWorkflow(
      req.user?.id,
      req.body.goal,
      req.body.chatId
    );
    if (existing?.taskId) {
      return res.status(200).json({
        ok: true,
        deduplicated: true,
        taskId: existing.taskId,
        jobId: existing.jobId,
        message: 'Workflow ya encolado para este objetivo',
      });
    }

    const { payload, taskId, traceId, plan, subTasks, maxRuntimeMs, model, displayGoal, documentPolicy } = built;

    if (process.env.AGENT_TASK_INLINE === '1') {
      return res.status(501).json({
        error: 'workspace-workflow requires queued agent runtime (unset AGENT_TASK_INLINE)',
      });
    }

    const { isRedisRecentlyUnhealthy, getLastRedisFailureMessage } = require('../services/agents/redis-resilience');
    if (isRedisRecentlyUnhealthy()) {
      return res.status(503).json({
        error: 'Redis no disponible para workflows largos',
        detail: getLastRedisFailureMessage(),
      });
    }

    let job;
    try {
      job = await enqueueAgentTask(payload);
    } catch (err) {
      const message = err?.message ? String(err.message) : String(err);
      return res.status(503).json({ error: message || 'enqueue failed' });
    }

    workspaceIdempotency.registerWorkflow(req.user?.id, req.body.goal, req.body.chatId, {
      taskId,
      jobId: String(job.id),
      status: 'queued',
    });

    const streamState = initialAgentState();
    taskStore.writeTaskSnapshot({
      taskId,
      userId: req.user?.id,
      chatId: payload.chatId,
      displayGoal,
      agentGoal: payload.goal,
      systemContract: payload.systemContract,
      fileIds: payload.files,
      model,
      maxSteps: payload.maxSteps,
      maxRuntimeMs,
      status: 'queued',
      jobId: String(job.id),
      queueName: getQueueName(),
      traceId,
      documentPolicy,
      streamState,
      executionProfile: payload.executionProfile,
      intentAlignmentProfile: payload.intentAlignmentProfile,
      taskPlan: plan,
      events: [],
      artifacts: [],
    });

    return res.status(202).json({
      ok: true,
      taskId,
      queued: true,
      plan,
      subTasks,
      maxRuntimeMs,
      model,
    });
  },
);

// ─── POST /api/agent/task ───────────────────────────────────────────────

router.post(
  '/task',
  agentRateLimiter,
  [
    body('goal').isString().trim().isLength({ min: 3, max: 4000 }).withMessage('goal must be 3-4000 chars'),
    body('displayGoal').optional().isString().trim().isLength({ min: 3, max: 4000 }),
    body('systemContract').optional().isString().trim().isLength({ max: 4000 }),
    body('files').optional().isArray({ max: MAX_SIMULTANEOUS_DOCUMENTS }),
    body('files.*').optional().isString().trim().isLength({ min: 1, max: 200 }),
    body('chatId').optional().isString(),
    body('scopeMode').optional().isIn(['chat', 'global']),
    body('model').optional().isString(),
    body('maxSteps').optional().isInt({ min: 2, max: 120 }),
    body('maxRuntimeMs').optional().isInt({ min: 60000, max: 72_000_000 }),
  ],
  authenticateToken,
  // Plan-quota enforcement on the durable task creation path.
  // Agent tasks consume LLM tokens and queue worker time, so they
  // belong with the FREE/PAID quota check. See docs/plan-quotas.md.
  enforcePlanQuota({ surface: 'agent.task.create' }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const scope = await chatTaskScope.assertChatScopeForAgentTask({
      prisma,
      userId: req.user?.id,
      body: req.body,
    });
    if (!scope.ok) return res.status(scope.status).json(scope.body);
    req.body.chatId = scope.chatId;

    const requestedFileIds = Array.isArray(req.body.files)
      ? req.body.files.map(String).filter(Boolean).slice(0, MAX_SIMULTANEOUS_DOCUMENTS)
      : [];
    const canUseLocalDocumentRuntime = requestedFileIds.length > 0 || isTranscriptionRequest(String(req.body.goal || ''));
    if (!process.env.OPENAI_API_KEY && !canUseLocalDocumentRuntime) {
      return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
    }

    if (process.env.AGENT_TASK_INLINE !== '1') {
      return handleQueuedTaskRequest(req, res);
    }
    if (!process.env.OPENAI_API_KEY && canUseLocalDocumentRuntime) {
      return handleLocalTaskRequest(req, res, { fallbackReason: 'openai_not_configured' });
    }

    const rawGoal = String(req.body.goal || '');
    const displayGoal = normalizeDisplayGoal(req.body.displayGoal || rawGoal);
    const agentGoal = normalizeDisplayGoal(rawGoal);
    const systemContract = normalizeSystemContract(
      req.body.systemContract || extractProfessionalContract(rawGoal)
    );
    let fileIds = Array.isArray(req.body.files)
      ? req.body.files.map(String).filter(Boolean).slice(0, MAX_SIMULTANEOUS_DOCUMENTS)
      : [];
    if (fileIds.length === 0 && isTranscriptionRequest(agentGoal)) {
      fileIds = await resolveTranscriptionFileIds(prisma, {
        userId: req.user?.id,
        chatId: typeof req.body.chatId === 'string' ? req.body.chatId : null,
        providedFileIds: fileIds,
      });
    }
    const clientFileMetadata = normalizeClientMetadata(req.body.fileMetadata, fileIds);
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
    const chatId = typeof req.body.chatId === 'string' ? req.body.chatId : null;
    const enterpriseExecutionGraph = buildEnterpriseExecutionGraph({
      contract: universalTaskContract,
      taskId,
      userId: req.user?.id || null,
      chatId,
    });
    const enterpriseToolRuntimePlan = buildToolRuntimePlan({
      contract: universalTaskContract,
      graph: enterpriseExecutionGraph,
    });
    const enterpriseQaBoardReview = buildAgenticQaBoardReview({
      contract: universalTaskContract,
      graph: enterpriseExecutionGraph,
      toolRuntimePlan: enterpriseToolRuntimePlan,
      phase: 'preflight',
    });
    const agenticOperatingCore = buildAgenticOperatingCore({
      contract: universalTaskContract,
      graph: enterpriseExecutionGraph,
      toolRuntimePlan: enterpriseToolRuntimePlan,
      qaBoardReview: enterpriseQaBoardReview,
    });
    let durableExecution = null;
    try {
      durableExecution = durableExecutionStore.createDurableExecutionRecord({
        graph: enterpriseExecutionGraph,
        contract: universalTaskContract,
        taskId,
        userId: req.user?.id || null,
        chatId,
        toolRuntimePlan: enterpriseToolRuntimePlan,
        qaBoardReview: enterpriseQaBoardReview,
      });
    } catch (err) {
      console.warn('[agent-task] durable execution record failed:', err?.message || err);
    }
    const enterpriseRuntimeProfile = {
      ...buildEnterpriseRuntimeProfile(universalTaskContract, enterpriseExecutionGraph),
      agenticOperatingCore: agenticOperatingCore.summary,
      toolRuntime: enterpriseToolRuntimePlan.summary,
      qaPreflight: enterpriseQaBoardReview.summary,
      durableExecution: durableExecution
        ? {
          graphId: durableExecution.graphId,
          persisted: true,
          nodeCount: durableExecution.nodes.length,
          checkpointCount: durableExecution.checkpoints.length,
        }
        : {
          graphId: enterpriseExecutionGraph.graph_id,
          persisted: false,
        },
    };
    const taskStartedAt = Date.now();
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
    auditLog.audit({
      event: enterpriseToolRuntimePlan.ok ? 'tool_runtime_authorized' : 'tool_runtime_blocked',
      taskId,
      userId: req.user?.id || null,
      chatId,
      graphId: enterpriseExecutionGraph.graph_id,
      authorizedToolCount: enterpriseToolRuntimePlan.summary.authorizedToolCount,
      blockerCount: enterpriseToolRuntimePlan.summary.blockerCount,
      warningCount: enterpriseToolRuntimePlan.summary.warningCount,
      requiresHumanConfirmation: enterpriseToolRuntimePlan.summary.requiresHumanConfirmation,
    });
    auditLog.audit({
      event: 'qa_preflight_completed',
      taskId,
      userId: req.user?.id || null,
      chatId,
      graphId: enterpriseExecutionGraph.graph_id,
      decision: enterpriseQaBoardReview.summary.decision,
      reason: enterpriseQaBoardReview.summary.reason,
      blockerCount: enterpriseQaBoardReview.summary.blockerCount,
      warningCount: enterpriseQaBoardReview.summary.warningCount,
    });
    const controller = new AbortController();
    const model = typeof req.body.model === 'string' && req.body.model.length > 0 ? req.body.model : 'gpt-4o';
    const parsedMaxSteps = Number.parseInt(req.body.maxSteps, 10);
    const parsedMaxRuntimeMs = Number.parseInt(req.body.maxRuntimeMs, 10);
    const maxSteps = Number.isFinite(parsedMaxSteps) ? parsedMaxSteps : 60;
    const maxRuntimeMs = Number.isFinite(parsedMaxRuntimeMs) ? parsedMaxRuntimeMs : 2 * 60 * 60 * 1000;
    const documentPolicy = buildDocumentDeliveryPolicy({
      goal: agentGoal,
      displayGoal,
      files: fileIds,
    });
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
      enterpriseToolRuntimePlan,
      enterpriseQaBoardReview,
      agenticOperatingCore,
      durableExecution,
      documentPolicy,
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

    // ── SSE hardening: never drop a client without sending done ──
    let clientConnected = true;
    let heartbeatTimer = null;
    let responseTimeoutTimer = null;

    const RESPONSE_TIMEOUT_MS = Number.isFinite(process.env.AGENT_RESPONSE_TIMEOUT_MS)
      ? Number(process.env.AGENT_RESPONSE_TIMEOUT_MS)
      : 3 * 60 * 60 * 1000; // 3h default

    /** Safe SSE write. Returns true if written, false if client gone. */
    const send = (obj) => {
      if (!clientConnected || res.writableEnded) return false;
      try {
        const serialized = safeJsonStringify(obj);
        res.write(`data: ${serialized}\n\n`);
        return true;
      } catch {
        safeCloseConnection();
        return false;
      }
    };

    function safeCloseConnection() {
      clientConnected = false;
      clearTimers();
      if (!res.writableEnded && !res.destroyed) {
        try { res.end(); } catch { /* already closed */ }
      }
    }

    function clearTimers() {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (responseTimeoutTimer) { clearTimeout(responseTimeoutTimer); responseTimeoutTimer = null; }
    }

    res.on('close', () => {
      clientConnected = false;
      clearTimers();
      // If the task belongs to a chat, keep it running and persist the
      // final trace. This is the practical "continue while I leave the
      // browser" path. Orphaned requests are aborted to avoid leaks.
      if (!chatId) controller.abort();
    });
    res.on('error', () => {
      clientConnected = false;
      clearTimers();
      if (!chatId) controller.abort();
    });

    // Heartbeat keeps proxies (nginx, Cloudflare) from closing the stream
    heartbeatTimer = setInterval(() => {
      if (!clientConnected || res.writableEnded) { clearTimers(); return; }
      try { res.write(': keep-alive\n\n'); } catch { safeCloseConnection(); }
    }, 25000);
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

    // Response timeout ensures we never leave a socket hanging
    responseTimeoutTimer = setTimeout(() => {
      if (!clientConnected || res.writableEnded) return;
      console.warn('[agent-task] response timeout reached, aborting');
      controller.abort();
    }, RESPONSE_TIMEOUT_MS);
    if (typeof responseTimeoutTimer.unref === 'function') responseTimeoutTimer.unref();

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const forbiddenToolNames = new Set(Array.isArray(universalTaskContract.forbidden_tools)
      ? universalTaskContract.forbidden_tools
      : []);
    const tools = buildTaskTools().filter((tool) => !forbiddenToolNames.has(tool.name));
    const langGraphLayer = await buildLangGraphLayer({ taskId, documentPolicy });
    const frameworkStatus = await buildAgenticFrameworkStatus({ tools, langGraphLayer });
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
              enterpriseToolRuntimePlan,
              enterpriseQaBoardReview,
              agenticOperatingCore,
              documentPolicy,
              frameworks: frameworkStatus,
              durableExecution: enterpriseRuntimeProfile.durableExecution,
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

    emit({ type: 'document_policy', policy: documentPolicy });
    emit({
      type: 'framework_status',
      taskId,
      ...frameworkStatus,
    });
    emit({
      type: 'checkpoint',
      label: langGraphLayer.enabled ? 'LangGraph durable listo' : 'Grafo durable fallback listo',
      status: 'saved',
      payload: {
        provider: langGraphLayer.provider,
        enabled: langGraphLayer.enabled,
        nodes: langGraphLayer.nodes,
        checkpointer: langGraphLayer.checkpointer || null,
        humanInTheLoop: Boolean(langGraphLayer.humanInTheLoop),
        fallback: langGraphLayer.fallback || null,
      },
    });
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
      enterpriseToolRuntimePlan,
      enterpriseQaBoardReview,
      agenticOperatingCore,
      frameworks: frameworkStatus,
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
      enterpriseExecutionGraph,
      enterpriseRuntimeProfile,
      enterpriseToolRuntimePlan,
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
    const uploadedFileContext = await buildUploadedFileContext(prisma, {
      userId: req.user?.id,
      fileIds,
      query: displayGoal || agentGoal,
    });

    // Persist the user turn and a live assistant placeholder up front so a chat
    // reload shows progress instead of losing the trace while the agent keeps
    // working in the background.
    if (chatId && prisma) {
      try {
        const chat = await prisma.chat.findFirst({ where: { id: chatId, userId: req.user.id } });
        if (chat) {
          const messageFiles = await serializeMessageAttachments(prisma, {
            userId: req.user.id,
            fileIds,
            clientMetadata: clientFileMetadata,
          });
          await prisma.message.create({
            data: {
              chatId,
              role: 'USER',
              content: displayGoal,
              files: messageFiles.length ? messageFiles : null,
              timestamp: new Date(),
              metadata: { source: 'agent-task-user', taskId, fileIds },
            },
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
              enterpriseToolRuntimePlan,
              enterpriseQaBoardReview,
              agenticOperatingCore,
              documentPolicy,
              frameworks: frameworkStatus,
              durableExecution: enterpriseRuntimeProfile.durableExecution,
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
          enterpriseRuntimeProfile,
          enterpriseToolRuntimePlan,
          enterpriseQaBoardReview,
          agenticOperatingCore,
          uploadedFileContext
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
                enterpriseToolRuntimePlan,
                enterpriseQaBoardReview,
                agenticOperatingCore,
                durableExecution: enterpriseRuntimeProfile.durableExecution,
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
      if (task.durableExecution?.graphId) {
        try {
          durableExecutionStore.markExecutionStatus(task.durableExecution.graphId, task.userId, task.status, {
            stats: {
              steps: result.steps.length,
              artifacts: artifacts.length,
              durationMs: Date.now() - taskStartedAt,
              stoppedReason: result.stoppedReason,
            },
          });
        } catch (err) {
          console.warn('[agent-task] durable graph status write failed:', err.message);
        }
      }
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
      safeCloseConnection();
      if (persistTimer) clearTimeout(persistTimer);
    } catch (err) {
      console.error('[agent-task] fatal:', err);
      const message = controller.signal.aborted ? 'Tarea detenida por el usuario.' : (err.message || 'agent task failed');
      task.status = controller.signal.aborted ? 'cancelled' : 'error';
      emit({ type: 'error', message });
      taskStore.markTaskStatus(task, task.status, {
        streamState,
        stats: { durationMs: Date.now() - taskStartedAt, error: message },
      });
      if (task.durableExecution?.graphId) {
        try {
          durableExecutionStore.markExecutionStatus(task.durableExecution.graphId, task.userId, task.status, {
            stats: { durationMs: Date.now() - taskStartedAt, error: message },
          });
        } catch (writeErr) {
          console.warn('[agent-task] durable graph status write failed:', writeErr.message);
        }
      }
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
      safeCloseConnection();
      if (persistTimer) clearTimeout(persistTimer);
    }
  }
);

// ─── helpers ────────────────────────────────────────────────────────────

/**
 * runAgentJobInProcess — fire-and-forget execution of an agent task in the
 * current process (no BullMQ worker). Writes events to the same taskId
 * snapshot that `streamTaskEvents` is polling, so the SSE keeps flowing.
 * On a throw it writes a terminal `error` event via failTaskTerminal so the
 * client never hangs. Used by the queue→local handoff watchdog.
 */
function runAgentJobInProcess(payload, userId) {
  Promise.resolve().then(async () => {
    try {
      const { runAgentTaskJob } = require('../services/agents/agent-task-runner');
      await runAgentTaskJob(payload, {
        id: `local-${payload.taskId}`,
        updateProgress: async () => {},
      });
    } catch (err) {
      failTaskTerminal(payload.taskId, userId, err?.message || 'agent task failed');
    }
  });
}

async function handleQueuedTaskRequest(req, res) {
  const rawGoal = String(req.body.goal || '');
  try {
    requireRedisUrl();
  } catch (err) {
    // REDIS_URL is not configured at all — always run locally so chat
    // keeps working regardless of request type. The in-process runner
    // handles documents, transcription, and plain chat goals.
    return handleLocalTaskRequest(req, res, {
      fallbackReason: 'redis_unavailable',
      fallbackDetail: err.message,
    });
  }
  // Circuit breaker: if Redis has recently surfaced a transient error
  // (Upstash daily limit, connection drop, rate limit, etc.) skip the
  // queue entirely and serve the task via the in-process runtime. The
  // marker auto-clears after the unhealthy window, so we re-enable
  // queued mode as soon as Redis recovers. This prevents the "Runtime
  // agentico no disponible" red banner from leaking to the user when
  // BullMQ's offline queue would otherwise hang waiting on Redis.
  const { isRedisRecentlyUnhealthy, getLastRedisFailureMessage } = require('../services/agents/redis-resilience');
  if (isRedisRecentlyUnhealthy()) {
    return handleLocalTaskRequest(req, res, {
      fallbackReason: 'redis_unhealthy',
      fallbackDetail: getLastRedisFailureMessage() || 'recent transient redis error',
    });
  }

  const displayGoal = normalizeDisplayGoal(req.body.displayGoal || rawGoal);
  const agentGoal = normalizeDisplayGoal(rawGoal);
  const systemContract = normalizeSystemContract(
    req.body.systemContract || extractProfessionalContract(rawGoal)
  );
  let fileIds = Array.isArray(req.body.files)
    ? req.body.files.map(String).filter(Boolean).slice(0, MAX_SIMULTANEOUS_DOCUMENTS)
    : [];
  if (fileIds.length === 0 && isTranscriptionRequest(agentGoal)) {
    fileIds = await resolveTranscriptionFileIds(prisma, {
      userId: req.user?.id,
      chatId: typeof req.body.chatId === 'string' ? req.body.chatId : null,
      providedFileIds: fileIds,
    });
  }
  const clientFileMetadata = normalizeClientMetadata(req.body.fileMetadata, fileIds);
  const taskId = crypto.randomUUID();
  const traceId = crypto.randomUUID();
  const chatId = typeof req.body.chatId === 'string' ? req.body.chatId : null;
  const model = typeof req.body.model === 'string' && req.body.model.length > 0 ? req.body.model : 'gpt-4o';
  const parsedMaxSteps = Number.parseInt(req.body.maxSteps, 10);
  const parsedMaxRuntimeMs = Number.parseInt(req.body.maxRuntimeMs, 10);
  const maxSteps = Number.isFinite(parsedMaxSteps) ? parsedMaxSteps : 60;
  const maxRuntimeMs = Number.isFinite(parsedMaxRuntimeMs) ? parsedMaxRuntimeMs : 2 * 60 * 60 * 1000;
  const documentPolicy = buildDocumentDeliveryPolicy({
    goal: agentGoal,
    displayGoal,
    files: fileIds,
  });

  const payload = {
    taskId,
    traceId,
    user: { id: req.user?.id, email: req.user?.email },
    goal: agentGoal,
    displayGoal,
    systemContract,
    files: fileIds,
    fileMetadata: clientFileMetadata,
    chatId,
    model,
    maxSteps,
    maxRuntimeMs,
    documentPolicy,
  };

  let job;
  try {
    job = await enqueueAgentTask(payload);
  } catch (err) {
    // Redis enqueue can fail at runtime even when REDIS_URL is
    // configured: Upstash daily request limits, connection drops,
    // BullMQ "MaxRetriesPerRequest" errors, etc. We must not surface
    // this as a hard failure to the user — fall back to the in-process
    // local task runner (same path used when Redis is not configured
    // at all) so chat keeps working in degraded mode.
    const message = err && err.message ? String(err.message) : String(err);
    const isRedisFailure = /redis|connection|ECONN|max requests limit|enqueue|bullmq|maxretriesperrequest/i.test(message);
    if (isRedisFailure) {
      const { markRedisFailure } = require('../services/agents/redis-resilience');
      markRedisFailure(err);
      console.warn('[agent-task] enqueue failed, falling back to local runtime:', message);
      return handleLocalTaskRequest(req, res, {
        fallbackReason: 'redis_unavailable',
        fallbackDetail: message,
      });
    }
    throw err;
  }
  let streamState = initialAgentState();
  const snapshot = {
    taskId,
    userId: req.user?.id,
    chatId,
    displayGoal,
    agentGoal,
    systemContract,
    fileIds,
    fileMetadata: clientFileMetadata,
    model,
    maxSteps,
    maxRuntimeMs,
    status: 'queued',
    jobId: String(job.id),
    queueName: getQueueName(),
    traceId,
    documentPolicy,
    streamState,
    events: [],
    artifacts: [],
  };
  taskStore.writeTaskSnapshot(snapshot);

  const queueEvent = {
    type: 'queue_status',
    taskId,
    status: 'queued',
    queue: getQueueName(),
    jobId: String(job.id),
    position: null,
    estimatedWaitMs: null,
  };
  streamState = reduceAgentState(streamState, queueEvent);
  let written = taskStore.appendTaskEvent(snapshot, queueEvent, streamState, { eventLimit: TASK_EVENT_LIMIT }) || snapshot;
  await agentTaskPersistence.appendAgentTaskEvent(written, written.events?.[written.events.length - 1] || queueEvent);

  const policyEvent = { type: 'document_policy', policy: documentPolicy };
  streamState = reduceAgentState(streamState, policyEvent);
  written = taskStore.appendTaskEvent({ ...written, streamState }, policyEvent, streamState, { eventLimit: TASK_EVENT_LIMIT }) || written;
  await agentTaskPersistence.appendAgentTaskEvent(written, written.events?.[written.events.length - 1] || policyEvent);

  await agentTaskPersistence.upsertAgentTask({
    ...written,
    status: 'queued',
    jobId: String(job.id),
    queueName: getQueueName(),
    traceId,
    documentPolicy,
    state: streamState,
  });

  auditLog.audit({
    event: 'agent_task_queued',
    taskId,
    userId: req.user?.id || null,
    chatId,
    model,
    queue: getQueueName(),
    jobId: String(job.id),
    traceId,
    documentPolicy: auditLog.slimDocumentPolicy(documentPolicy),
  });
  metrics.counter('agent_task_invocations_total', { status: 'queued' });

  // ── Queue → local handoff watchdog ─────────────────────────────────
  // If the worker hasn't started the job within HANDOFF_MS — Upstash hit
  // its daily read limit, the worker is down/saturated, or BullMQ is
  // stalling — the SSE would stream only "queued" until the response
  // timeout and then close (the client renders that as
  // `stream_closed_without_done`). Instead we race-safely reclaim the job
  // and run it in-process so the user still gets a real answer. The happy
  // path is untouched: a healthy worker flips the status off 'queued'
  // within ~1s, so the watchdog finds nothing to reclaim. Disable with
  // AGENT_TASK_QUEUE_HANDOFF=0.
  if (process.env.AGENT_TASK_QUEUE_HANDOFF !== '0') {
    const handoffMs = Math.max(3000, Number.parseInt(process.env.AGENT_TASK_QUEUE_HANDOFF_MS || '12000', 10));
    const handoffTimer = setTimeout(async () => {
      try {
        const latest = taskStore.getTaskSnapshotForUser(taskId, req.user?.id);
        // Only reclaim while the worker still hasn't touched the job.
        if (!latest || latest.status !== 'queued') return;
        // Race-safe reclaim: job.remove() throws if the worker already
        // locked/started it — in which case we leave the queue stream alone.
        let reclaimed = false;
        try { await job.remove(); reclaimed = true; } catch { reclaimed = false; }
        if (!reclaimed) return;
        console.warn(`[agent-task] queue handoff → local for task ${taskId} (worker idle ${handoffMs}ms)`);
        try { metrics.counter('agent_task_invocations_total', { status: 'queue_handoff_local' }); } catch (_) {}
        try {
          auditLog.audit({
            event: 'agent_task_queue_handoff_local',
            taskId,
            userId: req.user?.id || null,
            jobId: String(job.id),
          });
        } catch (_) {}
        // Flip status so the SSE poller stops reporting "queued"; the
        // in-process runner then drives it to completion/error.
        try {
          taskStore.markTaskStatus({ ...latest, userId: req.user?.id }, 'running', { streamState: latest.streamState });
        } catch (_) { /* best-effort */ }
        runAgentJobInProcess(payload, req.user?.id);
      } catch (watchErr) {
        console.warn('[agent-task] queue handoff watchdog error:', watchErr?.message || watchErr);
      }
    }, handoffMs);
    if (typeof handoffTimer.unref === 'function') handoffTimer.unref();
    req.on('close', () => { try { clearTimeout(handoffTimer); } catch (_) {} });
  }

  return streamTaskEvents(req, res, taskId, req.user?.id);
}

async function handleLocalTaskRequest(req, res, { fallbackReason = 'local_fallback', fallbackDetail = '' } = {}) {
  const rawGoal = String(req.body.goal || '');
  const displayGoal = normalizeDisplayGoal(req.body.displayGoal || rawGoal);
  const agentGoal = normalizeDisplayGoal(rawGoal);
  const systemContract = normalizeSystemContract(
    req.body.systemContract || extractProfessionalContract(rawGoal)
  );
  let fileIds = Array.isArray(req.body.files)
    ? req.body.files.map(String).filter(Boolean).slice(0, MAX_SIMULTANEOUS_DOCUMENTS)
    : [];
  if (fileIds.length === 0 && isTranscriptionRequest(agentGoal)) {
    fileIds = await resolveTranscriptionFileIds(prisma, {
      userId: req.user?.id,
      chatId: typeof req.body.chatId === 'string' ? req.body.chatId : null,
      providedFileIds: fileIds,
    });
  }
  const clientFileMetadata = normalizeClientMetadata(req.body.fileMetadata, fileIds);
  const taskId = crypto.randomUUID();
  const traceId = crypto.randomUUID();
  const chatId = typeof req.body.chatId === 'string' ? req.body.chatId : null;
  const model = typeof req.body.model === 'string' && req.body.model.length > 0 ? req.body.model : 'gpt-4o';
  const parsedMaxSteps = Number.parseInt(req.body.maxSteps, 10);
  const parsedMaxRuntimeMs = Number.parseInt(req.body.maxRuntimeMs, 10);
  const maxSteps = Number.isFinite(parsedMaxSteps) ? parsedMaxSteps : 60;
  const maxRuntimeMs = Number.isFinite(parsedMaxRuntimeMs) ? parsedMaxRuntimeMs : 2 * 60 * 60 * 1000;
  const documentPolicy = buildDocumentDeliveryPolicy({
    goal: agentGoal,
    displayGoal,
    files: fileIds,
  });
  let streamState = initialAgentState();
  const snapshot = {
    taskId,
    userId: req.user?.id,
    chatId,
    displayGoal,
    agentGoal,
    systemContract,
    fileIds,
    fileMetadata: clientFileMetadata,
    model,
    maxSteps,
    maxRuntimeMs,
    status: 'running',
    jobId: `local-${taskId}`,
    queueName: 'local-agent-task',
    traceId,
    documentPolicy,
    streamState,
    events: [],
    artifacts: [],
  };
  taskStore.writeTaskSnapshot(snapshot);

  const queueEvent = {
    type: 'queue_status',
    taskId,
    status: 'running',
    queue: 'local-agent-task',
    jobId: snapshot.jobId,
    position: 0,
    estimatedWaitMs: 0,
  };
  streamState = reduceAgentState(streamState, queueEvent);
  appendTaskEvent(snapshot, queueEvent, streamState);
  const policyEvent = { type: 'document_policy', policy: documentPolicy };
  streamState = reduceAgentState(streamState, policyEvent);
  appendTaskEvent(snapshot, policyEvent, streamState);

  await agentTaskPersistence.upsertAgentTask({
    ...snapshot,
    status: 'running',
    jobId: snapshot.jobId,
    queueName: snapshot.queueName,
    traceId,
    documentPolicy,
    state: streamState,
  }).catch(() => null);

  auditLog.audit({
    event: 'agent_task_local_fallback_started',
    taskId,
    userId: req.user?.id || null,
    chatId,
    model,
    traceId,
    fallbackReason,
    fallbackDetail,
    fileCount: fileIds.length,
  });
  metrics.counter('agent_task_invocations_total', { status: 'local_fallback' });

  const payload = {
    taskId,
    traceId,
    user: { id: req.user?.id, email: req.user?.email },
    goal: agentGoal,
    displayGoal,
    systemContract,
    files: fileIds,
    fileMetadata: clientFileMetadata,
    chatId,
    model,
    maxSteps,
    maxRuntimeMs,
    documentPolicy,
  };

  Promise.resolve().then(async () => {
    try {
      const { runAgentTaskJob } = require('../services/agents/agent-task-runner');
      await runAgentTaskJob(payload, {
        id: snapshot.jobId,
        updateProgress: async () => {},
      });
    } catch (err) {
      const latest = taskStore.getTaskSnapshotForUser(taskId, req.user?.id) || snapshot;
      if (['completed', 'cancelled', 'error'].includes(latest.status)) return;
      const errorEvent = { type: 'error', message: err?.message || 'agent task failed' };
      const state = reduceAgentState(latest.streamState || streamState, errorEvent);
      appendTaskEvent({ ...latest, events: latest.events || [] }, errorEvent, state);
      taskStore.markTaskStatus({ ...latest, userId: req.user?.id }, 'error', {
        streamState: state,
        stats: { error: errorEvent.message },
      });
    }
  });

  return streamTaskEvents(req, res, taskId, req.user?.id);
}

/**
 * failTaskTerminal — write a terminal `error` event + mark the snapshot
 * status 'error' for a task, UNLESS it already reached a terminal state.
 * The BullMQ worker's `failed` handler calls this so a permanently-failed
 * job surfaces a real reason to the SSE client immediately, instead of
 * leaving the stream hanging until the response timeout (which the client
 * then renders as the opaque `stream_closed_without_done`). Idempotent;
 * never throws.
 */
function failTaskTerminal(taskId, userId, message) {
  try {
    if (!taskId) return false;
    const latest = taskStore.getTaskSnapshotForUser(taskId, userId)
      || taskStore.getTaskSnapshotForUser(taskId, undefined);
    if (!latest) return false;
    if (['completed', 'cancelled', 'error'].includes(latest.status)) return false;
    const errorEvent = { type: 'error', message: String(message || 'La tarea agéntica falló.') };
    const state = reduceAgentState(latest.streamState || initialAgentState(), errorEvent);
    appendTaskEvent({ ...latest, events: latest.events || [] }, errorEvent, state);
    taskStore.markTaskStatus({ ...latest, userId: latest.userId || userId }, 'error', {
      streamState: state,
      stats: { error: errorEvent.message },
    });
    return true;
  } catch (_) {
    return false;
  }
}

function streamTaskEvents(req, res, taskId, userId) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // ── SSE hardening (mirrors inline path) ────────────────────────────
  let clientConnected = true;
  let lastSeq = 0;
  let pollTimer = null;
  let heartbeatTimer = null;
  // Whether the client has already received a terminal (`done`/`error`)
  // frame. The frontend marks the run finished only on such a frame; a
  // bare socket close with no terminal surfaces as the opaque
  // `stream_closed_without_done`. We guarantee a terminal on every close
  // path (timeout, worker stall, abnormal socket error) below.
  let terminalEmitted = false;

  /** Safe SSE write — never throws. */
  const send = (obj) => {
    if (!clientConnected || res.writableEnded || res.destroyed) return false;
    try {
      const serialized = safeJsonStringify(obj);
      const t = obj && obj.type;
      if (t === 'done' || t === 'error') terminalEmitted = true;
      return res.write(`data: ${serialized}\n\n`) !== false;
    } catch {
      safeCloseQueuedConnection();
      return false;
    }
  };

  function safeCloseQueuedConnection(reason) {
    // Guarantee a terminal frame before the socket closes. Without this a
    // timeout / stalled worker / abnormal close ends the stream with no
    // done|error event and the UI shows `stream_closed_without_done`.
    if (!terminalEmitted && clientConnected && !res.writableEnded && !res.destroyed) {
      terminalEmitted = true;
      try {
        res.write(`data: ${safeJsonStringify({
          type: 'error',
          message: reason || 'La tarea agéntica se cerró sin completar. Intenta de nuevo.',
        })}\n\n`);
      } catch { /* socket already gone */ }
    }
    clientConnected = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (!res.writableEnded && !res.destroyed) {
      try { res.end(); } catch { /* already closed */ }
    }
  }

  // Error / close handlers
  res.on('error', () => { safeCloseQueuedConnection(); });
  res.on('drain', () => { /* no-op, reserved for backpressure tracking */ });
  req.on('close', () => { safeCloseQueuedConnection(); });

  // Response timeout (5 min default, configurable via env)
  const TIMEOUT = Math.max(30_000, Number.parseInt(process.env.AGENT_RESPONSE_TIMEOUT_MS || '300000', 10));
  res.setTimeout(TIMEOUT, () => {
    safeCloseQueuedConnection('La tarea agéntica no respondió a tiempo (timeout). El runtime puede estar saturado; intenta de nuevo.');
    console.warn('[agent-task] queued SSE response timeout');
  });

  const flush = () => {
    if (!clientConnected) return;
    const snapshot = getTaskForUser(taskId, userId) || taskStore.getTaskSnapshotForUser(taskId, userId);
    if (!snapshot) {
      send({ type: 'error', message: 'Tarea no encontrada.' });
      safeCloseQueuedConnection();
      return;
    }
    for (const event of snapshot.events || []) {
      const seq = Number(event.seq) || 0;
      if (seq <= lastSeq) continue;
      lastSeq = seq;
      send(event);
    }
    if (['completed', 'cancelled', 'error'].includes(snapshot.status)) {
      safeCloseQueuedConnection();
    }
  };

  pollTimer = setInterval(flush, 450);
  heartbeatTimer = setInterval(() => {
    if (!clientConnected || res.writableEnded || res.destroyed) return;
    try { res.write(': keep-alive\n\n'); } catch { safeCloseQueuedConnection(); }
  }, 25000);

  // Don't keep the process alive just for SSE polling
  if (typeof pollTimer.unref === 'function') pollTimer.unref();
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

  flush();
}

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

function isTranscriptionRequest(text) {
  return /\b(transcrib(?:e|ir|eme|irme|iendo|irlo|irla|elo|ela)?|transcripci[oó]n|transcripcion|transcribe|transcript|transcription)\b/i
    .test(String(text || ''));
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
  enterpriseRuntimeProfile = null,
  enterpriseToolRuntimePlan = null,
  enterpriseQaBoardReview = null,
  agenticOperatingCore = null,
  uploadedFileContext = ''
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
  if (agenticOperatingCore) {
    parts.push(buildAgenticOperatingPrompt(agenticOperatingCore));
  }
  if (enterpriseToolRuntimePlan) {
    parts.push(
      'Enterprise Tool Runtime authorization summary (do not reveal to user):\n' +
      JSON.stringify(enterpriseToolRuntimePlan.summary || enterpriseToolRuntimePlan, null, 2)
    );
  }
  if (enterpriseQaBoardReview) {
    parts.push(
      'Agentic QA Board preflight summary (do not reveal to user):\n' +
      JSON.stringify(enterpriseQaBoardReview.summary || enterpriseQaBoardReview, null, 2)
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
    parts.push(`Uploaded/reference file ids available to tools: ${fileIds.join(', ')}. If the user asks about their content, call rag_retrieve before answering. If the user asks to transcribe, produce the exact readable text from the uploaded/pasted content; do not create a document unless the prompt explicitly requests Word/PDF/PPT/Excel.`);
  }
  if (uploadedFileContext) {
    parts.push(uploadedFileContext);
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
  enterpriseToolRuntimePlan = null,
  enterpriseQaBoardReview = null,
  agenticOperatingCore = null,
  durableExecution = null,
  jobId = null,
  queueName = null,
  traceId = null,
  documentPolicy = null,
  status = 'running',
}) {
  pruneOldTasks();
  const now = new Date().toISOString();
  const existingSnapshot = taskStore.getTaskSnapshotForUser(taskId, userId);
  const record = {
    taskId,
    userId: String(userId || ''),
    chatId,
    displayGoal,
    model,
    controller,
    maxSteps,
    maxRuntimeMs,
    status,
    jobId,
    queueName,
    traceId,
    documentPolicy,
    agentGoal: existingSnapshot?.agentGoal || displayGoal,
    systemContract: existingSnapshot?.systemContract || '',
    fileIds: existingSnapshot?.fileIds || [],
    createdAt: now,
    updatedAt: now,
    streamState: streamState || existingSnapshot?.streamState || initialAgentState(),
    executionProfile,
    intentAlignmentProfile,
    taskPlan,
    universalTaskContract,
    enterpriseExecutionGraph,
    enterpriseRuntimeProfile,
    enterpriseToolRuntimePlan,
    enterpriseQaBoardReview,
    agenticOperatingCore,
    durableExecution: durableExecution
      ? {
        graphId: durableExecution.graphId,
        status: durableExecution.status,
        checkpointCount: durableExecution.checkpoints?.length || 0,
      }
      : null,
    events: existingSnapshot?.events || [],
    checkpoints: existingSnapshot?.checkpoints || [],
    lastEventSeq: existingSnapshot?.lastEventSeq || 0,
    assistantMessageId: existingSnapshot?.assistantMessageId || null,
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
  const lastSeq = Number(task.lastEventSeq || 0) || Math.max(0, ...task.events.map((evt) => Number(evt.seq) || 0));
  const seq = Number(event.seq) || lastSeq + 1;
  task.lastEventSeq = seq;
  task.events.push({ ...event, id: event.id || `${task.taskId}:${seq}`, seq, ts: new Date().toISOString() });
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
  if (task.durableExecution?.graphId) {
    try {
      durableExecutionStore.appendExecutionEvent(task.durableExecution.graphId, task.userId, {
        type: `agent_task_${event.type || 'event'}`,
        taskId: task.taskId,
        status: task.status,
        eventType: event.type || 'unknown',
      });
    } catch (err) {
      console.warn('[agent-task] durable graph event write failed:', err.message);
    }
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
    agentGoal: task.agentGoal || null,
    fileIds: task.fileIds || [],
    model: task.model,
    chatId: task.chatId || null,
    assistantMessageId: task.assistantMessageId || null,
    jobId: task.jobId || null,
    queue: task.queueName || null,
    traceId: task.traceId || null,
    documentPolicy: task.documentPolicy || task.streamState?.documentPolicy || null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt || null,
    cancelledAt: task.cancelledAt || null,
    failedAt: task.failedAt || null,
    streamState: task.streamState,
    events: task.events || [],
    artifacts: task.artifacts || task.streamState?.artifacts || [],
    executionProfile: task.executionProfile || null,
    intentAlignmentProfile: task.intentAlignmentProfile || null,
    taskPlan: task.taskPlan || null,
    universalTaskContract: task.universalTaskContract || null,
    enterpriseExecutionGraph: task.enterpriseExecutionGraph || null,
    enterpriseRuntimeProfile: task.enterpriseRuntimeProfile || null,
    enterpriseToolRuntimePlan: task.enterpriseToolRuntimePlan || null,
    enterpriseQaBoardReview: task.enterpriseQaBoardReview || null,
    agenticOperatingCore: task.agenticOperatingCore || null,
    durableExecution: task.durableExecution || null,
    stats: task.stats || null,
    checkpoints: task.checkpoints || [],
  };
}

function initialAgentState() {
  return {
    steps: [],
    artifacts: [],
    finalText: '',
    done: false,
    checkpoints: [],
    qualityGates: [],
    repairs: [],
    frameworks: null,
    observability: null,
    approvals: [],
    documentAnalysisIds: [],
    evidenceRefs: [],
  };
}

function reduceAgentState(state, evt) {
  switch (evt.type) {
    case 'queue_status':
      return { ...state, queue: { status: evt.status, queue: evt.queue, jobId: evt.jobId, position: evt.position ?? null, estimatedWaitMs: evt.estimatedWaitMs ?? null, updatedAt: evt.ts || new Date().toISOString() } };
    case 'document_policy':
      return { ...state, documentPolicy: evt.policy || evt.documentPolicy || null };
    case 'document_analysis':
      return {
        ...state,
        documentAnalysisIds: Array.from(new Set([
          ...(state.documentAnalysisIds || []),
          ...((evt.analysisIds || []).map(String).filter(Boolean)),
        ])).slice(-20),
        evidenceRefs: [
          ...(state.evidenceRefs || []),
          ...((evt.evidenceRefs || []).filter(Boolean)),
        ].slice(-40),
      };
    case 'framework_status':
      return {
        ...state,
        frameworks: evt.frameworks ? { active: evt.active, frameworks: evt.frameworks, version: evt.version } : evt,
        observability: evt.observability || state.observability || null,
      };
    case 'human_approval_required':
      return {
        ...state,
        approvals: [...(state.approvals || []), {
          id: evt.approvalId || `approval-${(state.approvals || []).length + 1}`,
          status: 'pending',
          tool: evt.tool || null,
          action: evt.action || null,
          reason: evt.reason || '',
          payload: evt.payload || null,
          ts: evt.ts || new Date().toISOString(),
        }].slice(-20),
      };
    case 'human_approval_resolved': {
      const approvalId = evt.approvalId || `approval-${(state.approvals || []).length + 1}`;
      const approvals = state.approvals || [];
      const found = approvals.some((approval) => approval.id === approvalId);
      const resolved = {
        id: approvalId,
        status: evt.decision || 'resolved',
        decision: evt.decision,
        payload: evt.payload || null,
        resolvedBy: evt.resolvedBy || null,
        ts: evt.ts || new Date().toISOString(),
      };
      return {
        ...state,
        approvals: found
          ? approvals.map((approval) => approval.id === approvalId ? { ...approval, ...resolved } : approval)
          : [...approvals, resolved].slice(-20),
      };
    }
    case 'checkpoint':
      return {
        ...state,
        checkpoints: [...(state.checkpoints || []), {
          id: evt.id || `checkpoint-${(state.checkpoints || []).length + 1}`,
          label: evt.label || evt.message || 'Checkpoint',
          status: evt.status || 'saved',
          ts: evt.ts || new Date().toISOString(),
        }].slice(-20),
      };
    case 'quality_gate':
      return {
        ...state,
        qualityGates: [...(state.qualityGates || []), {
          id: evt.id || `quality-${(state.qualityGates || []).length + 1}`,
          label: evt.label || evt.gate || 'Validación',
          passed: Boolean(evt.passed),
          score: evt.score ?? evt.overallScore ?? null,
          summary: evt.summary || evt.message || '',
          ts: evt.ts || new Date().toISOString(),
        }].slice(-20),
      };
    case 'repair_attempt':
      return {
        ...state,
        repairs: [...(state.repairs || []), {
          attempt: evt.attempt || (state.repairs || []).length + 1,
          status: evt.status || 'running',
          message: evt.message || 'Reparación automática',
          ts: evt.ts || new Date().toISOString(),
        }].slice(-10),
      };
    case 'meta':
      return {
        ...state,
        meta: {
          taskId: evt.taskId,
          goal: evt.goal,
          model: evt.model,
          runtimeModel: evt.runtimeModel,
          runtimeProvider: evt.runtimeProvider,
          tools: evt.tools,
        },
      };
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
            ? { ...step, toolCalls: [...step.toolCalls, { tool: evt.tool }] }
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
          toolCalls: [{ tool: evt.tool }],
        }];
      return {
        ...state,
        steps: steps.map(step => {
          if (step.id !== stepId) return step;
          const toolCalls = [...step.toolCalls];
          let attached = false;
          for (let i = toolCalls.length - 1; i >= 0; i--) {
            if (toolCalls[i].tool === evt.tool && !toolCalls[i].output) {
              toolCalls[i] = { ...toolCalls[i], output: { ok: evt.ok } };
              attached = true;
              break;
            }
          }
          if (!attached) {
            toolCalls.push({ tool: evt.tool, output: { ok: evt.ok } });
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
  const publicState = toSerializableAgentState(state);
  const fenced = '```agent-task-state\n' + JSON.stringify(publicState) + '\n```';
  return publicState.finalText ? `${fenced}\n\n${publicState.finalText}` : fenced;
}

function toSerializableAgentState(state = {}) {
  return {
    steps: (state.steps || []).map((step) => ({
      id: step.id,
      label: step.label,
      icon: step.icon,
      status: step.status,
      toolCalls: (step.toolCalls || []).map((call) => ({
        tool: call.tool,
        output: call.output ? { ok: call.output.ok } : undefined,
      })),
    })),
    artifacts: state.artifacts || [],
    finalText: state.finalText || '',
    done: Boolean(state.done),
    error: state.error || undefined,
    stoppedReason: state.stoppedReason || undefined,
    checkpoints: (state.checkpoints || []).map((checkpoint) => ({
      id: checkpoint.id,
      label: checkpoint.label,
      status: checkpoint.status,
      ts: checkpoint.ts,
    })),
    qualityGates: (state.qualityGates || []).map((gate) => ({
      id: gate.id,
      label: gate.label,
      passed: gate.passed,
      score: gate.score,
      summary: gate.summary,
      ts: gate.ts,
    })),
    repairs: state.repairs || [],
    approvals: (state.approvals || []).map((approval) => ({
      id: approval.id,
      status: approval.status,
      tool: approval.tool,
      action: approval.action,
      reason: approval.reason,
      decision: approval.decision,
      ts: approval.ts,
    })),
    queue: state.queue || undefined,
    documentPolicy: state.documentPolicy || undefined,
    documentAnalysisIds: state.documentAnalysisIds || undefined,
    evidenceRefs: state.evidenceRefs || undefined,
    meta: state.meta
      ? {
        taskId: state.meta.taskId,
        goal: state.meta.goal,
        model: state.meta.model,
        runtimeModel: state.meta.runtimeModel,
        runtimeProvider: state.meta.runtimeProvider,
        tools: state.meta.tools,
      }
      : undefined,
  };
}

router.INTERNAL = {
  ACTIVE_AGENT_TASKS,
  TASK_EVENT_LIMIT,
  appendTaskEvent,
  buildAgentSystemPrompt,
  createTaskRecord,
  extractProfessionalContract,
  failTaskTerminal,
  formatTaskPayload,
  getTaskForUser,
  inferIconFor,
  initialAgentState,
  normalizeDisplayGoal,
  normalizeSystemContract,
  reduceAgentState,
  shortLabel,
  serializeAgentState,
  toSerializableAgentState,
};

module.exports = router;
