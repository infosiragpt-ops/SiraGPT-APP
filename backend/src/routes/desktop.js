'use strict';

/**
 * F7.1 desktop session routes.
 *
 * Parallel to /api/agent-computer (live orch #484). This factory does
 * NOT send traffic to siragpt-computer-orchestrator.
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const {
  getDesktopSessionManager,
} = require('../services/desktop/session-manager');
const { DesktopProviderError } = require('../services/desktop/provider/DesktopProvider');
const { isGenericProvisionError } = require('../services/desktop/desktop-errors');

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
    const lease = await mgr.acquire(chatId, { chatId });
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
  return res.json(mgr.status(req.params.id));
});

router.post('/sessions/:id/heartbeat', authenticateToken, async (req, res) => {
  try {
    const lease = await getDesktopSessionManager().heartbeat(req.params.id);
    return res.json(lease);
  } catch (err) {
    return failDesktop(res, err);
  }
});

router.post('/sessions/:id/release', authenticateToken, async (req, res) => {
  try {
    const keepWarm = Boolean(req.body && req.body.keepWarm);
    const result = await getDesktopSessionManager().release(req.params.id, { keepWarm });
    return res.json(result);
  } catch (err) {
    return failDesktop(res, err);
  }
});

module.exports = {
  router,
};
