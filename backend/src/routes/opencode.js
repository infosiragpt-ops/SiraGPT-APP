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
  getOpencodeModel,
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
      const result = await createOpencodeClient().prompt(req.params.id, req.body.text, {
        model: getOpencodeModel(),
      });
      return res.json({ result });
    } catch (err) {
      return res.status(502).json({ error: 'opencode_upstream', message: err.message });
    }
  },
);

// Read a file the agent wrote in the engine's workspace → { path, content }.
// Used by the /code UI to surface engine edits in the editor/preview.
router.get('/file', authenticateToken, requireConfigured, async (req, res) => {
  const path = typeof req.query.path === 'string' ? req.query.path : '';
  if (!path) return res.status(400).json({ error: 'validation_failed', message: 'path is required' });
  try {
    const out = await createOpencodeClient().readFileContent(path);
    const content = out && typeof out.content === 'string' ? out.content : '';
    return res.json({ path, content });
  } catch (err) {
    return res.status(502).json({ error: 'opencode_upstream', message: err.message });
  }
});

// List + read EVERY file the agent wrote in its workspace (recursive), so the
// /code UI can surface a real multi-file project in the file tree — not just a
// single index.html. Caps depth/count/size and skips dependency/build dirs.
const PROJECT_SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', '.opencode', 'coverage', '.turbo']);
const PROJECT_MAX_FILES = 80;
router.get('/files', authenticateToken, requireConfigured, async (req, res) => {
  const client = createOpencodeClient();
  const files = [];
  async function walk(dir, depth) {
    if (depth > 6 || files.length >= PROJECT_MAX_FILES) return;
    let listing;
    try { listing = await client.listFiles(dir); } catch { return; }
    const entries = listing && Array.isArray(listing.data) ? listing.data : [];
    for (const e of entries) {
      if (files.length >= PROJECT_MAX_FILES) break;
      const name = String(e.path || '').split('/').pop();
      if (!name || name.startsWith('.')) continue;
      const full = dir === '.' ? name : `${dir}/${name}`;
      if (e.type === 'directory') {
        if (!PROJECT_SKIP_DIRS.has(name)) await walk(full, depth + 1);
      } else if (e.type === 'file') {
        try {
          const out = await client.readFileContent(full);
          const content = out && typeof out.content === 'string' ? out.content : '';
          if (content) files.push({ path: full, content: content.slice(0, 200_000) });
        } catch { /* unreadable/binary → skip */ }
      }
    }
  }
  try {
    await walk('.', 0);
    return res.json({ files });
  } catch (err) {
    return res.status(502).json({ error: 'opencode_upstream', message: err.message });
  }
});

// Phase B — drive the code-runner sidecar that installs deps + starts the
// project's dev server, so the preview can iframe a REAL running Node/Vite/Next
// app. `devUrl` is where the browser reaches the dev server (published port).
const RUNNER_CTRL = process.env.CODE_RUNNER_URL || 'http://runner:4097';
const RUNNER_DEV_URL = process.env.CODE_RUNNER_DEV_URL || 'http://localhost:5173';

router.post('/run', authenticateToken, requireConfigured, async (req, res) => {
  try {
    const r = await fetch(`${RUNNER_CTRL}/run`, { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    return res.json({ ...j, devUrl: RUNNER_DEV_URL });
  } catch (err) {
    return res.status(502).json({ error: 'runner_unreachable', message: err.message });
  }
});

router.get('/run/status', authenticateToken, requireConfigured, async (req, res) => {
  try {
    const r = await fetch(`${RUNNER_CTRL}/status`);
    const j = await r.json().catch(() => ({}));
    return res.json({ ...j, devUrl: RUNNER_DEV_URL });
  } catch (err) {
    return res.status(502).json({ error: 'runner_unreachable', message: err.message });
  }
});

router.post('/run/stop', authenticateToken, requireConfigured, async (req, res) => {
  try {
    await fetch(`${RUNNER_CTRL}/stop`, { method: 'POST' }).catch(() => {});
    return res.json({ ok: true });
  } catch (err) {
    return res.status(502).json({ error: 'runner_unreachable', message: err.message });
  }
});

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
