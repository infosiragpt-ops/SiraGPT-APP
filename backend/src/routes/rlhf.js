'use strict';

/**
 * RLHF HTTP surface.
 *
 *   POST /api/rlhf/feedback          record an explicit thumb
 *   POST /api/rlhf/pair              record a chosen/rejected pair for one prompt
 *   GET  /api/rlhf/stats             caller's preference counts
 *   GET  /api/rlhf/export            SFT / DPO / RM JSONL
 *   POST /api/rlhf/score             score a (prompt, response) with the RM
 *   POST /api/rlhf/rerank            rank N candidates with the RM (judge fallback)
 *   POST /api/rlhf/train             fit the RM (admin)
 *   GET  /api/rlhf/model             active RM metrics
 *
 * Collection is on by default (SIRAGPT_RLHF_ENABLED). Best-of-N sampling
 * at generation time is off by default (SIRAGPT_RLHF_BEST_OF_N) because
 * it multiplies token cost.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const rag = require('../services/rag-service');
const rlhf = require('../services/rlhf');
const {
  contentDispositionHeader,
  safeDownloadFilename,
} = require('../middleware/file-response-safety');

const router = express.Router();

function handleErrors(fn) {
  return async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      await fn(req, res);
    } catch (err) {
      console.error(`[rlhf ${req.path}] failed:`, err);
      res.status(500).json({ error: err.message || 'rlhf failed' });
    }
  };
}

function embedder() {
  return (texts) => rag.embed(texts);
}

router.post(
  '/feedback',
  authenticateToken,
  [
    body('runId').optional().isString().isLength({ min: 1, max: 128 }),
    body('messageId').optional().isString().isLength({ min: 1, max: 128 }),
    body('agent').optional().isString().isLength({ max: 32 }),
    body('request').optional().isString().isLength({ max: 8000 }),
    body('prompt').optional().isString().isLength({ max: 8000 }),
    body('response').custom((v) => v !== undefined),
    body('helpful').optional().isBoolean(),
    body('label').optional().isString().isLength({ max: 32 }),
    body('notes').optional().isString().isLength({ max: 1000 }),
    body('chatId').optional().isString().isLength({ max: 128 }),
  ],
  handleErrors(async (req, res) => {
    const r = await rlhf.ingestThumb({
      userId: req.user.id,
      runId: req.body.runId || req.body.messageId,
      messageId: req.body.messageId || req.body.runId,
      chatId: req.body.chatId || null,
      agent: req.body.agent || 'chat',
      request: req.body.request || req.body.prompt || '',
      response: req.body.response,
      helpful: typeof req.body.helpful === 'boolean' ? req.body.helpful : undefined,
      label: req.body.label,
      notes: req.body.notes || null,
      embedder: embedder(),
    });
    res.json({ ok: true, ...r, stats: rlhf.stats(req.user.id) });
  }),
);

router.post(
  '/pair',
  authenticateToken,
  [
    body('prompt').isString().isLength({ min: 1, max: 8000 }),
    body('chosen').custom((v) => v !== undefined),
    body('rejected').custom((v) => v !== undefined),
    body('agent').optional().isString().isLength({ max: 32 }),
    body('chatId').optional().isString().isLength({ max: 128 }),
  ],
  handleErrors(async (req, res) => {
    const prompt = req.body.prompt;
    const agent = req.body.agent || 'chat';
    const chatId = req.body.chatId || null;
    const chosen = await rlhf.recordEvent({
      userId: req.user.id,
      chatId,
      agent,
      source: 'pairwise',
      label: 'chosen',
      promptText: prompt,
      responseText: req.body.chosen,
      embedder: embedder(),
    });
    const rejected = await rlhf.recordEvent({
      userId: req.user.id,
      chatId,
      agent,
      source: 'pairwise',
      label: 'rejected',
      promptText: prompt,
      responseText: req.body.rejected,
      embedder: embedder(),
    });
    res.json({
      ok: true,
      chosen: chosen.event && { id: chosen.event.id, pairId: chosen.event.pairId },
      rejected: rejected.event && { id: rejected.event.id, pairId: rejected.event.pairId },
      stats: rlhf.stats(req.user.id),
    });
  }),
);

router.get('/stats', authenticateToken, handleErrors(async (req, res) => {
  await rlhf.hydrateUser(req.user.id);
  const globalStats = req.user.isAdmin || req.user.isSuperAdmin ? rlhf.stats() : null;
  res.json({
    ok: true,
    enabled: rlhf.isCollectionEnabled(),
    bestOfN: rlhf.isBestOfNEnabled(),
    model: rlhf.hasActiveModel() ? {
      version: rlhf.getActiveModel().version,
      metrics: rlhf.getActiveModel().metrics,
      trainedAt: rlhf.getActiveModel().trainedAt,
    } : null,
    user: rlhf.stats(req.user.id),
    global: globalStats,
  });
}));

router.get('/export', authenticateToken, handleErrors(async (req, res) => {
  const format = String(req.query.format || 'sft').toLowerCase();
  const agent = typeof req.query.agent === 'string' ? req.query.agent : null;
  const scrubPii = req.query.scrubPii !== 'false';
  const aggressive = req.query.aggressive === 'true';
  const includeRlaif = req.query.includeRlaif === 'true';
  if (!['sft', 'dpo', 'pairs', 'rm'].includes(format)) {
    return res.status(400).json({ error: `unknown format '${format}' — use sft, dpo, or rm` });
  }
  const out = await rlhf.exportData({
    userId: req.user.id, format, agent, scrubPii, aggressive, includeRlaif,
  });
  const filename = safeDownloadFilename(
    `rlhf-${format}${agent ? '-' + agent : ''}-${req.user.id}.jsonl`,
    { fallback: 'rlhf-preferences.jsonl', extension: '.jsonl' },
  );
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Content-Disposition', contentDispositionHeader('attachment', filename));
  res.setHeader('X-Export-Count', String(out.count));
  res.setHeader('X-PII-Scrubbed', String(out.scrubbed));
  res.send(out.ndjson);
}));

router.post(
  '/score',
  authenticateToken,
  [
    body('prompt').isString().isLength({ min: 1, max: 8000 }),
    body('response').custom((v) => v !== undefined),
  ],
  handleErrors(async (req, res) => {
    const out = await rlhf.scoreCompletion({
      prompt: req.body.prompt,
      response: typeof req.body.response === 'string' ? req.body.response : JSON.stringify(req.body.response),
      embedder: embedder(),
    });
    res.json({ ok: true, ...out });
  }),
);

router.post(
  '/rerank',
  authenticateToken,
  [
    body('prompt').isString().isLength({ min: 1, max: 8000 }),
    body('samples').isArray({ min: 1, max: 8 }),
  ],
  handleErrors(async (req, res) => {
    const ranked = await rlhf.pickBest({
      prompt: req.body.prompt,
      userRequest: req.body.prompt,
      samples: req.body.samples,
      embedder: embedder(),
      openai: rag.getOpenAI(),
    });
    res.json({ ok: true, ...ranked });
  }),
);

router.post('/train', authenticateToken, requireAdmin, handleErrors(async (req, res) => {
  const result = await rlhf.train({
    userId: req.body && req.body.scope === 'user' ? req.user.id : null,
    scope: req.body && req.body.scope,
  });
  res.json({ ok: !!result.ok, ...result });
}));

router.get('/model', authenticateToken, handleErrors(async (req, res) => {
  await rlhf.loadLatestActive();
  const active = rlhf.getActiveModel();
  if (!active) return res.json({ ok: true, ready: false });
  res.json({
    ok: true,
    ready: true,
    version: active.version,
    metrics: active.metrics,
    trainedAt: active.trainedAt,
    scope: active.scope,
  });
}));

module.exports = router;
