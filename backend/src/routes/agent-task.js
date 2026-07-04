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

const objectStorage = require('../services/object-storage');
const { authenticateToken } = require('../middleware/auth');
const { enforcePlanQuota } = require('../middleware/enforce-plan-quota');
const { resolveRateLimitConfig, makeJwtAwareKeyGenerator, extractBearerToken } = require('../middleware/rate-limit-policy');
const reactAgent = require('../services/react-agent');
const { buildTaskTools, ARTIFACT_DIR } = require('../services/agents/task-tools');
const taskStore = require('../services/agents/task-store');
const auditLog = require('../services/agents/audit-log');
const metrics = require('../services/agents/metrics');
const openclawCapabilityKernel = require('../services/openclaw-capability-kernel');
const {
  buildExecutionProfile,
  buildExecutionProfilePrompt,
} = require('../services/agents/agentic-execution-profile');
const {
  validateAgentTaskFinalize,
} = require('../services/agents/openclaw-autonomy-finalize-guard');
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
const { buildForbiddenToolNames } = require('../services/agents/agent-tool-policy');
const durableExecutionStore = require('../services/agents/durable-execution-store');
const { buildDocumentDeliveryPolicy } = require('../services/agents/document-delivery-policy');
const documentAnalysisQuality = require('../services/document-analysis-quality');
const { buildLangGraphLayer } = require('../services/agents/agentic-langgraph');
const { buildAgenticFrameworkStatus } = require('../services/agents/agentic-frameworks');
const { buildIntegrationRuntimeProfile } = require('../services/ai-product-os/integration-runtime-profile');
const {
  cancelQueuedTask,
  enqueueAgentTask,
  getQueueName,
  requireRedisUrl,
} = require('../services/agents/agent-task-queue');
const { cancelRunningTask } = require('../services/agents/agent-task-worker');
const { resolveAttachmentFallbackMarkdown } = require('../services/agents/agent-task-runner');
const agentTaskPersistence = require('../services/agents/agent-task-persistence');
const {
  buildUploadedFileContext,
  looksLikeDocumentFollowupQuestion,
  normalizeClientMetadata,
  resolveChatDocumentFileIds,
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
// Important: never truncate the final JSON string with slice(). SSE
// consumers JSON.parse every `data:` frame; cutting the serialized text
// creates invalid JSON and kills long document-analysis streams before
// `final_text` / `done` can arrive.
function compactJsonValue(value, {
  depth = 0,
  maxDepth = 5,
  maxString = 8000,
  maxArray = 40,
  seen = new WeakSet(),
} = {}) {
  if (value === undefined) return null;
  if (typeof value === 'bigint') return `BigInt(${value.toString()})`;
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'string') {
    return value.length > maxString
      ? `${value.slice(0, Math.max(0, maxString - 24))}...[truncated ${value.length - maxString + 24} chars]`
      : value;
  }
  if (value instanceof Error) {
    return {
      message: compactJsonValue(value.message, { depth: depth + 1, maxDepth, maxString, maxArray, seen }),
      stack: compactJsonValue(value.stack, { depth: depth + 1, maxDepth, maxString, maxArray, seen }),
    };
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  if (depth >= maxDepth) return '[Truncated depth]';
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value
      .slice(0, maxArray)
      .map((item) => compactJsonValue(item, { depth: depth + 1, maxDepth, maxString, maxArray, seen }));
    if (value.length > maxArray) out.push(`[Truncated ${value.length - maxArray} items]`);
    return out;
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    const childMaxString = key === 'markdown' || key === 'finalText' ? Math.max(maxString, 24000) : maxString;
    out[key] = compactJsonValue(child, {
      depth: depth + 1,
      maxDepth,
      maxString: childMaxString,
      maxArray,
      seen,
    });
  }
  return out;
}

function sliceWithCount(value, limit = 24, preserve = []) {
  if (!Array.isArray(value)) return value;
  const preserveSet = new Set((preserve || []).filter((item) => value.includes(item)));
  const preserved = Array.from(preserveSet);
  const headLimit = Math.max(0, limit - preserved.length);
  const out = [];
  for (const item of value) {
    if (preserveSet.has(item)) continue;
    if (out.length >= headLimit) break;
    out.push(item);
  }
  for (const item of preserved) {
    if (!out.includes(item) && out.length < limit) out.push(item);
  }
  if (value.length > out.length) out.push(`[Truncated ${value.length - out.length} items]`);
  return out;
}

function stringifyWithinSseLimit(payload, maxLen, original = payload) {
  const serialized = JSON.stringify(payload);
  if (!Number.isFinite(maxLen) || serialized.length <= maxLen) return serialized;

  const compact = compactJsonValue(payload, {
    maxString: Math.max(160, Math.floor(maxLen / 8)),
    maxArray: 8,
    maxDepth: 4,
  });
  const compactSerialized = JSON.stringify(compact);
  if (compactSerialized.length <= maxLen) return compactSerialized;

  const messageLimit = Math.max(60, Math.min(600, maxLen - 320));
  const minimal = {
    type: (original && original.type) || payload?.type || 'event',
    taskId: (original && original.taskId) || payload?.taskId || undefined,
    seq: (original && original.seq) || payload?.seq || undefined,
    label: original?.label ? String(original.label).slice(0, 160) : undefined,
    status: original?.status || undefined,
    message: original?.message ? String(original.message).slice(0, messageLimit) : undefined,
    _truncated: true,
    _compaction: payload?._compaction || 'sse_hard_limit',
  };
  const minimalSerialized = JSON.stringify(minimal);
  if (minimalSerialized.length <= maxLen) return minimalSerialized;

  return JSON.stringify({
    type: minimal.type || 'event',
    taskId: minimal.taskId,
    _truncated: true,
    _compaction: 'sse_minimal',
  });
}

