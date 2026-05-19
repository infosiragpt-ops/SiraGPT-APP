'use strict';

/**
 * scientific-search route — unified search over arXiv / Semantic Scholar /
 * OpenAlex / CrossRef / PubMed / Europe PMC / CORE.
 *
 *   POST /api/scientific-search
 *     body: { query, providers?, limit?, timeoutMs? }
 *     →    { papers, errors, providers, count }
 *
 *   GET  /api/scientific-search/providers
 *     →    { providers, keysConfigured: { core: bool, ncbi: bool, semanticscholar: bool } }
 *
 * Auth: requires authenticateToken so anonymous traffic doesn't burn through
 * the (rate-limited) upstream provider quotas.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { responseCache } = require('../middleware/response-cache');
const scientificSearch = require('../services/scientific-search');

const router = express.Router();

// Provider list rarely changes — cache for 5 min to avoid recomputing env probes.
router.get('/providers', responseCache({ ttlMs: 5 * 60_000, namespace: 'sci-providers' }), (req, res) => {
  res.json({
    providers: scientificSearch.PROVIDERS,
    keysConfigured: {
      core: !!process.env.CORE_API_KEY,
      ncbi: !!process.env.NCBI_API_KEY,
      semanticscholar: !!process.env.SEMANTIC_SCHOLAR_API_KEY,
      mailto: !!process.env.SIRAGPT_RESEARCH_EMAIL,
    },
  });
});

router.post(
  '/',
  authenticateToken,
  [
    body('query').isString().trim().isLength({ min: 2, max: 500 })
      .withMessage('query must be 2-500 chars'),
    body('providers').optional().isArray({ max: 7 })
      .withMessage('providers must be an array of provider names'),
    body('limit').optional().isInt({ min: 1, max: 50 }),
    body('timeoutMs').optional().isInt({ min: 500, max: 30_000 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    }
    const { query, providers, limit, timeoutMs } = req.body;
    try {
      const result = await scientificSearch.search(query, { providers, limit, timeoutMs });
      return res.json({
        ...result,
        count: result.papers.length,
        query,
      });
    } catch (err) {
      console.error('[scientific-search] uncaught:', err);
      return res.status(500).json({ error: 'scientific_search_failed', message: err.message });
    }
  }
);

module.exports = router;
