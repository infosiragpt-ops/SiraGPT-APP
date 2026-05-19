'use strict';

/**
 * /api/webhooks — user-managed outbound webhook subscriptions.
 *
 *   POST   /api/webhooks/endpoints     { url, events: string[] }       → 201
 *   GET    /api/webhooks/endpoints                                     → { endpoints }
 *   DELETE /api/webhooks/endpoints/:id                                 → { ok: true }
 *   GET    /api/webhooks/triggers                                      → { triggers }
 *
 * Each endpoint gets a freshly generated HMAC secret on create — the
 * caller MUST capture it from the create response because the GET
 * listing redacts it.
 */

const express = require('express');
const crypto = require('crypto');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const triggers = require('../services/trigger-registry');

const router = express.Router();

// ── Per-user webhook endpoint cap by plan (ratchet 45, Task 1) ──────
// Caps the number of WebhookEndpoint rows a single user (userId set,
// organizationId NULL) may keep. Org-scoped endpoints use the org plan
// cap and are NOT counted here. ENTERPRISE is unlimited (Infinity).
//
//   FREE       →  2 endpoints
//   PRO        → 10 endpoints
//   PRO_MAX    → 25 endpoints
//   ENTERPRISE → unlimited
//
// On overflow POST /endpoints returns 402 Payment Required with
// `{ plan, cap, used, error: 'webhook-endpoint-cap-reached' }`.
const PLAN_USER_WEBHOOK_CAPS = Object.freeze({
  FREE: 2,
  PRO: 10,
  PRO_MAX: 25,
  ENTERPRISE: Infinity,
});

function userWebhookCapForPlan(plan) {
  const cap = PLAN_USER_WEBHOOK_CAPS[plan];
  return typeof cap === 'number' ? cap : PLAN_USER_WEBHOOK_CAPS.FREE;
}

function genSecret() {
  return 'whk_' + crypto.randomBytes(24).toString('hex');
}

function redactSecret(secret) {
  if (!secret || typeof secret !== 'string') return null;
  if (secret.length < 12) return '••••';
  return `${secret.slice(0, 8)}…${secret.slice(-4)}`;
}

function serializeEndpoint(ep, { includeSecret = false } = {}) {
  return {
    id: ep.id,
    url: ep.url,
    events: Array.isArray(ep.events) ? ep.events : [],
    secret: includeSecret ? ep.secret : redactSecret(ep.secret),
    isActive: ep.isActive,
    createdAt: ep.createdAt instanceof Date ? ep.createdAt.toISOString() : ep.createdAt,
    lastDeliveryAt: ep.lastDeliveryAt
      ? (ep.lastDeliveryAt instanceof Date ? ep.lastDeliveryAt.toISOString() : ep.lastDeliveryAt)
      : null,
  };
}

function validateUrl(url) {
  if (typeof url !== 'string' || !url) return 'url required';
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'url must be http(s)';
    return null;
  } catch {
    return 'url is not a valid URL';
  }
}

function validateEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return 'events must be a non-empty array';
  for (const e of events) {
    if (typeof e !== 'string') return 'events must be strings';
    if (e !== '*' && !triggers.isKnownTrigger(e)) return `unknown event: ${e}`;
  }
  return null;
}

router.get('/triggers', authenticateToken, (req, res) => {
  res.json({ triggers: triggers.TRIGGERS });
});

router.post('/endpoints', authenticateToken, async (req, res) => {
  const { url, events } = req.body || {};
  const urlErr = validateUrl(url);
  if (urlErr) return res.status(400).json({ error: urlErr });
  const eventsErr = validateEvents(events);
  if (eventsErr) return res.status(400).json({ error: eventsErr });

  try {
    // Plan cap — count personal (non-org-scoped) endpoints only. Org
    // endpoints live on a separate quota tied to the org plan.
    const plan = (req.user && req.user.plan) || 'FREE';
    const cap = userWebhookCapForPlan(plan);
    if (Number.isFinite(cap)) {
      const used = await prisma.webhookEndpoint.count({
        where: { userId: req.user.id, organizationId: null },
      });
      if (used >= cap) {
        return res.status(402).json({
          error: 'webhook-endpoint-cap-reached',
          plan,
          cap,
          used,
          upgradeRequired: plan === 'FREE' || plan === 'PRO' || plan === 'PRO_MAX',
        });
      }
    }

    const secret = genSecret();
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        userId: req.user.id,
        url,
        events,
        secret,
        isActive: true,
      },
    });
    return res.status(201).json({ endpoint: serializeEndpoint(endpoint, { includeSecret: true }) });
  } catch (err) {
    console.error('[webhooks] create endpoint failed:', err.message);
    return res.status(500).json({ error: 'failed to create endpoint' });
  }
});

// Ratchet 45 (Task 1) — paginated. Supports ?page=&limit= with
// default limit=50, max=200. Response shape mirrors the cycle 118
// api-keys listing: `{ items, total, page, pages, endpoints }`. The
// legacy `endpoints` field is preserved for back-compat with older
// clients (the redacted-secret view is unchanged).
router.get('/endpoints', authenticateToken, async (req, res) => {
  try {
    const rawLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 200)
      : 50;
    const rawPage = Number.parseInt(req.query.page, 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

    const where = { userId: req.user.id };
    const total = await prisma.webhookEndpoint.count({ where });
    const pages = total === 0 ? 0 : Math.ceil(total / limit);
    const rows = await prisma.webhookEndpoint.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const items = rows.map((r) => serializeEndpoint(r));
    res.json({ items, total, page, pages, endpoints: items });
  } catch (err) {
    console.error('[webhooks] list endpoints failed:', err.message);
    res.status(500).json({ error: 'failed to list endpoints' });
  }
});

router.delete('/endpoints/:id', authenticateToken, async (req, res) => {
  try {
    const deleted = await prisma.webhookEndpoint.deleteMany({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (deleted.count === 0) return res.status(404).json({ error: 'endpoint not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[webhooks] delete endpoint failed:', err.message);
    res.status(500).json({ error: 'failed to delete endpoint' });
  }
});

module.exports = router;
