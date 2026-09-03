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
// Reuse whatever auth middleware the app exports. Fail closed: a missing
// module or an unexpected export shape must abort boot, never open the door.
function resolveAuthMiddleware(loadAuth) {
  let auth;
  try {
    auth = (loadAuth || (() => require('../middleware/auth')))();
  } catch (err) {
    throw new Error(`sandbox routes: auth middleware unavailable (${err.message}) — refusing to mount with auth disabled`);
  }
  const middleware = auth && (auth.requireAuth || auth.authenticateToken);
  if (typeof middleware !== 'function') {
    throw new Error('sandbox routes: auth middleware exports no recognizable shape (requireAuth/authenticateToken) — refusing to mount with auth disabled');
  }
  return middleware;
}
const requireAuth = resolveAuthMiddleware();

// ── ownership guard ────────────────────────────────────────────────────────
// 3H10 leftover: live sandbox handlers must not leak cross-user sessions.
const requestId = (req) => req.user?.id ?? req.userId ?? null;

function assertOwnedSession(req, res, sessionId) {
  if (!requestId(req)) {
    res.status(401).json({ ok: false, error: 'user_required' });
    return null;
  }
  const sess = sessionManager.getSession(sessionId);
  if (!sess) {
    res.status(404).json({ ok: false, error: 'session_not_found' });
    return null;
  }
  if (!sess.userId || String(sess.userId) !== String(requestId(req))) {
    res.status(403).json({ ok: false, error: 'forbidden' });
    return null;
  }
  return sess;
}

// ── POST /api/sandbox/session ───────────────────────────────────────────────
router.post('/session', requireAuth, async (req, res) => {
  try {
    const { r2Key, filename, meta = {} } = req.body || {};
    const userId = requestId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'user_required' });
    }

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
  const sess = assertOwnedSession(req, res, req.params.id);
  if (!sess) return;
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
  const sess = assertOwnedSession(req, res, req.params.id);
  if (!sess) return;
  const destroyed = sessionManager.destroySession(req.params.id);
  return res.json({ ok: destroyed, sessionId: req.params.id });
});

// ── POST /api/sandbox/session/:id/finalize ───────────────────────────────────
router.post('/session/:id/finalize', requireAuth, async (req, res) => {
  const sess = assertOwnedSession(req, res, req.params.id);
  if (!sess) return;

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
  const sess = assertOwnedSession(req, res, req.params.id);
  if (!sess) return;

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
module.exports.__resolveAuthMiddleware = resolveAuthMiddleware;