function compactEventForSse(obj, maxLen) {
  if (obj?.type === 'meta') {
    const cognitive = obj.agenticOperatingCore?.cognitive_improvements || null;
    const executionCognitive = obj.executionProfile?.cognitiveImprovements || null;
    return stringifyWithinSseLimit({
      type: 'meta',
      taskId: obj.taskId || undefined,
      goal: obj.goal ? String(obj.goal).slice(0, 1200) : undefined,
      model: obj.model || undefined,
      executionProfile: obj.executionProfile ? {
        version: obj.executionProfile.version,
        capabilities: obj.executionProfile.capabilities,
        requiredTools: sliceWithCount(obj.executionProfile.requiredTools, 24),
        cognitiveImprovements: executionCognitive ? {
          version: executionCognitive.version,
          mode: executionCognitive.mode,
          summary: executionCognitive.summary,
          active_categories: sliceWithCount(executionCognitive.active_categories, 16),
        } : null,
        universalAgents: obj.executionProfile.universalAgents ? {
          version: obj.executionProfile.universalAgents.version,
          mode: obj.executionProfile.universalAgents.mode,
          summary: obj.executionProfile.universalAgents.summary,
          active_families: sliceWithCount(obj.executionProfile.universalAgents.active_families, 20),
          active_team_ids: sliceWithCount(
            (obj.executionProfile.universalAgents.active_team || []).map((agent) => agent.id),
            24
          ),
        } : null,
      } : undefined,
      enterpriseRuntimeProfile: obj.enterpriseRuntimeProfile ? {
        agenticOperatingCore: obj.enterpriseRuntimeProfile.agenticOperatingCore,
        toolRuntime: obj.enterpriseRuntimeProfile.toolRuntime,
        qaPreflight: obj.enterpriseRuntimeProfile.qaPreflight,
        durableExecution: obj.enterpriseRuntimeProfile.durableExecution,
      } : undefined,
      agenticOperatingCore: obj.agenticOperatingCore ? {
        version: obj.agenticOperatingCore.version,
        core_id: obj.agenticOperatingCore.core_id,
        trace_id: obj.agenticOperatingCore.trace_id,
        summary: obj.agenticOperatingCore.summary,
        cognitive_improvements: cognitive ? {
          version: cognitive.version,
          mode: cognitive.mode,
          summary: cognitive.summary,
          active_categories: sliceWithCount(cognitive.active_categories, 16),
        } : null,
        universal_agents: obj.agenticOperatingCore.universal_agents ? {
          version: obj.agenticOperatingCore.universal_agents.version,
          mode: obj.agenticOperatingCore.universal_agents.mode,
          summary: obj.agenticOperatingCore.universal_agents.summary,
          active_families: sliceWithCount(obj.agenticOperatingCore.universal_agents.active_families, 20),
          active_team_ids: sliceWithCount(
            (obj.agenticOperatingCore.universal_agents.active_team || []).map((agent) => agent.id),
            24
          ),
          cycle: (obj.agenticOperatingCore.universal_agents.cycle || []).map((phase) => ({
            phase: phase.phase,
            order: phase.order,
            gate: phase.gate,
            assigned_agent_ids: sliceWithCount(phase.assigned_agents, 4),
          })),
        } : null,
        validation: obj.agenticOperatingCore.validation ? {
          reports_required: sliceWithCount(obj.agenticOperatingCore.validation.reports_required, 24),
          deterministic_checks: sliceWithCount(obj.agenticOperatingCore.validation.deterministic_checks, 40, [
            'cognitive.e2e-user-journey-probe',
            'cognitive.stream-terminal-event-probe',
            'cognitive.api-contract-probe',
            'universal_agents.catalog_1000',
            'universal_agents.all_cycle_phases_covered',
            'universal_agents.release_not_before_validation',
          ]),
          qa_board_decision: obj.agenticOperatingCore.validation.qa_board_decision,
        } : undefined,
        observability: obj.agenticOperatingCore.observability ? {
          trace_id: obj.agenticOperatingCore.observability.trace_id,
          events: sliceWithCount(obj.agenticOperatingCore.observability.events, 24),
          metrics: sliceWithCount(obj.agenticOperatingCore.observability.metrics, 40),
        } : undefined,
      } : undefined,
      _truncated: true,
      _compaction: 'meta_control_plane_summary',
    }, maxLen, obj);
  }
  const compact = compactJsonValue(obj, {
    maxString: Math.max(1200, Math.floor(maxLen / 4)),
    maxArray: 24,
  });
  const str = JSON.stringify(compact);
  if (str.length <= maxLen) return str;
  return stringifyWithinSseLimit({
    type: obj && obj.type ? obj.type : 'event',
    taskId: obj && obj.taskId ? obj.taskId : undefined,
    seq: obj && obj.seq ? obj.seq : undefined,
    label: obj && obj.label ? String(obj.label).slice(0, 240) : undefined,
    status: obj && obj.status ? obj.status : undefined,
    message: obj && obj.message ? String(obj.message).slice(0, 1200) : undefined,
    _truncated: true,
  }, maxLen, obj);
}

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
    return str.length > maxLen ? compactEventForSse(obj, maxLen) : str;
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
- META-DOCUMENT TASKS: requests that apply TO an attached document are valid even when the answer is not literally written inside it. "cita en Vancouver/APA/MLA/Harvard/IEEE/ISO 690", "referencia bibliográfica", "cítame este documento/artículo/PDF" mean: BUILD the bibliographic reference of the attached document in that citation style from its own bibliographic data (title, authors, year, journal/institution, volume/pages, DOI/URL) found via docintel_retrieve/rag_retrieve on the FIRST pages; mark any missing field as [no disponible]. With an academic document attached, "cita" ALWAYS means citation/reference — never a calendar appointment. NEVER answer that the material lacks information for these meta-tasks; produce the best reference the document's own data allows.
- When the user asks for a file (Excel, Word, PPT, PDF, SVG, CSV, Markdown), use create_document. The deliverable must be authored by executable code, not placeholder prose: write a complete Python script that builds the real content, visual hierarchy, tables/slides/sections and writes to os.environ["OUT_PATH"]. Prefer openpyxl / python-docx / python-pptx / reportlab. Do not finalize with only text when the user asked to create/download/export/convert a file.
- When the user uploads a Word/Excel/PowerPoint/PDF and asks to modify, improve, correct, apply corrections, add/remove content, fill, translate, summarize into, complete, format, convert, or continue "in my own file", treat the upload as a read-only source. Never overwrite or mutate the original. Create a new artifact in the same format unless the user explicitly asks for another format. Preserve logos/images, tables, formulas, sheet names, headers, footers, slide layouts, styling, and document order as far as the available libraries allow; change only what the user requested. Consolidate multiple requested edits into one edited output file unless the user asks for multiple files, and never finalize with only suggested edits when the requested outcome is an edited attachment.
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

