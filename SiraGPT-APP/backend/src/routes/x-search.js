'use strict';

/**
 * x-search route — real-time X (Twitter) discovery via xAI Live Search.
 *
 *   POST /api/x-search
 *     body: { query, maxResults?, handles?, fromDate?, toDate?, sources?, mode? }
 *     →    { configured, query, model, summary, results, citations, note? }
 *
 *   GET  /api/x-search/health   → { ok, configured, model, metrics }
 *   GET  /api/x-search/metrics  → metrics snapshot (JSON)
 *   GET  /api/x-search/metrics.prom → Prometheus text exposition
 *
 * Auth: POST requires authenticateToken so anonymous traffic can't burn the
 * xAI quota. `search()` never throws on a missing key (returns
 * configured:false), so the try/catch only guards genuine upstream errors.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { responseCache } = require('../middleware/response-cache');
const xSearch = require('../services/x-search');
const xMetrics = require('../services/x-search-metrics');

const router = express.Router();

router.get('/health', responseCache({ ttlMs: 60_000, namespace: 'x-search-health' }), (req, res) => {
  const provider = xSearch.resolveXaiProvider();
  res.json({
    ok: true,
    configured: provider.configured,
    model: provider.model,
    metrics: xMetrics.snapshot(),
  });
});

router.get('/metrics', (req, res) => {
  res.json(xMetrics.snapshot());
});

router.get('/metrics.prom', (req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.send(xMetrics.toPrometheusText());
});

function failValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: 'validation_failed', details: errors.array() });
    return true;
  }
  return false;
}

router.post(
  '/',
  authenticateToken,
  [
    body('query').isString().trim().isLength({ min: 1, max: 256 })
      .withMessage('query must be 1-256 chars'),
    body('maxResults').optional().isInt({ min: 1, max: 30 }),
    body('handles').optional().isArray({ max: 10 }),
    body('sources').optional().isArray({ max: 4 }),
    body('mode').optional().isIn(['on', 'auto']),
    body('fromDate').optional().matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('fromDate must be YYYY-MM-DD'),
    body('toDate').optional().matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('toDate must be YYYY-MM-DD'),
  ],
  async (req, res) => {
    if (failValidation(req, res)) return;
    const { query, ...opts } = req.body;
    try {
      const result = await xSearch.search(query, opts);
      return res.json({ ...result, query });
    } catch (err) {
      console.error('[x-search] uncaught:', err.message);
      const status = Number(err.status) >= 400 && Number(err.status) < 500 ? 502 : 500;
      return res.status(status).json({ error: 'x_search_failed', message: err.message });
    }
  },
);

module.exports = router;
