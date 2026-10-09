'use strict';

/**
 * research-agent route — autonomous research loop (Manus-like).
 *
 *   POST /api/research-agent/run
 *     body: { query, depth?: 'quick'|'standard'|'deep', maxSteps?, providers?[] }
 *     →    { query, report, findings, papers, queriesTried, stats }
 *
 *   POST /api/research-agent/stream  (SSE)
 *     Same body as /run. Streams the agent's phase / paper / page / finding /
 *     decision events as they happen, then a final 'report' event.
 *
 * Auth: requires authenticateToken. The loop calls vision LLMs + opens a
 * headless browser, so anonymous traffic would burn compute fast.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const researchAgent = require('../services/research-agent');

const router = express.Router();

const validators = [
  body('query').isString().trim().isLength({ min: 3, max: 500 })
    .withMessage('query must be 3-500 chars'),
  body('depth').optional().isIn(['quick', 'standard', 'deep']),
  body('maxSteps').optional().isInt({ min: 1, max: 12 }),
  body('providers').optional().isArray({ max: 7 }),
];

router.post('/run', authenticateToken, validators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });
  const { query, depth, maxSteps, providers } = req.body;
  try {
    const result = await researchAgent.run({ query, depth, maxSteps, providers });
    res.json(result);
  } catch (err) {
    console.error('[research-agent] uncaught:', err);
    res.status(500).json({ error: 'research_agent_failed', message: err.message });
  }
});

const prisma = require('../config/database');
const { createResearchRuns } = require('../services/research-runs');
const runs = createResearchRuns({ agent: researchAgent, prisma, resolveModel: async ({ model, provider }) => {
  const ai = require('../services/ai-service');
  const normalizedProvider = ai.normalizeChatProvider(provider, model);
  if (!/^(OpenAI|OpenRouter|DeepSeek|Gemini|Anthropic|Kimi|Moonshot|xAI|Meta|Groq|Cerebras|Mistral|Z\.ai)$/i.test(normalizedProvider)) {
    throw Object.assign(new Error('El modelo seleccionado no admite este modo de investigación.'), { status: 400 });
  }
  const normalizedModel = ai.normalizeModelForProvider(normalizedProvider, model);
  return { aiClient: ai.getClient(normalizedProvider), model: normalizedModel, supportsVision: ai.modelSupportsVision(normalizedProvider, normalizedModel) };
} });

router.get('/runs/:runId', authenticateToken, async (req, res) => {
  try { res.json(await runs.get(req.params.runId, req.user.id)); }
  catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : 'research_status_failed' }); }
});
router.post('/runs/:runId/cancel', authenticateToken, async (req, res) => {
  try { res.json(await runs.cancel(req.params.runId, req.user.id)); }
  catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : 'research_cancel_failed' }); }
});

router.post('/stream', authenticateToken, validators, [
  body('chatId').isString().isLength({ min: 1, max: 128 }),
  body('runId').optional().matches(/^rr_[a-zA-Z0-9_-]{1,76}$/),
  body('model').optional().isString().isLength({ min: 1, max: 200 }),
  body('provider').optional().isString().isLength({ min: 1, max: 80 }),
  body('userMessageId').optional().isString().isLength({ min: 1, max: 128 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });
  const { query, depth, maxSteps, providers, runId, chatId, model, provider, userMessageId } = req.body;
  let attachedId;
  const pending = [];
  let started = false;
  const send = event => {
    if (!started) { pending.push(event); return; }
    if (!res.destroyed && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (['done', 'error', 'cancelled'].includes(event.type)) res.end();
    }
  };
  try {
    const run = await runs.start(req.user.id, { query, depth, maxSteps, providers, runId, chatId, model, provider, userMessageId }, send);
    attachedId = run.runId;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    started = true;
    send({ type: 'start', runId: run.runId, chatId: run.chatId, status: run.status });
    for (const event of pending) send(event);
    if (run.status === 'completed') { send({ type: 'report', report: run.result, runId: run.runId }); send({ type: 'done', runId: run.runId }); }
    else if (run.status !== 'running') send({ type: run.status === 'cancelled' ? 'cancelled' : 'error', message: run.error, runId: run.runId });
    // A replay hitting another worker is recovered by the status endpoint.
    else if (!runs.active.has(run.runId)) res.end();
    const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n'); }, 15_000);
    heartbeat.unref?.();
    res.once('close', () => { clearInterval(heartbeat); runs.detach(attachedId, send); });
  } catch (err) {
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.status ? err.message : 'research_agent_failed' });
    else { send({ type: 'error', message: 'No se pudo iniciar la investigación.' }); }
  }
});

module.exports = router;
