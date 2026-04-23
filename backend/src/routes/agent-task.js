/**
 * agent-task — Claude-style agentic task runner.
 *
 * POST /api/agent/task (SSE)
 *   body: { goal: string, chatId?: string, model?: string, maxSteps?: number }
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
- When the user asks for a file (Excel, Word, PPT, PDF), use create_document. Write a complete Python script that writes to os.environ["OUT_PATH"]. Prefer openpyxl / python-docx / python-pptx / reportlab.
- Use python_exec for data wrangling, verification, numeric work — ANY time you'd otherwise "estimate" a number.
- Every tool call must be justified by a one-sentence thought in the assistant text preceding the call.
- Self-supervise: after each step, decide whether you have what the user asked for or whether to take one more action. Iterate until you can answer confidently.
- When ready, call the \`finalize\` tool with markdown. Do NOT write the final answer as free text — only via finalize.
- Respond in the same language as the user. Keep thoughts short (1-2 sentences); save the depth for the finalize markdown.`;

// ─── GET /api/agent/artifact/:id ────────────────────────────────────────

router.get('/artifact/:id', authenticateToken, (req, res) => {
  const id = String(req.params.id || '').replace(/[^a-f0-9]/gi, '');
  if (!id || id.length > 40) return res.status(400).json({ error: 'bad id' });

  // Find the file by stored-name prefix. We only stored one file per
  // id (content-addressed), so a single readdir is enough.
  if (!fs.existsSync(ARTIFACT_DIR)) return res.status(404).json({ error: 'no artifacts yet' });
  const entry = fs.readdirSync(ARTIFACT_DIR).find(f => f.startsWith(`${id}-`));
  if (!entry) return res.status(404).json({ error: 'artifact not found' });

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
    body('maxSteps').optional().isInt({ min: 2, max: 20 }),
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

    const controller = new AbortController();
    req.on('close', () => { if (!res.writableEnded) controller.abort(); });

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const tools = buildTaskTools();
    const model = typeof req.body.model === 'string' && req.body.model.length > 0 ? req.body.model : 'gpt-4o';
    const maxSteps = typeof req.body.maxSteps === 'number' ? req.body.maxSteps : 10;

    send({
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
      onEvent: (evt) => {
        // Forward tool-level events (tool_call / tool_output / file_artifact)
        // to the client with the active stepId so it can nest them.
        const payload = { ...evt, stepId: currentStepId };
        if (evt.type === 'file_artifact') {
          artifacts.push(evt.artifact);
        }
        send(payload);
      },
    };

    // Persist the user turn up front so a chat reload shows the prompt.
    const chatId = typeof req.body.chatId === 'string' ? req.body.chatId : null;
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
        model,
        extraSystem: TASK_SYSTEM_PROMPT,
        ctx: toolCtx,
        onStep: (step) => {
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
          send({ type: 'step_start', id: currentStepId, label: shortLabel(label), icon });
          // tool_call / tool_output already streamed via toolCtx.onEvent
          send({ type: 'step_done', id: currentStepId, ok: !firstAction?.observation?.error });
        },
      });

      if (result.finalAnswer) {
        send({ type: 'final_text', markdown: result.finalAnswer });
      }

      // Persist the final assistant message with artifacts metadata.
      let dbMessage = null;
      if (chatId && prisma && result.finalAnswer) {
        try {
          dbMessage = await prisma.message.create({
            data: {
              chatId,
              role: 'ASSISTANT',
              content: result.finalAnswer,
              tokens: Math.ceil(result.finalAnswer.length / 4),
              timestamp: new Date(),
              metadata: { source: 'agent-task', artifacts, stoppedReason: result.stoppedReason },
            },
          });
        } catch (e) { /* non-fatal */ }
      }

      send({
        type: 'done',
        stoppedReason: result.stoppedReason,
        stats: { steps: result.steps.length, artifacts: artifacts.length },
        dbMessageId: dbMessage?.id || null,
      });
      try { res.end(); } catch { /* already closed */ }
    } catch (err) {
      console.error('[agent-task] fatal:', err);
      send({ type: 'error', message: err.message || 'agent task failed' });
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
    case 'rag_retrieve':    return 'search';
    case 'finalize':        return 'check';
    default:                return 'thought';
  }
}

module.exports = router;
