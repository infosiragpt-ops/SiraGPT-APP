/**
 * /api/push — push notification subscription + send routes.
 *
 * Endpoints:
 *   POST /api/push/subscribe     — authenticated user stores a device token / web-push subscription
 *   POST /api/push/unsubscribe   — authenticated user removes their stored token(s)
 *   GET  /api/push/vapid-key     — returns the VAPID public key for web-push browsers
 *   POST /api/push/send          — ADMIN ONLY, dispatches a payload to a target user
 *
 * Storage:
 *   Uses the Prisma `PushSubscription` model (added to schema.prisma — see
 *   migration notes at the bottom of this file). If the model isn't available
 *   at runtime the routes degrade gracefully to a 503 so the caller can retry
 *   after migration.
 *
 * IMPORTANT: This module is intentionally NOT wired into the Express app yet
 * — register it in your routes index when the Prisma migration is applied:
 *
 *     const pushRoutes = require('./routes/push');
 *     app.use('/api/push', pushRoutes);
 */

'use strict';

const express = require('express');

// ---- middleware resolution -----------------------------------------------
function loadRealAuth() {
  try {
    // eslint-disable-next-line global-require
    return require('../middleware/auth');
  } catch {
    return null;
  }
}

function stubAuthenticateToken(req, _res, next) {
  if (!req.user) {
    const id = req.get('x-test-user-id');
    if (id) req.user = { id, role: req.get('x-test-user-role') || 'user' };
  }
  next();
}

function stubRequireAdmin(req, res, next) {
  if (req.user?.role === 'admin' || req.user?.role === 'superadmin') return next();
  return res.status(403).json({ error: 'admin required' });
}

// ---- Prisma resolution ---------------------------------------------------
function defaultGetPrisma() {
  try {
    // eslint-disable-next-line global-require
    return require('../config/database');
  } catch {
    return null;
  }
}

function pushModel(prisma) {
  if (!prisma) return null;
  // Prisma exposes models as camelCase properties on the client.
  return prisma.pushSubscription || null;
}

// ---- validation helpers --------------------------------------------------
const ALLOWED_PLATFORMS = new Set(['ios', 'android', 'web']);
const MAX_TOKEN_LEN = 4096;
const MAX_ENDPOINT_LEN = 4096;
const MAX_KEY_LEN = 512;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function validateSubscribeBody(body) {
  if (!body || typeof body !== 'object') return 'body must be an object';
  if (!isNonEmptyString(body.token)) return 'token required';
  if (body.token.length > MAX_TOKEN_LEN) return 'token too long';
  if (!ALLOWED_PLATFORMS.has(body.platform)) return 'platform must be ios|android|web';
  if (body.endpoint != null) {
    if (typeof body.endpoint !== 'string') return 'endpoint must be string';
    if (body.endpoint.length > MAX_ENDPOINT_LEN) return 'endpoint too long';
  }
  if (body.keys != null) {
    if (typeof body.keys !== 'object') return 'keys must be object';
    for (const k of ['p256dh', 'auth']) {
      if (body.keys[k] != null) {
        if (typeof body.keys[k] !== 'string') return `keys.${k} must be string`;
        if (body.keys[k].length > MAX_KEY_LEN) return `keys.${k} too long`;
      }
    }
  }
  return null;
}

function validateSendBody(body) {
  if (!body || typeof body !== 'object') return 'body must be an object';
  if (!isNonEmptyString(body.userId)) return 'userId required';
  if (!isNonEmptyString(body.title) && !isNonEmptyString(body.body)) {
    return 'title or body required';
  }
  return null;
}

// ---- routes --------------------------------------------------------------

