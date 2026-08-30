'use strict';

/**
 * F7 desktop session routes + authenticated viewer WS attach.
 *
 * Parallel to /api/agent-computer (live computer orchestrator).
 * This factory does NOT send traffic to that orchestrator.
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const {
  getDesktopSessionManager,
} = require('../services/desktop/session-manager');
const { DesktopProviderError } = require('../services/desktop/provider/DesktopProvider');
const { isGenericProvisionError, DESKTOP_DISABLED_ES } = require('../services/desktop/desktop-errors');
const { attachDesktopWebSocketProxy } = require('../services/desktop/ws-proxy');

const router = express.Router();

function failDesktop(res, err) {
  const status = err && err.status ? err.status : 503;
  const message = String((err && (err.publicMessage || err.message)) || 'El escritorio no quedó listo.');
  return res.status(status).json({
    error: (err && err.code) || 'desktop_failed',
    message,
    poolWarm: getDesktopSessionManager().poolWarm(),
  });
}

function assertSessionOwner(req, rec) {
  const userId = req.user && req.user.id;
  if (!rec || !rec.userId || !userId || String(rec.userId) !== String(userId)) {
    const err = new DesktopProviderError('La sesión de escritorio no existe.', {
      code: 'desktop_session_not_found',
      status: 404,
    });
    throw err;
  }
}

router.get('/status', authenticateToken, (req, res) => {
  const mgr = getDesktopSessionManager();
  return res.json(mgr.publicStatus());
});

router.post('/sessions', authenticateToken, async (req, res) => {
  try {
    const mgr = getDesktopSessionManager();
    const chatId = String(
      (req.body && (req.body.conversationId || req.body.chatId))
      || (req.query && (req.query.conversationId || req.query.chatId))
      || '',
    ).trim();
    const userId = req.user && req.user.id;
    const lease = await mgr.acquire(chatId, { chatId, userId });
    if (isGenericProvisionError(lease.status)) {
      throw new DesktopProviderError(lease.status, { code: 'desktop_status_invalid', status: 500 });
    }
    return res.status(201).json(lease);
  } catch (err) {
    return failDesktop(res, err);
  }
});

router.get('/sessions/:id', authenticateToken, (req, res) => {
  const mgr = getDesktopSessionManager();
  const rec = mgr.getRecord(req.params.id);
  if (rec) {
    try { assertSessionOwner(req, rec); } catch (err) { return failDesktop(res, err); }
  }
  return res.json(mgr.status(req.params.id));
});

router.post('/sessions/:id/heartbeat', authenticateToken, async (req, res) => {
  try {
    const mgr = getDesktopSessionManager();
    const rec = mgr.getRecord(req.params.id);
    if (rec) assertSessionOwner(req, rec);
    const lease = await mgr.heartbeat(req.params.id);
    return res.json(lease);
  } catch (err) {
    return failDesktop(res, err);
  }
});

router.post('/sessions/:id/release', authenticateToken, async (req, res) => {
  try {
    const mgr = getDesktopSessionManager();
    const rec = mgr.getRecord(req.params.id);
    if (rec) assertSessionOwner(req, rec);
    const keepWarm = Boolean(req.body && req.body.keepWarm);
    const result = await mgr.release(req.params.id, { keepWarm });
    return res.json(result);
  } catch (err) {
    return failDesktop(res, err);
  }
});

router.post('/sessions/:id/input_mode', authenticateToken, (req, res) => {
  try {
    const mgr = getDesktopSessionManager();
    const rec = mgr.getRecord(req.params.id);
    if (rec) assertSessionOwner(req, rec);
    const mode = req.body && req.body.mode;
    return res.json(mgr.setInputMode(req.params.id, mode));
  } catch (err) {
    return failDesktop(res, err);
  }
});

function handleHandoff(req, res) {
  try {
    const mgr = getDesktopSessionManager();
    if (!mgr.enabled()) {
      return failDesktop(res, Object.assign(new Error(DESKTOP_DISABLED_ES), {
        code: 'desktop_disabled',
        status: 503,
      }));
    }
    const rec = mgr.getRecord(req.params.id);
    if (rec) assertSessionOwner(req, rec);
    const action = req.body && req.body.action;
    const reason = req.body && req.body.reason;
    const lease = mgr.applyHandoff(req.params.id, action, { reason, actor: 'user' });
    const fsm = mgr.getHandoff(req.params.id);
    const last = fsm && fsm.events.length ? fsm.events[fsm.events.length - 1] : null;
    return res.json({
      ...lease,
      event: last ? { type: last.type, at: last.at, reason: last.reason } : null,
    });
  } catch (err) {
    return failDesktop(res, err);
  }
}

router.post('/sessions/:id/handoff', authenticateToken, handleHandoff);
router.post('/session/:id/handoff', authenticateToken, handleHandoff);

function attachDesktopViewerProxy(server, opts = {}) {
  return attachDesktopWebSocketProxy(server, {
    getManager: () => getDesktopSessionManager(),
    env: opts.env || process.env,
    secret: opts.secret,
    ...opts,
  });
}

module.exports = {
  router,
  handleHandoff,
  attachDesktopWebSocketProxy: attachDesktopViewerProxy,
};
