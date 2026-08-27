'use strict';

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const apps = require('../services/apps');
const appsOAuth = require('../services/apps/oauth');
const {
  isOAuthStateInfrastructureError,
  sendOAuthStateUnavailable,
} = require('../services/auth/oauth-state-http');

const router = express.Router();

function sendError(res, error, fallback = 500) {
  const status = Number(error?.status) || fallback;
  return res.status(status).json({
    error: error?.code || 'app_error',
    message: error?.message || 'Error de apps',
  });
}

router.get('/', (_req, res) => {
  return res.json({
    apps: apps.listManifests().map((app) => apps.publicManifest(app)),
  });
});

router.get('/oauth/:appId/callback', async (req, res) => {
  const appId = apps.normalizeAppId(req.params.appId);
  if (!appsOAuth.FILE_APP_IDS.includes(appId)) {
    return res.status(400).json({ error: 'App OAuth desconocida' });
  }
  if (req.query.error) return res.redirect(appsOAuth.postCallbackUrl(appId, 'denied'));
  if (!req.query.code || !req.query.state) {
    return res.redirect(appsOAuth.postCallbackUrl(appId, 'invalid'));
  }
  try {
    const result = await appsOAuth.completeAuthorization({
      appId,
      code: String(req.query.code),
      state: String(req.query.state),
      prisma,
    });
    await apps.auditAppEvent(prisma, {
      userId: result.userId,
      action: 'app_connected',
      appId,
      connectionId: result.connection.id,
    });
    return res.redirect(appsOAuth.postCallbackUrl(appId, 'connected'));
  } catch (error) {
    if (isOAuthStateInfrastructureError(error)) {
      return sendOAuthStateUnavailable(res, { provider: `app_${appId}`, error });
    }
    console.warn(`[apps] ${appId} OAuth callback failed:`, error?.code || error?.message);
    return res.redirect(appsOAuth.postCallbackUrl(appId, 'error'));
  }
});

router.get('/connect/:appId', authenticateToken, async (req, res) => {
  const appId = apps.normalizeAppId(req.params.appId);
  if (!appsOAuth.FILE_APP_IDS.includes(appId)) {
    return res.status(400).json({ error: 'App OAuth desconocida' });
  }
  try {
    const authorization = await appsOAuth.beginAuthorization({
      userId: req.user.id,
      appId,
    });
    if (String(req.query.redirect || '') === '1') return res.redirect(authorization.url);
    return res.json(authorization);
  } catch (error) {
    if (error?.code === 'APP_PROVIDER_NOT_CONFIGURED') {
      return res.status(503).json({
        error: 'Faltan las credenciales OAuth en el servidor.',
        message: error.message || 'Faltan las credenciales OAuth en el servidor.',
        code: 'social_provider_not_configured',
      });
    }
    if (isOAuthStateInfrastructureError(error)) {
      return sendOAuthStateUnavailable(res, { provider: `app_${appId}`, error });
    }
    return sendError(res, error);
  }
});

router.get('/connections', authenticateToken, async (req, res) => {
  try {
    const connections = await apps.listUserApps(prisma, req.user.id, {
      probe: String(req.query.probe || '') === '0' ? false : undefined,
    });
    return res.json({ connections });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/connections/:appId', authenticateToken, async (req, res) => {
  try {
    await apps.syncFromExisting(prisma, req.user.id);
    const row = await apps.findByUserAndApp(prisma, req.user.id, req.params.appId);
    if (!row) return res.status(404).json({ error: 'not_connected', connected: false });
    return res.json({ connection: apps.publicConnection(row) });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/connections/:appId/health', authenticateToken, async (req, res) => {
  try {
    await apps.syncFromExisting(prisma, req.user.id);
    const connection = await apps.probeHealth(prisma, {
      userId: req.user.id,
      appId: req.params.appId,
    });
    return res.json({ connection: apps.publicConnection(connection) });
  } catch (error) {
    return sendError(res, error);
  }
});

router.delete('/connections/:appId', authenticateToken, async (req, res) => {
  try {
    const result = await apps.disconnectApp(prisma, {
      userId: req.user.id,
      appId: req.params.appId,
      req,
    });
    return res.json(result);
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/tools/execute', authenticateToken, async (req, res) => {
  try {
    const result = await apps.executeTool(prisma, {
      userId: req.user.id,
      toolName: req.body?.tool || req.body?.name,
      args: req.body?.args || {},
      approved: req.body?.approved === true,
      req,
    });
    return res.status(result.ok ? 200 : 409).json(result);
  } catch (error) {
    return sendError(res, error);
  }
});

module.exports = router;