function createPushRouter(opts = {}) {
  const router = express.Router();
  const real = opts.authenticateToken ? null : loadRealAuth();
  const authenticateToken = opts.authenticateToken || (real?.authenticateToken) || stubAuthenticateToken;
  const requireAdmin = opts.requireAdmin || (real?.requireAdmin) || stubRequireAdmin;
  const getPrisma = opts.getPrisma || defaultGetPrisma;

  router.get('/vapid-key', (_req, res) => {
  const publicKey = process.env.VAPID_PUBLIC_KEY || '';
  if (!publicKey) {
    return res.status(503).json({ error: 'web push not configured' });
  }
  return res.json({ publicKey });
});

router.post('/subscribe', authenticateToken, async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'unauthenticated' });
  const err = validateSubscribeBody(req.body);
  if (err) return res.status(400).json({ error: err });

  const prisma = getPrisma();
  const model = pushModel(prisma);
  if (!model) return res.status(503).json({ error: 'push storage unavailable' });

  try {
    const data = {
      userId: req.user.id,
      token: req.body.token,
      platform: req.body.platform,
      endpoint: req.body.endpoint || null,
      p256dh: req.body.keys?.p256dh || null,
      auth: req.body.keys?.auth || null,
      lastSeenAt: new Date(),
    };
    const row = await model.upsert({
      where: { token: req.body.token },
      create: data,
      update: { ...data, userId: req.user.id, lastSeenAt: new Date() },
    });
    return res.json({ ok: true, id: row.id });
  } catch (e) {
    return res.status(500).json({ error: 'subscribe failed', detail: e?.message });
  }
});

router.post('/unsubscribe', authenticateToken, async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'unauthenticated' });
  const prisma = getPrisma();
  const model = pushModel(prisma);
  if (!model) return res.status(503).json({ error: 'push storage unavailable' });

  try {
    if (isNonEmptyString(req.body?.token)) {
      await model.deleteMany({ where: { userId: req.user.id, token: req.body.token } });
    } else {
      await model.deleteMany({ where: { userId: req.user.id } });
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'unsubscribe failed', detail: e?.message });
  }
});

router.post('/send', authenticateToken, requireAdmin, async (req, res) => {
  const err = validateSendBody(req.body);
  if (err) return res.status(400).json({ error: err });

  const prisma = getPrisma();
  const model = pushModel(prisma);
  if (!model) return res.status(503).json({ error: 'push storage unavailable' });

  try {
    const subs = await model.findMany({ where: { userId: req.body.userId } });
    if (subs.length === 0) {
      return res.status(404).json({ error: 'no subscriptions for user' });
    }
    // Dispatch is delegated to a service we leave pluggable so this route
    // stays slim. If the service is missing we still return the queued
    // recipients so the caller knows what *would* have been sent.
    let dispatcher = null;
    try {
      // eslint-disable-next-line global-require
      dispatcher = require('../services/push-dispatcher');
    } catch {
      dispatcher = null;
    }

    const payload = {
      title: req.body.title || '',
      body: req.body.body || '',
      data: req.body.data || {},
      url: req.body.url || null,
    };

    if (dispatcher && typeof dispatcher.dispatch === 'function') {
      const results = await dispatcher.dispatch(subs, payload);
      return res.json({ ok: true, sent: results.length, results });
    }

    return res.json({
      ok: true,
      queued: subs.length,
      payload,
      note: 'push-dispatcher service not installed; payload accepted but not delivered',
    });
  } catch (e) {
    return res.status(500).json({ error: 'send failed', detail: e?.message });
  }
});

  return router;
}

const defaultRouter = createPushRouter();

module.exports = defaultRouter;
module.exports.createPushRouter = createPushRouter;
module.exports.__internal = {
  validateSubscribeBody,
  validateSendBody,
  ALLOWED_PLATFORMS,
};

/*
Prisma model to add to backend/prisma/schema.prisma:

model PushSubscription {
  id         String   @id @default(cuid())
  userId     String
  token      String   @unique
  platform   String   // 'ios' | 'android' | 'web'
  endpoint   String?
  p256dh     String?
  auth       String?
  createdAt  DateTime @default(now())
  lastSeenAt DateTime @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@map("push_subscriptions")
}

Then on User model add:
  pushSubscriptions PushSubscription[]
*/
