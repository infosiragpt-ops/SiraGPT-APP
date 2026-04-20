/**
 * RAG endpoints — ingest text into a user's private collection and
 * retrieve top-K chunks for a query. Backed by services/rag-service.
 *
 * All endpoints require auth so collections are isolated per-user.
 */

const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const rag = require('../services/rag-service');

const router = express.Router();

/**
 * POST /api/rag/ingest
 *   body: { collection?: string, docs: [{ text, title?, source? }] }
 * Chunks + embeds + indexes each doc. Returns counts.
 */
router.post(
  '/ingest',
  authenticateToken,
  [
    body('docs').isArray({ min: 1 }).withMessage('docs must be a non-empty array'),
    body('collection').optional().isString().isLength({ min: 1, max: 64 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const { docs } = req.body;
      const collection = req.body.collection || 'default';
      const result = await rag.ingest(req.user.id, collection, docs);
      res.json({ ok: true, collection, ...result });
    } catch (err) {
      console.error('[rag] ingest failed:', err);
      res.status(500).json({ error: err.message || 'ingest failed' });
    }
  }
);

/**
 * POST /api/rag/retrieve
 *   body: { query: string, collection?: string, k?: number }
 */
router.post(
  '/retrieve',
  authenticateToken,
  [
    body('query').trim().isLength({ min: 2 }).withMessage('query too short'),
    body('collection').optional().isString(),
    body('k').optional().isInt({ min: 1, max: 20 }),
    body('useExpansion').optional().isBoolean(),
    body('useMMR').optional().isBoolean(),
    body('mmrLambda').optional().isFloat({ min: 0, max: 1 }),
    body('rerank').optional().isBoolean(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const collection = req.body.collection || 'default';
      const k = req.body.k || 5;
      // Pass the shared OpenAI client when reranking is requested so the
      // reranker uses the same configured key/instance as embeddings.
      const rerankOpenAI = req.body.rerank ? rag.getOpenAI() : null;
      const hits = await rag.retrieve(req.user.id, collection, req.body.query, k, {
        useExpansion: !!req.body.useExpansion,
        useMMR: !!req.body.useMMR,
        mmrLambda: typeof req.body.mmrLambda === 'number' ? req.body.mmrLambda : undefined,
        rerank: !!req.body.rerank,
        rerankOpenAI,
      });
      res.json({ ok: true, collection, hits });
    } catch (err) {
      console.error('[rag] retrieve failed:', err);
      res.status(500).json({ error: err.message || 'retrieve failed' });
    }
  }
);

/** GET /api/rag/stats?collection=xxx */
router.get(
  '/stats',
  authenticateToken,
  [query('collection').optional().isString()],
  (req, res) => {
    const collection = req.query.collection || 'default';
    res.json({ ok: true, collection, ...rag.stats(req.user.id, collection) });
  }
);

/** DELETE /api/rag/:collection */
router.delete('/:collection', authenticateToken, (req, res) => {
  rag.clear(req.user.id, req.params.collection);
  res.json({ ok: true, collection: req.params.collection });
});

module.exports = router;
