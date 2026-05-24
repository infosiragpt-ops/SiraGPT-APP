'use strict';

/**
 * F4 PR17 — GET /api/video/provider — provider status surface so the
 * frontend (F3 PR12) can render the "Vista previa simulada" disclaimer
 * when the active provider is `mock`. Public (no auth) because it
 * doesn't expose anything sensitive — just the active mode + a human-
 * readable disclaimer string.
 */

const express = require('express');
const { providerStatus } = require('../services/video-provider');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({ video: providerStatus() });
});

module.exports = router;
