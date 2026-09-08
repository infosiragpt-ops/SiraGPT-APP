'use strict';

/**
 * agentes-coding route — Phase 1 stub for AGENTES_CODING_V2.
 *
 *   GET /api/agentes-coding/health  → { ok, enabled }  (public, always 200)
 *   — resto: flag off (and Phase 1 generally) ⇒ 404 not_found —
 *
 * Does not change default /agentes UX. No Monaco, no sandbox deploy.
 * See docs/agentes-arquitectura.md.
 */

const express = require('express');
const { isAgentesCodingV2Enabled } = require('../services/agentes-coding/flags');

const router = express.Router();

router.get('/health', (_req, res) => {
  const payload = JSON.stringify({ ok: true, enabled: isAgentesCodingV2Enabled() });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
  res.end(payload);
});

// Phase 1 has no other routes. Keep the 404 so a later PR can insert
// flag-gated handlers above this line without changing the health contract.
router.use((_req, res) => {
  return res.status(404).json({ error: 'not_found' });
});

module.exports = router;