// ─── GET /api/agent/artifacts — galería "Mis documentos" ────────────────
// Lista los documentos generados del usuario (DOCX/XLSX/PPTX/PDF…), más
// recientes primero. Alimenta la página /documents (estilo Cowork): ver,
// descargar y volver al chat de origen.
router.get('/artifacts', authenticateToken, async (req, res) => {
  try {
    if (!prisma?.generatedArtifact?.findMany) {
      return res.json({ ok: true, artifacts: [], total: 0 });
    }
    const limit = Math.max(1, Math.min(100, Number.parseInt(String(req.query.limit || '60'), 10) || 60));
    const offset = Math.max(0, Number.parseInt(String(req.query.offset || '0'), 10) || 0);
    const where = { userId: req.user.id };
    const [rows, total] = await Promise.all([
      prisma.generatedArtifact.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true,
          filename: true,
          format: true,
          mime: true,
          sizeBytes: true,
          createdAt: true,
          chatId: true,
        },
      }),
      prisma.generatedArtifact.count({ where }),
    ]);
    res.json({
      ok: true,
      total,
      artifacts: rows.map((row) => ({
        ...row,
        downloadUrl: `/api/agent/artifact/${row.id}?name=${encodeURIComponent(row.filename || 'documento')}`,
      })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'artifact list failed' });
  }
});

// ─── GET /api/agent/artifact/:id ────────────────────────────────────────

// ─── GET /api/agent/artifact/:id/preview.pdf ───────────────────────────────
// High-fidelity preview: convert the office artifact to PDF with LibreOffice
// headless (cached by id+mtime) and stream it inline. The frontend renders
// it in a real PDF viewer instead of hand-rolled HTML tables. Same auth +
// ownership contract as the download route. 409 → caller falls back to the
// legacy client-side renderer (e.g. artifact offloaded to R2 or soffice
// missing) — this endpoint must never break the download path.
router.get('/artifact/:id/preview.pdf', authenticateToken, async (req, res) => {
  const id = String(req.params.id || '').replace(/[^a-f0-9]/gi, '');
  if (!id || id.length > 40) return res.status(400).json({ error: 'bad id' });
  if (!fs.existsSync(ARTIFACT_DIR)) return res.status(404).json({ error: 'no artifacts yet' });

  const metadata = readArtifactMetadata(id);
  let full = null;
  if (metadata?.storedRelPath) {
    const root = path.resolve(ARTIFACT_DIR);
    const candidate = path.resolve(ARTIFACT_DIR, metadata.storedRelPath);
    if ((candidate === root || candidate.startsWith(root + path.sep)) && fs.existsSync(candidate)) {
      full = candidate;
    }
  }
  if (!full) {
    let entry = null;
    try {
      entry = fs.readdirSync(ARTIFACT_DIR).find(f => f.startsWith(`${id}-`));
    } catch { entry = null; }
    if (entry) full = path.join(ARTIFACT_DIR, entry);
  }
  if (!full || !fs.existsSync(full)) {
    // Offloaded-to-R2 or missing binary: no local bytes to convert.
    return res.status(409).json({ error: 'preview unavailable' });
  }
  if (!metadata?.ownerUserId) return res.status(403).json({ error: 'artifact ownership metadata missing' });
  if (String(metadata.ownerUserId) !== String(req.user?.id)) return res.status(403).json({ error: 'artifact not found' });

  try {
    const { getOrCreatePdfPreview } = require('../services/document-pipeline/preview-pdf-service');
    const pdfPath = await getOrCreatePdfPreview({ sourcePath: full, cacheKey: id });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="preview.pdf"');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return fs.createReadStream(pdfPath).pipe(res);
  } catch (err) {
    // Not previewable / too large / soffice down → the client falls back.
    return res.status(409).json({ error: 'preview unavailable', reason: String(err?.message || '').slice(0, 120) });
  }
});

router.get('/artifact/:id', authenticateToken, async (req, res) => {
  const id = String(req.params.id || '').replace(/[^a-f0-9]/gi, '');
  if (!id || id.length > 40) return res.status(400).json({ error: 'bad id' });

  // Metadata is the source of truth; the binary may live locally (dev / not
  // yet offloaded) or only in R2 (after offload). The metadata JSON stays on
  // disk in ARTIFACT_DIR, so a missing dir means there are genuinely no
  // artifacts.
  if (!fs.existsSync(ARTIFACT_DIR)) return res.status(404).json({ error: 'no artifacts yet' });

  const metadata = readArtifactMetadata(id);

  // Resolve the on-disk path. Cycle artifacts are grouped under
  // ARTIFACT_DIR/<folderCode>/ and record `storedRelPath` in their flat
  // metadata; legacy artifacts live at the top level under `<id>-<name>`.
  let full = null;
  let entry = null;
  if (metadata?.storedRelPath) {
    const root = path.resolve(ARTIFACT_DIR);
    const candidate = path.resolve(ARTIFACT_DIR, metadata.storedRelPath);
    // Traversal guard: the resolved path must stay inside ARTIFACT_DIR.
    if ((candidate === root || candidate.startsWith(root + path.sep)) && fs.existsSync(candidate)) {
      full = candidate;
      entry = path.basename(candidate);
    }
  }
  if (!full) {
    // Legacy / fallback: find the file by stored-name prefix at top level.
    try {
      entry = fs.readdirSync(ARTIFACT_DIR).find(f => f.startsWith(`${id}-`));
    } catch { entry = null; }
    if (entry) full = path.join(ARTIFACT_DIR, entry);
  }

  // The binary may have been offloaded to R2 (local copy removed). When there
  // is no usable local file, fall back to streaming from R2 using the
  // metadata's storageRef. Ownership is still enforced from metadata.
  const hasLocal = Boolean(full && entry && fs.existsSync(full));
  if (!hasLocal && !(metadata && metadata.storageRef)) {
    return res.status(404).json({ error: 'artifact not found' });
  }

  if (!metadata?.ownerUserId) {
    return res.status(403).json({ error: 'artifact ownership metadata missing' });
  }
  if (String(metadata.ownerUserId) !== String(req.user?.id)) {
    return res.status(403).json({ error: 'artifact not found' });
  }

  const fallbackName = entry ? entry.slice(id.length + 1) : (metadata.filename || 'artifact');
  const userSuppliedName = typeof req.query.name === 'string' ? req.query.name : fallbackName;
  const safeName = userSuppliedName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'artifact';
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);

  if (hasLocal) {
    return res.sendFile(full);
  }

  // Stream from R2.
  try {
    if (metadata.mime) res.setHeader('Content-Type', metadata.mime);
    const meta = await objectStorage.stat(metadata.storageRef);
    if (meta && meta.size != null) res.setHeader('Content-Length', meta.size);
    const { stream } = await objectStorage.readStream(metadata.storageRef);
    stream.on('error', (err) => {
      console.error(`[agent-task] R2 artifact stream error for ${id}: ${err && err.message}`);
      if (!res.headersSent) res.status(502).json({ error: 'artifact stream failed' });
      else res.destroy();
    });
    return stream.pipe(res);
  } catch (err) {
    console.error(`[agent-task] R2 artifact fetch failed for ${id}: ${err && err.message}`);
    return res.status(404).json({ error: 'artifact not found' });
  }
});

