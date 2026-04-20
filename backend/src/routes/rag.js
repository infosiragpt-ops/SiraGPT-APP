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
    body('useHybrid').optional().isBoolean(),
    body('rrfK').optional().isInt({ min: 1, max: 200 }),
    body('useGraph').optional().isBoolean(),
    body('graphBeamSize').optional().isInt({ min: 1, max: 16 }),
    body('graphLength').optional().isInt({ min: 1, max: 8 }),
    body('graphGamma').optional().isInt({ min: 1, max: 10 }),
    body('graphProximalN').optional().isInt({ min: 1, max: 20 }),
    body('sessionId').optional().isString().isLength({ max: 128 }),
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
        useHybrid: !!req.body.useHybrid,
        rrfK: typeof req.body.rrfK === 'number' ? req.body.rrfK : undefined,
        useGraph: !!req.body.useGraph,
        graphOpenAI: req.body.useGraph ? rag.getOpenAI() : null,
        graphBeamSize: req.body.graphBeamSize,
        graphLength: req.body.graphLength,
        graphGamma: req.body.graphGamma,
        graphProximalN: req.body.graphProximalN,
        sessionId: req.body.sessionId || null,
      });
      res.json({ ok: true, collection, hits });
    } catch (err) {
      console.error('[rag] retrieve failed:', err);
      res.status(500).json({ error: err.message || 'retrieve failed' });
    }
  }
);

/**
 * POST /api/rag/ingest-code
 *   body: { collection?: string, files: [{ filename, content, language? }] }
 * Chunks each file on function/class boundaries before embedding, so the
 * retriever returns whole symbols instead of mid-function paragraphs.
 */
router.post(
  '/ingest-code',
  authenticateToken,
  [
    body('files').isArray({ min: 1 }).withMessage('files must be a non-empty array'),
    body('collection').optional().isString().isLength({ min: 1, max: 64 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const { files } = req.body;
      const collection = req.body.collection || 'code';
      const result = await rag.ingestCode(req.user.id, collection, files);
      res.json({ ok: true, collection, ...result });
    } catch (err) {
      console.error('[rag] ingest-code failed:', err);
      res.status(500).json({ error: err.message || 'ingest-code failed' });
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

/**
 * POST /api/rag/ingest-triples
 *   body: { collection?: string, sources?: string[] }
 * Runs LLM-based triple extraction over chunks already ingested into
 * `collection`. `sources` (optional) restricts extraction to chunks from
 * the given source identifiers — useful for backfilling a specific file
 * without re-processing the whole collection.
 *
 * This is the offline step of GEAR SyncGE; retrieval with useGraph=true
 * only works after this has been called for the collection.
 */
router.post(
  '/ingest-triples',
  authenticateToken,
  [
    body('collection').optional().isString().isLength({ min: 1, max: 64 }),
    body('sources').optional().isArray(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const collection = req.body.collection || 'default';
      const sources = Array.isArray(req.body.sources) ? req.body.sources : null;
      const result = await rag.ingestTriples(req.user.id, collection, {
        openai: rag.getOpenAI(),
        sources,
      });
      res.json({ ok: true, collection, ...result });
    } catch (err) {
      console.error('[rag] ingest-triples failed:', err);
      res.status(500).json({ error: err.message || 'ingest-triples failed' });
    }
  }
);

/** DELETE /api/rag/:collection */
router.delete('/:collection', authenticateToken, (req, res) => {
  rag.clear(req.user.id, req.params.collection);
  res.json({ ok: true, collection: req.params.collection });
});

module.exports = router;
