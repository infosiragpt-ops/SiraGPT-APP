'use strict';

/**
 * /api/free-ia — small public-friendly endpoint exposing the Free IA
 * (Cerebras Llama 3.1 8B) availability state.
 *
 *   GET /api/free-ia/status — returns whether Free IA is configured,
 *   the model id, the display name, and the provider. Frontend uses
 *   this to:
 *     1. Render a "Free IA disponible" badge on the model picker.
 *     2. Decide whether to keep the user's selected model sticky on
 *        credit exhaustion (per the spec — never auto-switch the UI).
 *     3. Surface the brand name when the LLM gateway falls back.
 *
 * Public — no auth required. Returns only non-secret fields (no API
 * key, no base URL is leaked).
 */

const express = require('express');
const router = express.Router();

const {
  getCerebrasConfig,
  isFreeIaConfigured,
} = require('../services/ai/cerebras-client');

router.get('/status', (_req, res) => {
  const cfg = getCerebrasConfig();
  res.json({
    enabled: cfg.enabled,
    reason: cfg.reason,
    model: cfg.model,
    displayName: cfg.displayName,
    provider: cfg.provider,
    // baseURL deliberately omitted — internal-only detail.
  });
});

router.get('/configured', (_req, res) => {
  res.json({ configured: isFreeIaConfigured() });
});

module.exports = router;
