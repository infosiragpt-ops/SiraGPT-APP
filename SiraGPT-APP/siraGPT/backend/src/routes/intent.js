'use strict';

/**
 * /api/intent — intent-classification endpoints.
 *
 * For now the only public route is POST /api/intent/web-search, which
 * lets the chat composer (or any other client) ask "does this prompt
 * need fresh web data?" before sending the turn. Spec §7.18 requires
 * the system to detect web-search intent automatically.
 *
 * Auth: optional. Anonymous callers get the same answer; we don't
 * personalise the result. Rate-limited at the global /api/ tier.
 */

const express = require('express');
const { optionalAuth } = require('../middleware/optionalAuth');
const { detectWebSearchIntent } = require('../services/web-search-intent');

const router = express.Router();

router.post('/web-search', optionalAuth, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '');
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    if (prompt.length > 8_000) {
      return res.status(413).json({ error: 'prompt too long (max 8000 chars)' });
    }
    const opts = {};
    if (Number.isFinite(req.body?.threshold)) opts.threshold = Number(req.body.threshold);
    if (req.body?.includeNegatives === false) opts.includeNegatives = false;
    const result = detectWebSearchIntent(prompt, opts);
    return res.json(result);
  } catch (err) {
    console.error('[intent/web-search] failed:', err?.message || err);
    return res.status(500).json({ error: 'intent classification failed' });
  }
});

module.exports = router;
