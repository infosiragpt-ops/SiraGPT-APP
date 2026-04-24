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
const { body, validationResult } = require('express-validator');
const OpenAI = require('openai');

const { authenticateToken } = require('../middleware/auth');
const reactAgent = require('../services/react-agent');
const { buildTaskTools, ARTIFACT_DIR } = require('../services/agents/task-tools');

const prisma = (() => {
  try { return require('../config/database'); } catch { return null; }
})();

const router = express.Router();

const TASK_SYSTEM_PROMPT = `You are siraGPT's task agent. You work like Claude Code: plan briefly, then call tools to reach a deliverable answer.

Rules:
- When the user needs data, call web_search (Scopus / OpenAlex / SciELO / Semantic Scholar / Crossref / PubMed / DOAJ) instead of guessing. Do not fabricate citations.
- When the user refers to uploaded/private documents, previous project knowledge, PDFs, or "según mis archivos", call rag_retrieve before answering or generating files.
- When the user asks for a file (Excel, Word, PPT, PDF), use create_document. Write a complete Python script that writes to os.environ["OUT_PATH"]. Prefer openpyxl / python-docx / python-pptx / reportlab.
- Use python_exec for data wrangling, verification, numeric work — ANY time you'd otherwise "estimate" a number.
- For academic/scientific/market research, collect enough evidence first, keep DOI/URL/year/journal/source metadata, and separate verified findings from assumptions.
- For strict academic deliverables (for example "40 articles", "only DOI", "only open access", "only Latin America", "2022-2026"), do not pad the file with weak or unverified sources. Refine web_search queries until the requested count is met; if verified sources are still fewer than requested, state the exact verified count and label the missing gap instead of inventing rows.
- In Excel/Word bibliographic deliverables, DOI cells/URLs must use canonical https://doi.org/<doi> links when a DOI exists, and the file must include validation/status columns when the user asks for real sources.
- For long-running software/design work, iterate: inspect requirements, implement or generate, run tests/verification, repair failures, and only then finalize.
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

// ─── POST /api/agent/task ───────────────────────────────────────────────

router.post(
  '/task',
  [
    body('goal').isString().trim().isLength({ min: 3, max: 4000 }).withMessage('goal must be 3-4000 chars'),
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

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const send = (obj) => {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ }
    };

    const chatId = typeof req.body.chatId === 'string' ? req.body.chatId : null;
    const controller = new AbortController();
    let clientConnected = true;
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
    const model = typeof req.body.model === 'string' && req.body.model.length > 0 ? req.body.model : 'gpt-4o';
    const parsedMaxSteps = Number.parseInt(req.body.maxSteps, 10);
    const parsedMaxRuntimeMs = Number.parseInt(req.body.maxRuntimeMs, 10);
    const maxSteps = Number.isFinite(parsedMaxSteps) ? parsedMaxSteps : 60;
    const maxRuntimeMs = Number.isFinite(parsedMaxRuntimeMs) ? parsedMaxRuntimeMs : 2 * 60 * 60 * 1000;
    const runtimeTimer = setTimeout(() => controller.abort(), maxRuntimeMs + 5000);

    let streamState = initialAgentState();
    const applyEvent = (obj) => {
      streamState = reduceAgentState(streamState, obj);
      return obj;
    };
    const emit = (obj) => {
      send(applyEvent(obj));
    };

    emit({
      type: 'meta',
      goal: req.body.goal,
      model,
      tools: tools.map(t => t.name),
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

    // Persist the user turn up front so a chat reload shows the prompt.
    if (chatId && prisma) {
      try {
        const chat = await prisma.chat.findFirst({ where: { id: chatId, userId: req.user.id } });
        if (chat) {
          await prisma.message.create({
            data: { chatId, role: 'USER', content: req.body.goal, timestamp: new Date() },
          });
        }
      } catch (e) { /* non-fatal */ }
    }

    try {
      const result = await reactAgent.run(openai, {
        query: req.body.goal,
        tools,
        maxSteps,
        maxRuntimeMs,
        model,
        extraSystem: TASK_SYSTEM_PROMPT,
        ctx: toolCtx,
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
          dbMessage = await prisma.message.create({
            data: {
              chatId,
              role: 'ASSISTANT',
              content: serializeAgentState(streamState),
              tokens: Math.ceil((result.finalAnswer || serializeAgentState(streamState)).length / 4),
              timestamp: new Date(),
              metadata: {
                source: 'agent-task',
                artifacts,
                stoppedReason: result.stoppedReason,
                maxSteps,
                maxRuntimeMs,
              },
            },
          });
        } catch (e) { /* non-fatal */ }
      }

      send({
        ...doneEvent,
        dbMessageId: dbMessage?.id || null,
      });
      clearTimeout(runtimeTimer);
      clearInterval(heartbeat);
      try { res.end(); } catch { /* already closed */ }
    } catch (err) {
      console.error('[agent-task] fatal:', err);
      emit({ type: 'error', message: err.message || 'agent task failed' });
      clearTimeout(runtimeTimer);
      clearInterval(heartbeat);
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
    case 'rag_retrieve':    return 'search';
    case 'finalize':        return 'check';
    default:                return 'thought';
  }
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

function initialAgentState() {
  return { steps: [], artifacts: [], finalText: '', done: false };
}

function reduceAgentState(state, evt) {
  switch (evt.type) {
    case 'meta':
      return { ...state, meta: { goal: evt.goal, model: evt.model, tools: evt.tools } };
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
    case 'tool_call':
      return {
        ...state,
        steps: state.steps.map(step =>
          step.id === evt.stepId
            ? { ...step, toolCalls: [...step.toolCalls, { tool: evt.tool, preview: evt.preview, language: evt.language, codePreview: evt.codePreview }] }
            : step
        ),
      };
    case 'tool_output':
      return {
        ...state,
        steps: state.steps.map(step => {
          if (step.id !== evt.stepId) return step;
          const toolCalls = [...step.toolCalls];
          for (let i = toolCalls.length - 1; i >= 0; i--) {
            if (toolCalls[i].tool === evt.tool && !toolCalls[i].output) {
              toolCalls[i] = { ...toolCalls[i], output: { ok: evt.ok, preview: evt.preview } };
              break;
            }
          }
          return { ...step, toolCalls };
        }),
      };
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

module.exports = router;
