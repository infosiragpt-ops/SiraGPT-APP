'use strict';

/**
 * GET /api/admin/transcription-capabilities — the live transcription / OCR
 * capability report (services/transcription-capabilities.js): STT rungs and
 * cooldowns, local whisper.cpp model and flags, Silero VAD, ffmpeg filters,
 * tessdata languages, heif-dec, GLM-OCR and the cloud vision runtimes.
 *
 * Super-admin only. Mounted in index.js BEFORE the generic /api/admin router
 * (whose declarative policy map fails closed for unmapped paths). No secret
 * is ever part of the report. `?refresh=1` bypasses the 60 s memo.
 */

const express = require('express');

function buildTranscriptionCapabilitiesRouter({ authenticate, authorize, collect } = {}) {
  const router = express.Router();
  const auth = authenticate || require('../middleware/auth').authenticateToken;
  const guard = authorize || require('../middleware/auth').requireSuperAdmin;
  const run = collect || ((opts) => require('../services/transcription-capabilities').collectTranscriptionCapabilities(opts));

  router.get('/', auth, guard, async (req, res) => {
    try {
      const refresh = req.query && (req.query.refresh === '1' || req.query.refresh === 'true');
      const report = await run({ probeNetwork: true, refresh });
      res.set('Cache-Control', 'no-store');
      res.json(report);
    } catch (error) {
      console.warn('[admin/transcription-capabilities] failed:', error && error.code ? error.code : 'error');
      res.status(500).json({ error: 'transcription_capabilities_unavailable' });
    }
  });

  return router;
}

const router = buildTranscriptionCapabilitiesRouter();
module.exports = router;
module.exports.buildTranscriptionCapabilitiesRouter = buildTranscriptionCapabilitiesRouter;
