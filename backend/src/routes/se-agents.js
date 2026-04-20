/**
 * se-agents routes — HTTP surface for the SE-agent suite.
 *
 * Base path: /api/se-agents
 *
 * Endpoints:
 *   POST /review       — code review agent
 *   POST /test-gen     — test generation agent
 *   POST /debug        — debugging agent
 *   POST /code-gen     — code generation agent
 *   POST /static-check — static analysis agent
 *   POST /orchestrate  — intent router / pipeline / collaborative
 *
 * All endpoints auth-required; all take a `collection` (default 'code')
 * that should already have /api/rag/ingest-code called on it.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const rag = require('../services/rag-service');

const codeReview = require('../services/agents/code-review-agent');
const testGen = require('../services/agents/test-gen-agent');
const debugAgent = require('../services/agents/debug-agent');
const codeGen = require('../services/agents/code-gen-agent');
const staticCheck = require('../services/agents/static-check-agent');
const orchestrator = require('../services/agents/se-orchestrator');

const router = express.Router();

function requireOpenAI(res) {
  const client = rag.getOpenAI();
  if (!client) {
    res.status(503).json({ error: 'OPENAI_API_KEY not configured — agents unavailable' });
    return null;
  }
  return client;
}

function handleErrors(fn) {
  return async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      await fn(req, res);
    } catch (err) {
      console.error(`[se-agents ${req.path}] failed:`, err);
      res.status(500).json({ error: err.message || 'agent failed' });
    }
  };
}

router.post(
  '/review',
  authenticateToken,
  [
    body('collection').optional().isString().isLength({ max: 64 }),
    body('files').optional().isArray(),
    body('focus').optional().isString().isLength({ max: 500 }),
    body('maxIters').optional().isInt({ min: 1, max: 20 }),
  ],
  handleErrors(async (req, res) => {
    const openai = requireOpenAI(res); if (!openai) return;
    const result = await codeReview.review({
      openai,
      userId: req.user.id,
      collection: req.body.collection || 'code',
      files: Array.isArray(req.body.files) ? req.body.files : null,
      focus: req.body.focus || null,
      maxIters: req.body.maxIters || 12,
    });
    res.json({ ok: true, ...result });
  })
);

router.post(
  '/test-gen',
  authenticateToken,
  [
    body('source').isString().isLength({ min: 1, max: 256 }),
    body('symbol').optional().isString().isLength({ max: 128 }),
    body('language').optional().isString().isLength({ max: 32 }),
    body('collection').optional().isString().isLength({ max: 64 }),
    body('maxIters').optional().isInt({ min: 1, max: 20 }),
  ],
  handleErrors(async (req, res) => {
    const openai = requireOpenAI(res); if (!openai) return;
    const result = await testGen.generate({
      openai,
      userId: req.user.id,
      collection: req.body.collection || 'code',
      source: req.body.source,
      symbol: req.body.symbol,
      language: req.body.language,
      maxIters: req.body.maxIters || 10,
    });
    res.json({ ok: true, ...result });
  })
);

router.post(
  '/debug',
  authenticateToken,
  [
    body('error').isString().isLength({ min: 1, max: 16000 }),
    body('context').optional().isString().isLength({ max: 4000 }),
    body('suspicion').optional().isArray(),
    body('collection').optional().isString().isLength({ max: 64 }),
    body('maxIters').optional().isInt({ min: 1, max: 20 }),
  ],
  handleErrors(async (req, res) => {
    const openai = requireOpenAI(res); if (!openai) return;
    const result = await debugAgent.debug({
      openai,
      userId: req.user.id,
      collection: req.body.collection || 'code',
      error: req.body.error,
      context: req.body.context,
      suspicion: Array.isArray(req.body.suspicion) ? req.body.suspicion : null,
      maxIters: req.body.maxIters || 12,
    });
    res.json({ ok: true, ...result });
  })
);

router.post(
  '/code-gen',
  authenticateToken,
  [
    body('spec').isString().isLength({ min: 1, max: 8000 }),
    body('strategy').optional().isIn(['single_path', 'multi_path']),
    body('numPaths').optional().isInt({ min: 2, max: 5 }),
    body('language').optional().isString().isLength({ max: 32 }),
    body('collection').optional().isString().isLength({ max: 64 }),
    body('maxIters').optional().isInt({ min: 1, max: 20 }),
  ],
  handleErrors(async (req, res) => {
    const openai = requireOpenAI(res); if (!openai) return;
    const result = await codeGen.generate({
      openai,
      userId: req.user.id,
      collection: req.body.collection || 'code',
      spec: req.body.spec,
      strategy: req.body.strategy || 'single_path',
      numPaths: req.body.numPaths || 3,
      language: req.body.language,
      maxIters: req.body.maxIters || 12,
    });
    res.json({ ok: true, ...result });
  })
);

router.post(
  '/static-check',
  authenticateToken,
  [
    body('files').isArray({ min: 1 }),
    body('collection').optional().isString().isLength({ max: 64 }),
    body('maxIters').optional().isInt({ min: 1, max: 20 }),
  ],
  handleErrors(async (req, res) => {
    const openai = requireOpenAI(res); if (!openai) return;
    const result = await staticCheck.check({
      openai,
      userId: req.user.id,
      collection: req.body.collection || 'code',
      files: req.body.files,
      maxIters: req.body.maxIters || 8,
    });
    res.json({ ok: true, ...result });
  })
);

router.post(
  '/orchestrate',
  authenticateToken,
  [
    body('mode').isIn(['route', 'pipeline', 'collaborate']),
    body('collection').optional().isString().isLength({ max: 64 }),
    body('message').optional().isString().isLength({ max: 4000 }),
    body('recipe').optional().isString().isLength({ max: 64 }),
    body('input').optional().isObject(),
    body('spec').optional().isString().isLength({ max: 8000 }),
    body('maxRounds').optional().isInt({ min: 1, max: 6 }),
    body('language').optional().isString().isLength({ max: 32 }),
  ],
  handleErrors(async (req, res) => {
    const openai = requireOpenAI(res); if (!openai) return;
    const collection = req.body.collection || 'code';

    if (req.body.mode === 'route') {
      const r = await orchestrator.routeIntent({ openai, message: req.body.message || '' });
      return res.json({ ok: true, ...r });
    }
    if (req.body.mode === 'pipeline') {
      const r = await orchestrator.pipeline({
        openai, userId: req.user.id, collection,
        recipe: req.body.recipe, input: req.body.input || {},
      });
      return res.json({ ok: true, ...r });
    }
    if (req.body.mode === 'collaborate') {
      const r = await orchestrator.collaborate({
        openai, userId: req.user.id, collection,
        spec: req.body.spec,
        maxRounds: req.body.maxRounds || 3,
        language: req.body.language,
      });
      return res.json({ ok: true, ...r });
    }
  })
);

module.exports = router;