// ─── POST /api/agent/document-cycle/classify ───────────────────────────
// Preview classification (document/study type + field/career), the resolved
// guide outline, and the override option lists. Used by the UI before the
// user approves and starts the cycle. Read-only — does not enqueue anything.
router.post('/document-cycle/classify', authenticateToken, (req, res) => {
  const cycleService = require('../services/agents/professional-document-cycle');
  const topic = String(req.body?.topic || '').trim();
  if (!topic) return res.status(400).json({ error: 'topic is required' });
  try {
    const classification = cycleService.classifyDocument({
      topic,
      documentTypeOverride: req.body?.documentType,
      fieldOverride: req.body?.field,
    });
    const guide = cycleService.getGuide(classification.documentType.id, classification.field.id);
    return res.json({
      ok: true,
      classification,
      guide,
      stages: cycleService.CYCLE_STAGES,
      options: cycleService.listOptions(),
    });
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'classification failed' });
  }
});

// ─── POST /api/agent/document-cycle ────────────────────────────────────
// Start the professional document cycle: classify the approved topic, build
// the staged agent contract, and run it through the existing queued task
// pipeline (SSE stream). Requires `topic` and a folder `code`.
router.post(
  '/document-cycle',
  // Same security/billing invariants as POST /task: the cycle creates a durable
  // queued agent task that consumes LLM tokens and worker time, so it must pass
  // the same rate limit, validation, plan-quota and chat-scope guards.
  agentRateLimiter,
  [
    body('topic').isString().trim().isLength({ min: 3, max: 4000 }).withMessage('topic must be 3-4000 chars'),
    body('code').isString().trim().isLength({ min: 1, max: 200 }).withMessage('code is required'),
    body('documentType').optional().isString(),
    body('field').optional().isString(),
    body('citationStyle').optional().isString(),
    body('chatId').optional().isString(),
    body('scopeMode').optional().isIn(['chat', 'global']),
    body('maxSteps').optional().isInt({ min: 2, max: 120 }),
  ],
  authenticateToken,
  enforcePlanQuota({ surface: 'agent.task.create' }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const cycleService = require('../services/agents/professional-document-cycle');
    const topic = String(req.body?.topic || '').trim();
    if (!topic) return res.status(400).json({ error: 'topic is required' });
    if (!String(req.body?.code || '').trim()) return res.status(400).json({ error: 'code is required' });

    // Reject cross-chat writes before any task is queued (broken-access-control
    // / IDOR guard): the caller may only target a chat they own.
    const scope = await chatTaskScope.assertChatScopeForAgentTask({
      prisma,
      userId: req.user?.id,
      body: req.body,
    });
    if (!scope.ok) return res.status(scope.status).json(scope.body);
    req.body.chatId = scope.chatId;

    let built;
    try {
      built = cycleService.buildProfessionalCycleRequest({
        topic,
        documentTypeOverride: req.body?.documentType,
        fieldOverride: req.body?.field,
        citationStyleOverride: req.body?.citationStyle,
        code: req.body.code,
      });
    } catch (err) {
      return res.status(400).json({ error: err?.message || 'could not build document cycle' });
    }

    // Rewrite the request body into the shape handleQueuedTaskRequest expects
    // and delegate so the cycle reuses queue, fallback, persistence and SSE.
    // The validated chatId from chatTaskScope is preserved by the spread.
    req.body = {
      ...req.body,
      goal: built.goal,
      displayGoal: built.displayGoal,
      systemContract: built.systemContract,
      folderCode: built.folderCode,
      cycle: {
        stages: built.stages,
        documentType: built.documentType,
        field: built.field,
        citationStyle: built.citationStyle,
        code: built.folderCode,
      },
      maxSteps: Number.isFinite(Number.parseInt(req.body?.maxSteps, 10)) ? req.body.maxSteps : 80,
    };
    return handleQueuedTaskRequest(req, res);
  },
);

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
      openclawRuntimeProfile: snapshot.openclawRuntimeProfile || null,
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

    if (!checkUserInflightCap(req, res)) return undefined;

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
      openclawRuntimeProfile: payload.openclawRuntimeProfile || null,
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

    // Document-followup recovery: when a user asks about an already-uploaded
    // document WITHOUT re-attaching it, the composer sends `files: []` and the
    // no-file agentic path fails with a 5xx (the reported bug). Reattach the most
    // recent readable document from this chat so the turn runs through the safe
    // local-document runtime — the same path the first (working) turn used.
    try {
      const providedNow = Array.isArray(req.body.files) ? req.body.files.map(String).filter(Boolean) : [];
      if (providedNow.length === 0 && req.body.chatId && looksLikeDocumentFollowupQuestion(req.body.goal)) {
        const reattached = await resolveChatDocumentFileIds(prisma, {
          userId: req.user?.id,
          chatId: String(req.body.chatId),
          providedFileIds: providedNow,
        });
        if (Array.isArray(reattached) && reattached.length > 0) {
          req.body.files = reattached;
          console.log(`[agent-task] reattached ${reattached.length} prior chat document(s) for follow-up question`);
        }
      }
    } catch (reattachErr) {
      console.warn('[agent-task] document reattach failed (continuing without):', reattachErr?.message || reattachErr);
    }

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
    const executionProfile = buildExecutionProfile({ goal: agentGoal, fileIds, fileMetadata: clientFileMetadata });
    const intentAlignmentProfile = buildUserIntentAlignmentProfile({ request: agentGoal, fileIds });
    const openclawRuntimeProfile = buildOpenClawRuntimeProfile({
      goal: agentGoal,
      userId: req.user?.id || null,
      chatId: typeof req.body.chatId === 'string' ? req.body.chatId : null,
      fileIds,
      model: typeof req.body.model === 'string' ? req.body.model : null,
    });
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
      openclawProfile: openclawRuntimeProfile,
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
    const integrationRuntimeProfile = buildIntegrationRuntimeProfile({
      contract: universalTaskContract,
      fileIds,
      requiredTools: enterpriseToolRuntimePlan?.summary?.requestedTools || [],
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
      integrationRuntime: integrationRuntimeProfile.promptProfile,
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
      openclawRuntimeProfile,
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

    // Heartbeat keeps proxies (nginx, Cloudflare, GCLB) from closing the
    // stream AND keeps the client's 90s idle watchdog reset during a long
    // planning / first-LLM-call phase. A bare `: keep-alive` comment is not
    // enough — edge proxies buffer/drop SSE comments — so we also send a real
    // `data:` heartbeat frame (mirrors routes/ai.js). The client reducer
    // treats unknown `heartbeat` events as a no-op.
    const inlineHeartbeatMs = Math.max(2_000, Number.parseInt(process.env.AGENT_TASK_SSE_HEARTBEAT_MS || '15000', 10) || 15000);
    heartbeatTimer = setInterval(() => {
      if (!clientConnected || res.writableEnded) { clearTimers(); return; }
      try {
        res.write(': keep-alive\n\n');
        res.write(`data: ${safeJsonStringify({ type: 'heartbeat', at: Date.now() })}\n\n`);
      } catch { safeCloseConnection(); }
    }, inlineHeartbeatMs);
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

    // Response timeout ensures we never leave a socket hanging
    responseTimeoutTimer = setTimeout(() => {
      if (!clientConnected || res.writableEnded) return;
      console.warn('[agent-task] response timeout reached, aborting');
      controller.abort();
    }, RESPONSE_TIMEOUT_MS);
    if (typeof responseTimeoutTimer.unref === 'function') responseTimeoutTimer.unref();

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const forbiddenToolNames = buildForbiddenToolNames({
      baseForbidden: Array.isArray(universalTaskContract.forbidden_tools)
        ? universalTaskContract.forbidden_tools
        : [],
      goal: agentGoal,
      fileIds,
      documentPolicy,
      executionProfile,
      universalTaskContract,
    });
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
              openclawRuntimeProfile,
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
      openclawRuntimeProfile,
      frameworks: frameworkStatus,
      taskContract,
      taskContractSource,
    });
    for (const event of openclawCapabilityKernel.buildOpenClawRuntimeEvents(openclawRuntimeProfile)) {
      emit(event);
    }

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
                openclawRuntimeProfile,
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
          uploadedFileContext,
          openclawRuntimeProfile,
          agentGoal
        ),
        ctx: toolCtx,
        finalizeGuard: ({ steps, unavailableTools }) => validateAgentTaskFinalize({
          finalizeProfile,
          openclawRuntimeProfile,
          taskPlan,
          steps,
          unavailableTools,
        }),
        onCompact: ({ step, removedMessages, chars }) => {
          try { console.log(`[agent-task] trace compacted at step ${step}: -${removedMessages} msgs, ${chars} chars`); } catch (_) {}
        },
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
          // Surface the FULL reasoning narration (not just the truncated
          // label) so the chat shows its thinking like Claude. The frontend
          // renders it as the step's detail line; `label` stays a short header.
          const reasoning = thought ? thought.replace(/\s+/g, ' ').trim().slice(0, 280) : undefined;
          emit({ type: 'step_start', id: currentStepId, label: shortLabel(label), icon, ...(reasoning ? { reasoning } : {}) });
        },
        onStepDone: (step) => {
          const firstAction = step.actions?.[0];
          // tool_call / tool_output already streamed via toolCtx.onEvent
          emit({ type: 'step_done', id: currentStepId, ok: !firstAction?.observation?.error });
          currentStepId = null;
        },
      });

      let finalMarkdown = result.finalAnswer || '';
      let stoppedReason = result.stoppedReason;
      const attachmentFinalNeedsRecovery = fileIds.length > 0 && looksLikeAttachmentRecoveryNeeded(finalMarkdown);
      if (attachmentFinalNeedsRecovery) {
        const recoveredMarkdown = resolveAttachmentFallbackMarkdown({
          goal: displayGoal || agentGoal,
          uploadedFileContext,
          reason: stoppedReason,
        });
        if (recoveredMarkdown && !looksLikeAttachmentRecoveryNeeded(recoveredMarkdown)) {
          finalMarkdown = recoveredMarkdown;
          stoppedReason = 'attachment_inline_recovery';
          documentPolicy.reason = 'Respuesta recuperada desde el contenido extraido de los adjuntos.';
          documentPolicy.thresholds = {
            ...(documentPolicy.thresholds || {}),
            attachmentFallback: true,
            originalStoppedReason: result.stoppedReason,
            fileCount: fileIds.length,
          };
          task.documentPolicy = documentPolicy;
          emit({
            type: 'repair_attempt',
            attempt: 1,
            status: 'recovered',
            message: 'Recuperé la respuesta usando el contenido extraído de tus archivos.',
          });
          emit({
            type: 'quality_gate',
            gate: 'attachment_inline_recovery',
            label: 'Respuesta recuperada',
            passed: true,
            summary: 'Se evitó entregar una disculpa vacía y se respondió desde el contenido de los adjuntos.',
          });
        }
      }

      if (finalMarkdown) {
        emit({ type: 'final_text', markdown: finalMarkdown });
      }

      const doneEvent = applyEvent({
        type: 'done',
        stoppedReason,
        stats: { steps: result.steps.length, artifacts: artifacts.length },
      });

      // Persist the final assistant message with artifacts metadata.
      let dbMessage = null;
      if (chatId && prisma && (finalMarkdown || streamState.steps.length || artifacts.length)) {
        try {
          const data = {
              content: serializeAgentState(streamState),
              tokens: Math.ceil((finalMarkdown || serializeAgentState(streamState)).length / 4),
              metadata: {
                source: 'agent-task',
                taskId,
                status: stoppedReason === 'aborted' ? 'cancelled' : 'completed',
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
                stoppedReason,
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
      task.status = stoppedReason === 'aborted' ? 'cancelled' : 'completed';
      task.updatedAt = new Date().toISOString();
      taskStore.markTaskStatus(task, task.status, {
        streamState,
        stats: {
          steps: result.steps.length,
          artifacts: artifacts.length,
          durationMs: Date.now() - taskStartedAt,
          stoppedReason,
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

function shouldRunAttachmentTaskLocally({ fileIds = [], goal = '', documentPolicy = null, env = process.env } = {}) {
  if (env.AGENT_TASK_QUEUE_ATTACHMENTS === '1') return false;
  if (documentPolicy?.autoGenerate || documentPolicy?.mode === 'doc_required') return false;
  return (Array.isArray(fileIds) && fileIds.length > 0) || isTranscriptionRequest(goal);
}

function resolveQueuedStreamTimeoutMs({ taskId, userId, env = process.env } = {}) {
  const configured = Number.parseInt(env.AGENT_RESPONSE_TIMEOUT_MS || '', 10);
  if (Number.isFinite(configured) && configured > 0) return Math.max(30_000, configured);
  const snapshot = getTaskForUser(taskId, userId) || taskStore.getTaskSnapshotForUser(taskId, userId);
  const heavyDocumentRun = Boolean(
    snapshot?.documentPolicy?.autoGenerate
    || snapshot?.documentPolicy?.mode === 'doc_required'
  );
  return heavyDocumentRun ? 3 * 60 * 60 * 1000 : 300_000;
}

// Resolve the step/runtime budget for an agent task. Explicit caller values
// always win. Otherwise the default is gated on intent: a heavy document the
// user actually asked us to auto-generate (or a caller that explicitly asked
// for a large step count) legitimately needs a long, multi-step run; a plain
// interactive chat answer does NOT. The chat client surfaces a "dejó de
// responder" stall after ~90s and abandons the stream, so the old blanket
// 60-step / 2-hour ceiling just let a misrouted/runaway loop burn ~50 min of
// LLM calls on a result nobody would ever see. Bound the interactive case
// tightly so a stuck task fails fast and cheap instead of grinding to the cap.
function resolveAgentTaskBudget({ maxStepsRaw, maxRuntimeMsRaw, documentPolicy = null } = {}) {
  const parsedSteps = Number.parseInt(maxStepsRaw, 10);
  const parsedRuntime = Number.parseInt(maxRuntimeMsRaw, 10);
  const hasSteps = Number.isFinite(parsedSteps);
  const hasRuntime = Number.isFinite(parsedRuntime);
  const heavy = Boolean(documentPolicy && documentPolicy.autoGenerate)
    || (hasSteps && parsedSteps > 40);
  const defaultSteps = heavy ? 100 : 28;
  const defaultRuntimeMs = heavy ? 2 * 60 * 60 * 1000 : 8 * 60 * 1000;
  return {
    maxSteps: hasSteps ? parsedSteps : defaultSteps,
    maxRuntimeMs: hasRuntime ? parsedRuntime : defaultRuntimeMs,
  };
}

// ─── Per-user in-flight concurrency cap ────────────────────────────────
// A single user should not be able to monopolise the agent worker pool
// (each queued task holds an LLM loop + tools for minutes). Above the cap
// the request is rejected with 429 + the active task list so the client
// can offer "espera o cancela una tarea". Env SIRAGPT_MAX_INFLIGHT_TASKS
// (default 3, ≤0 disables). Best-effort: a store hiccup never blocks.
function checkUserInflightCap(req, res) {
  const cap = Number.parseInt(process.env.SIRAGPT_MAX_INFLIGHT_TASKS || '3', 10);
  if (!Number.isFinite(cap) || cap <= 0) return true;
  try {
    const active = taskStore.getRunningTasksForUser(req.user?.id, { limit: cap + 1 });
    if (Array.isArray(active) && active.length >= cap) {
      metrics.counter('agent_task_inflight_cap_hits_total');
      res.status(429).json({
        error: `Ya tienes ${active.length} tareas de agente en curso (máximo ${cap}). Espera a que termine una o cancélala antes de lanzar otra.`,
        code: 'inflight_cap',
        cap,
        activeTasks: active.slice(0, cap).map((t) => ({
          taskId: t.taskId,
          status: t.status,
          displayGoal: String(t.displayGoal || '').slice(0, 120),
        })),
      });
      return false;
    }
  } catch (capErr) {
    console.warn('[agent-task] inflight cap check failed (allowing):', capErr?.message || capErr);
  }
  return true;
}

async function handleQueuedTaskRequest(req, res) {
  const rawGoal = String(req.body.goal || '');
  if (!checkUserInflightCap(req, res)) return undefined;
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

  // Liveness del productor: una conexión de cola no-ready significa que el
  // add() escribiría al vacío (jobs "queued" varados para siempre, visto en
  // producción local). Mejor un run local degradado que un chat colgado.
  {
    const { waitForQueueReady } = require('../services/agents/agent-task-queue');
    const queueReady = await waitForQueueReady(1500).catch(() => false);
    if (!queueReady) {
      return handleLocalTaskRequest(req, res, {
        fallbackReason: 'redis_unready',
        fallbackDetail: 'queue connection not ready (producer liveness check)',
      });
    }
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
  const documentPolicy = buildDocumentDeliveryPolicy({
    goal: agentGoal,
    displayGoal,
    files: fileIds,
  });
  if (shouldRunAttachmentTaskLocally({ fileIds, goal: agentGoal, documentPolicy })) {
    return handleLocalTaskRequest(req, res, {
      fallbackReason: 'attachment_local_runtime',
      fallbackDetail: 'attached document/image chat analysis bypassed queued runtime',
    });
  }
  const { maxSteps, maxRuntimeMs } = resolveAgentTaskBudget({
    maxStepsRaw: req.body.maxSteps,
    maxRuntimeMsRaw: req.body.maxRuntimeMs,
    documentPolicy,
  });
  const openclawRuntimeProfile = buildOpenClawRuntimeProfile({
    goal: agentGoal,
    userId: req.user?.id || null,
    chatId,
    fileIds,
    model,
  });

  const { folderCode: cycleFolderCode, cycle: cycleMeta } = extractCycleFields(req.body);

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
    openclawRuntimeProfile,
    folderCode: cycleFolderCode,
    cycle: cycleMeta,
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
    }
    // Never surface a bare 5xx for an enqueue failure: a degraded in-process
    // local run is always better UX than "El servidor tuvo un problema". This
    // also covers non-redis enqueue errors that previously bubbled to Express.
    console.warn('[agent-task] enqueue failed, falling back to local runtime:', message);
    return handleLocalTaskRequest(req, res, {
      fallbackReason: isRedisFailure ? 'redis_unavailable' : 'enqueue_failed',
      fallbackDetail: message,
    });
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
    openclawRuntimeProfile,
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

  for (const openclawEvent of openclawCapabilityKernel.buildOpenClawRuntimeEvents(openclawRuntimeProfile)) {
    streamState = reduceAgentState(streamState, openclawEvent);
    written = taskStore.appendTaskEvent({ ...written, streamState }, openclawEvent, streamState, { eventLimit: TASK_EVENT_LIMIT }) || written;
    await agentTaskPersistence.appendAgentTaskEvent(written, written.events?.[written.events.length - 1] || openclawEvent);
  }

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
    // Keep the watchdog alive after the request body is consumed. In
    // POST+SSE, req.close can be a normal upload-side close while the
    // response stream still needs the handoff fallback.
    const clearHandoffTimer = () => { try { clearTimeout(handoffTimer); } catch (_) {} };
    res.on('close', clearHandoffTimer);
    req.on('aborted', clearHandoffTimer);
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
  const documentPolicy = buildDocumentDeliveryPolicy({
    goal: agentGoal,
    displayGoal,
    files: fileIds,
  });
  const { maxSteps, maxRuntimeMs } = resolveAgentTaskBudget({
    maxStepsRaw: req.body.maxSteps,
    maxRuntimeMsRaw: req.body.maxRuntimeMs,
    documentPolicy,
  });
  const openclawRuntimeProfile = buildOpenClawRuntimeProfile({
    goal: agentGoal,
    userId: req.user?.id || null,
    chatId,
    fileIds,
    model,
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
    openclawRuntimeProfile,
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

  for (const openclawEvent of openclawCapabilityKernel.buildOpenClawRuntimeEvents(openclawRuntimeProfile)) {
    streamState = reduceAgentState(streamState, openclawEvent);
    appendTaskEvent(snapshot, openclawEvent, streamState);
  }

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

  const { folderCode: cycleFolderCode, cycle: cycleMeta } = extractCycleFields(req.body);

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
    openclawRuntimeProfile,
    folderCode: cycleFolderCode,
    cycle: cycleMeta,
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

  // Error / close handlers. Do not treat req.close as client
  // disconnect for POST+SSE: browsers can close the request upload side
  // after the JSON body is sent while the response stream must remain
  // open for worker events. res.close/req.aborted are the disconnect
  // signals that should tear down polling.
  res.on('error', () => { safeCloseQueuedConnection(); });
  res.on('close', () => { safeCloseQueuedConnection(); });
  res.on('drain', () => { /* no-op, reserved for backpressure tracking */ });
  req.on('aborted', () => { safeCloseQueuedConnection(); });

  // Response timeout: short interactive queued runs stay bounded, but heavy
  // document-edit/deliverable runs can legitimately take much longer while the
  // worker keeps writing progress in the background.
  const TIMEOUT = resolveQueuedStreamTimeoutMs({ taskId, userId });
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
  // Heartbeat keeps the client's idle watchdog (90s, see
  // lib/agent-task-service.ts) from firing while the worker sits in a long
  // planning / first-LLM-call phase that hasn't produced a step event yet
  // (the "Analizando solicitud · 0 pasos" stall). We emit BOTH a comment
  // frame (warms raw sockets) AND a real `data:` heartbeat frame — only the
  // latter reliably survives edge proxies (GCLB / nginx / Cloudflare) that
  // buffer or drop bare SSE comments, which is exactly why the chat stream
  // (routes/ai.js) already sends a `data:` heartbeat. The client reducer
  // ignores unknown `heartbeat` events (no-op) and resets its idle timer on
  // every received chunk. Interval well under the 90s watchdog, env-tunable.
  const heartbeatMs = Math.max(2_000, Number.parseInt(process.env.AGENT_TASK_SSE_HEARTBEAT_MS || '15000', 10) || 15000);
  const writeHeartbeat = () => {
    if (!clientConnected || res.writableEnded || res.destroyed) return;
    try {
      res.write(': keep-alive\n\n');
      res.write(`data: ${safeJsonStringify({ type: 'heartbeat', at: Date.now() })}\n\n`);
    } catch { safeCloseQueuedConnection(); }
  };
  heartbeatTimer = setInterval(writeHeartbeat, heartbeatMs);

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

function buildOpenClawRuntimeProfile({ goal, userId = null, chatId = null, fileIds = [], model = null, context = {} } = {}) {
  try {
    return openclawCapabilityKernel.buildCapabilityProfile({
      prompt: goal,
      userId,
      chatId,
      attachmentCount: Array.isArray(fileIds) ? fileIds.length : 0,
      model,
      context: {
        documents: Array.isArray(fileIds) ? fileIds.map((id) => ({ id, source: 'agent_task_file' })) : [],
        ...context,
      },
    });
  } catch (err) {
    console.warn('[agent-task] openclaw runtime profile unavailable:', err?.message || err);
    return null;
  }
}

function buildOpenClawRuntimeMeta(profileOrSummary) {
  return openclawCapabilityKernel.buildOpenClawRuntimeSummary(profileOrSummary) || profileOrSummary || null;
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

function looksLikeAttachmentRecoveryNeeded(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return true;
  return (
    value === 'null' ||
    value === 'undefined' ||
    value === '(agent returned empty message)' ||
    value === 'respuesta vacía' ||
    value === 'respuesta vacia' ||
    value.includes('no pude usar docintel') ||
    value.includes('no pude usar la herramienta') ||
    value.includes('falló de forma repetida') ||
    value.includes('fallo de forma repetida') ||
    value.includes('vuelve a intentarlo') ||
    value.includes('reformula la solicitud') ||
    value.includes('no pude acceder al contenido') ||
    value.includes('proporciona un archivo legible') ||
    value.includes('missing_scopes') ||
    value.includes('docintel_analyze') ||
    value.includes('docintel_retrieve') ||
    value.includes('nota sobre verificación') ||
    value.includes('nota sobre verificacion') ||
    value.includes('error de autorización del servidor') ||
    value.includes('error de autorizacion del servidor') ||
    value.includes('herramientas de análisis documental profundo') ||
    value.includes('herramientas de analisis documental profundo')
  );
}

function normalizeSystemContract(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

// Pull the professional-document-cycle fields off a request body and
// normalise them for the task payload. Returns nulls for ordinary tasks so
// the generic /api/agent/task path is unaffected. folderCode is re-sanitised
// here (defence in depth) before it ever reaches the artifact storage layer.
function extractCycleFields(body) {
  const out = { folderCode: null, cycle: null };
  if (!body || typeof body !== 'object') return out;
  if (typeof body.folderCode === 'string' && body.folderCode.trim()) {
    try {
      const { sanitizeFolderCode } = require('../services/agents/professional-document-cycle');
      out.folderCode = sanitizeFolderCode(body.folderCode);
    } catch {
      out.folderCode = null;
    }
  }
  if (body.cycle && typeof body.cycle === 'object' && Array.isArray(body.cycle.stages)) {
    out.cycle = {
      stages: body.cycle.stages
        .filter((s) => s && typeof s.id === 'string')
        .map((s) => ({ id: s.id, label: String(s.label || s.id) }))
        .slice(0, 12),
      documentType: body.cycle.documentType || null,
      field: body.cycle.field || null,
      citationStyle: body.cycle.citationStyle || null,
      code: out.folderCode || (typeof body.cycle.code === 'string' ? body.cycle.code : null),
    };
  }
  return out;
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
  uploadedFileContext = '',
  openclawRuntimeProfile = null,
  agentGoal = ''
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
  if (openclawRuntimeProfile) {
    parts.push(openclawCapabilityKernel.buildOpenClawPromptBlock(openclawRuntimeProfile));
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
    parts.push(`Uploaded/reference file ids available to tools: ${fileIds.join(', ')}. If the user asks about their content, call rag_retrieve before answering. If the user asks to edit/apply corrections/improve/add/remove/complete/format/convert the attachment, return a new edited artifact in the requested or original format instead of prose-only advice. If the user asks to transcribe, produce the exact readable text from the uploaded/pasted content; do not create a document unless the prompt explicitly requests Word/PDF/PPT/Excel.`);
  }
  const documentAnalysisQualityBlock = documentAnalysisQuality.buildPromptBlock({
    prompt: agentGoal,
    files: fileIds,
    language: 'es',
    source: 'agent.task',
  });
  if (documentAnalysisQualityBlock) {
    parts.push(documentAnalysisQualityBlock);
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
  openclawRuntimeProfile = null,
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
    openclawRuntimeProfile,
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
    openclawRuntimeProfile: task.openclawRuntimeProfile || null,
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
    cycle: null,
  };
}

function reduceAgentState(state, evt) {
  switch (evt.type) {
    case 'queue_status':
      return { ...state, queue: { status: evt.status, queue: evt.queue, jobId: evt.jobId, position: evt.position ?? null, estimatedWaitMs: evt.estimatedWaitMs ?? null, updatedAt: evt.ts || new Date().toISOString() } };
    case 'cycle_init':
      return {
        ...state,
        cycle: {
          stages: Array.isArray(evt.stages) ? evt.stages : [],
          documentType: evt.documentType || null,
          field: evt.field || null,
          citationStyle: evt.citationStyle || null,
          code: evt.code || null,
          current: null,
          history: [],
        },
      };
    case 'cycle_stage': {
      const base = state.cycle || { stages: [], documentType: null, field: null, citationStyle: null, code: null, current: null, history: [] };
      const status = evt.status === 'done' ? 'done' : 'start';
      const history = [
        ...(base.history || []),
        { stage: evt.stage, status, label: evt.label || evt.stage, note: evt.note || '', ts: evt.ts || new Date().toISOString() },
      ].slice(-20);
      return {
        ...state,
        cycle: { ...base, current: status === 'done' ? base.current : evt.stage, history },
      };
    }
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
          openclawRuntime: buildOpenClawRuntimeMeta(evt.openclawRuntimeSummary || evt.openclawRuntimeProfile),
        },
      };
    case 'step_start':
      return {
        ...state,
        steps: [...state.steps, {
          id: evt.id,
          label: evt.label,
          icon: evt.icon,
          ...(evt.reasoning ? { reasoning: evt.reasoning } : {}),
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
      ...(step.reasoning ? { reasoning: step.reasoning } : {}),
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
        openclawRuntime: state.meta.openclawRuntime || undefined,
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
  looksLikeAttachmentRecoveryNeeded,
  normalizeDisplayGoal,
  normalizeSystemContract,
  reduceAgentState,
  safeJsonStringify,
  resolveQueuedStreamTimeoutMs,
  shouldRunAttachmentTaskLocally,
  shortLabel,
  streamTaskEvents,
  serializeAgentState,
  toSerializableAgentState,
};

module.exports = router;
// Exposed for unit tests (document-followup recovery heuristic).
module.exports.looksLikeDocumentFollowupQuestion = looksLikeDocumentFollowupQuestion;
module.exports.isTranscriptionRequest = isTranscriptionRequest;
// Exposed for unit tests (interactive vs heavy-document budget gating).
module.exports.resolveAgentTaskBudget = resolveAgentTaskBudget;
// Exposed for unit tests (per-user in-flight concurrency cap).
module.exports.checkUserInflightCap = checkUserInflightCap;
