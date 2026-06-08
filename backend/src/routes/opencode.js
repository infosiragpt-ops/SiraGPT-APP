'use strict';

/**
 * opencode route — bridge between siraGPT and the vendored OpenCode engine
 * (runs as a Bun sidecar; see vendor/opencode/INTEGRATION.md).
 *
 *   GET  /api/opencode/health            → { ok, configured, baseUrl }  (public)
 *   POST /api/opencode/session           → { session }                  (auth)
 *   POST /api/opencode/session/:id/prompt→ { result }                   (auth)
 *   GET  /api/opencode/events            → SSE proxy of the engine stream(auth)
 *
 * Degrades to 503 when OPENCODE_SERVER_URL isn't set, so the route is safe to
 * mount even when no engine is running.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const {
  isOpencodeConfigured,
  getOpencodeConfig,
  basicAuthHeader,
} = require('../services/opencode/opencode-config');
const { createOpencodeClient } = require('../services/opencode/opencode-client');

const router = express.Router();

function requireConfigured(req, res, next) {
  if (!isOpencodeConfigured()) {
    return res.status(503).json({
      error: 'opencode_not_configured',
      message: 'OpenCode engine is not configured. Set OPENCODE_SERVER_URL.',
    });
  }
  next();
}

// Public liveness — never leaks the password.
router.get('/health', (req, res) => {
  const cfg = getOpencodeConfig();
  res.json({ ok: true, configured: cfg.enabled, baseUrl: cfg.enabled ? cfg.baseUrl : null });
});

// Create an agent session on the engine.
router.post('/session', authenticateToken, requireConfigured, async (req, res) => {
  try {
    const seed = req.body && typeof req.body === 'object' && req.body.session ? req.body.session : {};
    const session = await createOpencodeClient().createSession(seed);
    return res.json({ session });
  } catch (err) {
    return res.status(502).json({ error: 'opencode_upstream', message: err.message });
  }
});

// Send a text prompt to a session.
router.post(
  '/session/:id/prompt',
  authenticateToken,
  requireConfigured,
  [body('text').isString().withMessage('text must be a string').bail().trim().notEmpty().withMessage('text is required')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    }
    try {
      const result = await createOpencodeClient().prompt(req.params.id, req.body.text);
      return res.json({ result });
    } catch (err) {
      return res.status(502).json({ error: 'opencode_upstream', message: err.message });
    }
  },
);

// Proxy the engine's SSE event stream to the browser.
router.get('/events', authenticateToken, requireConfigured, async (req, res) => {
  const client = createOpencodeClient();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let upstream;
  try {
    const headers = { Accept: 'text/event-stream' };
    const auth = basicAuthHeader(getOpencodeConfig());
    if (auth) headers.Authorization = auth;
    upstream = await fetch(client.eventStreamUrl(), { headers });
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
    return res.end();
  }
  if (!upstream.ok || !upstream.body) {
    res.write(`event: error\ndata: ${JSON.stringify({ status: upstream.status })}\n\n`);
    return res.end();
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  req.on('close', () => { try { reader.cancel(); } catch { /* already closed */ } });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch { /* upstream dropped — fall through to end */ }
  return res.end();
});

module.exports = router;
