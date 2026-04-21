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
const queryTransforms = require('../services/rag/query-transforms');
const advancedChunking = require('../services/rag/advanced-chunking');
const contextCuration = require('../services/rag/context-curation');
const advancedPatterns = require('../services/rag/advanced-patterns');
const rgbBench = require('../services/rag/rgb-benchmark');

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
 * POST /api/rag/gear
 *   body: {
 *     query: string,              // user question
 *     collection?: string,
 *     k?: number,                 // top-k final passages
 *     maxIters?: number,          // hop budget (default 3)
 *     sessionId?: string,         // persist gist memory across turns
 *     retrieveOpts?: {            // forwarded to rag.retrieve each hop
 *       useHybrid?: bool, useMMR?: bool, rerank?: bool, useExpansion?: bool
 *     }
 *   }
 * Runs the full GEAR agent loop (retrieve → reason → rewrite → repeat,
 * then §5.4 final passageLink + RRF) and returns:
 *   { passages, answer, iterations, history, gist }
 *
 * Requires that both /api/rag/ingest AND /api/rag/ingest-triples have
 * been called for the collection; otherwise retrieval degrades to the
 * base pool (still works, just no graph benefit).
 */
router.post(
  '/gear',
  authenticateToken,
  [
    body('query').trim().isLength({ min: 2 }).withMessage('query too short'),
    body('collection').optional().isString().isLength({ min: 1, max: 64 }),
    body('k').optional().isInt({ min: 1, max: 50 }),
    body('maxIters').optional().isInt({ min: 1, max: 6 }),
    body('sessionId').optional().isString().isLength({ max: 128 }),
    body('retrieveOpts').optional().isObject(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const gearAgent = require('../services/gear-agent');
    try {
      const collection = req.body.collection || 'default';
      const k = req.body.k || 10;
      const maxIters = req.body.maxIters || 3;
      const result = await gearAgent.agentLoop({
        userId: req.user.id,
        collection,
        query: req.body.query,
        openai: rag.getOpenAI(),
        k,
        maxIters,
        sessionId: req.body.sessionId || null,
        retrieveOpts: req.body.retrieveOpts || {},
      });
      res.json({ ok: true, collection, ...result });
    } catch (err) {
      console.error('[rag] gear failed:', err);
      res.status(500).json({ error: err.message || 'gear failed' });
    }
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

// ─── Query transforms (Gao et al. §IV.C) ────────────────────────────────
router.post(
  '/query-transform',
  authenticateToken,
  [
    body('query').isString().isLength({ min: 1, max: 4000 }),
    body('strategy').isIn(['hyde', 'step-back', 'decompose']),
    body('model').optional().isString().isLength({ max: 64 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const openai = rag.getOpenAI();
    if (!openai) return res.status(503).json({ error: 'OPENAI_API_KEY not configured' });
    try {
      const out = await queryTransforms.transform({
        openai,
        query: req.body.query,
        strategy: req.body.strategy,
        model: req.body.model,
        maxSubQuestions: req.body.maxSubQuestions,
        keepOriginal: req.body.keepOriginal,
      });
      res.json({ ok: true, ...out });
    } catch (err) {
      console.error('[query-transform] failed:', err);
      res.status(500).json({ error: err.message || 'query-transform failed' });
    }
  }
);

// ─── Advanced chunking (Gao et al. §IV.B) ───────────────────────────────
router.post(
  '/chunk-advanced',
  authenticateToken,
  [
    body('source').isString().isLength({ min: 1, max: 400 }),
    body('text').isString().isLength({ min: 1, max: 500_000 }),
    body('strategy').isIn(['sentence-window', 'parent-child']),
    body('window').optional().isInt({ min: 1, max: 10 }),
    body('parentSize').optional().isInt({ min: 200, max: 5000 }),
    body('childSize').optional().isInt({ min: 50, max: 2000 }),
    body('childOverlap').optional().isInt({ min: 0, max: 500 }),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      if (req.body.strategy === 'sentence-window') {
        const chunks = advancedChunking.sentenceWindow({
          source: req.body.source,
          text: req.body.text,
          window: req.body.window,
        });
        return res.json({ ok: true, strategy: 'sentence-window', chunks });
      }
      const { parents, children } = advancedChunking.parentChild({
        source: req.body.source,
        text: req.body.text,
        parentSize: req.body.parentSize,
        childSize: req.body.childSize,
        childOverlap: req.body.childOverlap,
      });
      res.json({ ok: true, strategy: 'parent-child', parents, children });
    } catch (err) {
      console.error('[chunk-advanced] failed:', err);
      res.status(500).json({ error: err.message || 'chunk-advanced failed' });
    }
  }
);

// ─── Context curation (Gao et al. §V.A) ─────────────────────────────────
router.post(
  '/chain-of-note',
  authenticateToken,
  [
    body('query').isString().isLength({ min: 1, max: 4000 }),
    body('passages').isArray({ min: 1, max: 20 }),
    body('keepThreshold').optional().isFloat({ min: 0, max: 1 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const openai = rag.getOpenAI();
    if (!openai) return res.status(503).json({ error: 'OPENAI_API_KEY not configured' });
    try {
      const out = await contextCuration.chainOfNote({
        openai,
        query: req.body.query,
        passages: req.body.passages,
        keepThreshold: req.body.keepThreshold,
        model: req.body.model,
      });
      res.json({ ok: true, ...out });
    } catch (err) {
      console.error('[chain-of-note] failed:', err);
      res.status(500).json({ error: err.message || 'chain-of-note failed' });
    }
  }
);

router.post(
  '/compress',
  authenticateToken,
  [
    body('query').isString().isLength({ min: 1, max: 4000 }),
    body('passages').isArray({ min: 1, max: 30 }),
    body('minScore').optional().isFloat({ min: 0, max: 1 }),
    body('topSentences').optional().isInt({ min: 1, max: 20 }),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const out = contextCuration.compress({
        query: req.body.query,
        passages: req.body.passages,
        minScore: req.body.minScore,
        topSentences: req.body.topSentences,
        neverEmpty: req.body.neverEmpty !== false,
      });
      res.json({ ok: true, ...out });
    } catch (err) {
      console.error('[compress] failed:', err);
      res.status(500).json({ error: err.message || 'compress failed' });
    }
  }
);

// ─── RGB benchmark (Chen et al. 2023) ───────────────────────────────────
router.post(
  '/rgb',
  authenticateToken,
  [
    body('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  async (req, res) => {
    const openai = rag.getOpenAI();
    if (!openai) return res.status(503).json({ error: 'OPENAI_API_KEY not configured' });
    try {
      // The default answerer is a thin LLM call over (question + passages).
      // Callers can override by running rgbBench.evaluate() programmatically
      // with their own pipeline.
      const answerer = async ({ question, passages }) => {
        const context = passages.map((p, i) => `[${i + 1}] ${String(p.text || '').slice(0, 1000)}`).join('\n');
        const resp = await openai.chat.completions.create({
          model: req.body.model || 'gpt-4o-mini',
          temperature: 0,
          max_tokens: 300,
          messages: [
            { role: 'system', content: 'Answer the question using ONLY the provided context. If the context does not answer the question, reply exactly: I don\'t know.' },
            { role: 'user',   content: `CONTEXT:\n${context}\n\nQUESTION:\n${question}` },
          ],
        });
        return resp.choices?.[0]?.message?.content || '';
      };
      const out = await rgbBench.evaluate({ answer: answerer, limit: req.body.limit });
      res.json({ ok: true, ...out });
    } catch (err) {
      console.error('[rgb] failed:', err);
      res.status(500).json({ error: err.message || 'rgb failed' });
    }
  }
);

module.exports = router;
