'use strict';

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const apps = require('../services/apps');
const appPins = require('../services/apps/pins');

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
    pinsEnabled: appPins.PINS_ENABLED,
  });
});

async function listDirectOAuthProviderConnections(db, userId) {
  if (!db || !userId) return [];
  const uid = String(userId);
  const out = [];
  try {
    const userRow = db.user?.findUnique
      ? await db.user.findUnique({
        where: { id: uid },
        select: { gmailTokens: true, googleServicesTokens: true, spotifyTokens: true },
      })
      : null;
    if (userRow?.gmailTokens) {
      out.push({ app: 'gmail', status: 'connected', auth: 'oauth2' });
    }
    if (userRow?.googleServicesTokens) {
      out.push({ app: 'googledrive', status: 'connected', auth: 'oauth2' });
      out.push({ app: 'googlecalendar', status: 'connected', auth: 'oauth2' });
    }
    if (userRow?.spotifyTokens) {
      out.push({ app: 'spotify', status: 'connected', auth: 'oauth2' });
    }
  } catch { /* optional columns / test stubs */ }

  try {
    if (db.socialConnection?.findMany) {
      const fbRows = await db.socialConnection.findMany({
        where: { userId: uid, platform: 'facebook' },
        select: { id: true, expiresAt: true },
      });
      if (Array.isArray(fbRows) && fbRows.length > 0) {
        const expired = fbRows[0].expiresAt && new Date(fbRows[0].expiresAt).getTime() < Date.now();
        out.push({ app: 'facebook', status: expired ? 'expired' : 'connected', auth: 'oauth2' });
      }
    }
  } catch { /* ignore */ }

  try {
    if (db.slackIntegration?.findFirst) {
      const slack = await db.slackIntegration.findFirst({
        where: { userId: uid, isActive: true },
        select: { id: true },
      });
      if (slack?.id) {
        out.push({ app: 'slack', status: 'connected', auth: 'webhook' });
      }
    }
  } catch { /* ignore */ }

  return out;
}

router.get('/connections', authenticateToken, async (req, res) => {
  try {
    const [vaultConnections, directConnections] = await Promise.all([
      apps.listUserApps(prisma, req.user.id, {
        probe: String(req.query.probe || '') === '0' ? false : undefined,
      }),
      listDirectOAuthProviderConnections(prisma, req.user.id),
    ]);
    const seen = new Set((vaultConnections || []).map((c) => c && c.app).filter(Boolean));
    const merged = [...(vaultConnections || [])];
    for (const item of directConnections) {
      if (!seen.has(item.app)) {
        seen.add(item.app);
        merged.push(item);
      }
    }
    return res.json({ connections: merged });
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

async function disconnectDirectOAuthProvider(db, userId, rawAppId) {
  if (!db || !userId) return null;
  const rawId = String(rawAppId || '').trim().toLowerCase();
  if (rawId === 'gmail' && db.user?.update) {
    await db.user.update({ where: { id: userId }, data: { gmailTokens: null } });
    return { ok: true, app: 'gmail', disconnected: true };
  }
  if ((rawId === 'googledrive' || rawId === 'google-drive' || rawId === 'googlecalendar' || rawId === 'google-calendar') && db.user?.update) {
    await db.user.update({ where: { id: userId }, data: { googleServicesTokens: null } });
    return { ok: true, app: rawId, disconnected: true };
  }
  if (rawId === 'spotify' && db.user?.update) {
    await db.user.update({ where: { id: userId }, data: { spotifyTokens: null } });
    return { ok: true, app: 'spotify', disconnected: true };
  }
  if (rawId === 'facebook' && db.socialConnection?.deleteMany) {
    await db.socialConnection.deleteMany({ where: { userId, platform: 'facebook' } });
    return { ok: true, app: 'facebook', disconnected: true };
  }
  if (rawId === 'slack' && db.slackIntegration?.deleteMany) {
    await db.slackIntegration.deleteMany({ where: { userId } });
    return { ok: true, app: 'slack', disconnected: true };
  }
  return null;
}

router.delete('/connections/:appId', authenticateToken, async (req, res) => {
  try {
    const directResult = await disconnectDirectOAuthProvider(prisma, req.user.id, req.params.appId);
    if (directResult) {
      return res.json(directResult);
    }
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

router.listDirectOAuthProviderConnections = listDirectOAuthProviderConnections;
router.disconnectDirectOAuthProvider = disconnectDirectOAuthProvider;

module.exports = router;
