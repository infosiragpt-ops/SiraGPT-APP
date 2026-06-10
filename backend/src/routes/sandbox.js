'use strict';

/**
 * /api/sandbox — document editing sandbox sessions.
 *
 * Endpoints:
 *   POST   /api/sandbox/session          — create a session (optionally mount R2 file)
 *   DELETE /api/sandbox/session/:id      — destroy a session early
 *   GET    /api/sandbox/session/:id      — inspect session (files list + meta)
 *   POST   /api/sandbox/session/:id/finalize  — upload modified file back to R2
 *   GET    /api/sandbox/session/:id/download/:filename — stream file to client
 *   GET    /api/sandbox/backends         — describe available execution backends
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const mime    = require('mime-types');

const sessionManager = require('../services/sandbox/session-manager');
const { describeBackends } = require('../services/sandbox/router');

const router = express.Router();

// ── auth helper ─────────────────────────────────────────────────────────────
// Reuse whatever auth middleware the app exports. Falls back to a no-op if
// the module doesn't export the expected shape (tests / standalone).
let requireAuth;
try {
  requireAuth = require('../middleware/auth').requireAuth;
} catch (_) {
  requireAuth = (_req, _res, next) => next();
}

// ── POST /api/sandbox/session ───────────────────────────────────────────────
router.post('/session', requireAuth, async (req, res) => {
  try {
    const { r2Key, filename, meta = {} } = req.body || {};
    const userId = req.user?.id || req.userId || null;

    const result = await sessionManager.createSession({
      userId,
      r2Key:    r2Key    || null,
      filename: filename || null,
      meta,
    });

    return res.json({
      ok: true,
      sessionId: result.sessionId,
      filename:  result.filename,
      workdir:   undefined, // never expose the host path to the client
    });
  } catch (err) {
    const status = err.code === 'SESSION_LIMIT' ? 429 : 500;
    return res.status(status).json({ ok: false, error: err.message });
  }
});

// ── GET /api/sandbox/session/:id ────────────────────────────────────────────
router.get('/session/:id', requireAuth, (req, res) => {
  const sess = sessionManager.getSession(req.params.id);
  if (!sess) return res.status(404).json({ ok: false, error: 'session_not_found' });
  return res.json({
    ok: true,
    sessionId: req.params.id,
    files:     sessionManager.listFiles(req.params.id),
    meta:      sess.meta,
    age:       Date.now() - sess.lastTouched,
  });
});

// ── DELETE /api/sandbox/session/:id ─────────────────────────────────────────
router.delete('/session/:id', requireAuth, (req, res) => {
  const destroyed = sessionManager.destroySession(req.params.id);
  return res.json({ ok: destroyed, sessionId: req.params.id });
});

// ── POST /api/sandbox/session/:id/finalize ───────────────────────────────────
router.post('/session/:id/finalize', requireAuth, async (req, res) => {
  const { filename, r2Prefix } = req.body || {};
  if (!filename) return res.status(400).json({ ok: false, error: 'filename required' });

  const result = await sessionManager.finalizeFile(req.params.id, filename, {
    r2Prefix: r2Prefix || 'sandbox-output',
  });

  if (!result.ok) return res.status(result.error === 'session_not_found' ? 404 : 500).json(result);
  return res.json(result);
});

// ── GET /api/sandbox/session/:id/download/:filename ──────────────────────────
router.get('/session/:id/download/:filename', requireAuth, (req, res) => {
  const sess = sessionManager.getSession(req.params.id);
  if (!sess) return res.status(404).json({ ok: false, error: 'session_not_found' });

  const safeName = path.basename(req.params.filename);
  const abs = path.join(sess.workdir, safeName);

  // Verify the resolved path stays inside workdir (symlink/traversal guard)
  const realWorkdir = path.resolve(sess.workdir);
  const realAbs     = path.resolve(abs);
  if (!realAbs.startsWith(realWorkdir + path.sep)) {
    return res.status(400).json({ ok: false, error: 'invalid_filename' });
  }

  if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, error: 'file_not_found' });

  const contentType = mime.lookup(safeName) || 'application/octet-stream';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  sessionManager.touchSession(req.params.id);
  fs.createReadStream(abs).on('error', () => res.end()).pipe(res);
});

// ── GET /api/sandbox/backends ────────────────────────────────────────────────
router.get('/backends', requireAuth, (_req, res) => {
  res.json({ ok: true, backends: describeBackends() });
});

// ── GET /api/sandbox/skills/:type ────────────────────────────────────────────
router.get('/skills/:type', requireAuth, (req, res) => {
  const type = path.basename(req.params.type.toLowerCase().replace(/[^a-z]/g, ''));
  const skillPath = path.join(__dirname, '../services/sandbox/skills', `${type}.md`);
  if (!fs.existsSync(skillPath)) {
    return res.status(404).json({ ok: false, error: `no skill for type: ${type}` });
  }
  const content = fs.readFileSync(skillPath, 'utf8');
  return res.json({ ok: true, type, content });
});

module.exports = router;
