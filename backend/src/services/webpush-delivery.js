'use strict';

/**
 * webpush-delivery — ratchet 45, Task 2.
 *
 * Bridge between the in-app Notification inbox (cycle 45, Task 1) and
 * the web-push subscription store (cycle 22 — `PushSubscription`).
 *
 * Whenever a Notification row is created with `severity === 'critical'`
 * we ALSO try to deliver it to every web-push subscription the user
 * owns. The delivery is fire-and-forget from the caller's POV — any
 * error (missing `web-push` lib, missing VAPID keys, expired
 * subscription, network failure) is logged but never bubbles out.
 *
 * Graceful degradation (each reason is logged ONCE per process, never per
 * notification — web push is optional and "off" is a state, not a failure):
 *   - If VAPID env vars are missing    → skip without loading `web-push`
 *                                        (one debug line).
 *   - If VAPID is set but `web-push` is not installed → skip (one warn line:
 *                                        that is a real misconfiguration).
 *   - If the user has zero subs        → no-op, returns 0.
 *   - If a single send fails with 404/410 (Gone) → delete the dead
 *     subscription row so the inbox isn't penalised for it forever.
 *
 * Required env:
 *   VAPID_PUBLIC_KEY
 *   VAPID_PRIVATE_KEY
 *   VAPID_SUBJECT  (mailto:..., defaults to "mailto:admin@siragpt.local")
 *
 * Public API:
 *   maybeDeliver(prisma, notification, opts?)
 *     → Promise<{ attempted, delivered, failed, skipped, reason? }>
 *
 *   The function is safe to call for ANY severity — it short-circuits
 *   immediately when severity !== 'critical' so callers don't have to
 *   branch.
 */

let _webPushModule;        // cached require('web-push')
let _webPushLoadAttempted; // so we only try the require once per process
let _webPushConfigured;
const _announced = new Set(); // skip reasons already logged by this process

function _announceOnce(reason, logger, level, message) {
  if (_announced.has(reason)) return;
  _announced.add(reason);
  logger?.[level]?.(message);
}

function _vapidFromEnv() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: process.env.VAPID_SUBJECT || 'mailto:admin@siragpt.local' };
}

// eslint-disable-next-line global-require
const _requireWebPush = () => require('web-push');

function _loadWebPush(logger, load = _requireWebPush) {
  if (_webPushLoadAttempted) return _webPushModule;
  _webPushLoadAttempted = true;
  try {
    _webPushModule = load();
  } catch (err) {
    _webPushModule = null;
    // Only the error code: the message carries the require stack and paths.
    _announceOnce('no-webpush-lib', logger, 'warn',
      `[webpush-delivery] VAPID keys are set but the web-push package cannot be loaded (${err?.code || 'load error'}); critical notifications stay in the in-app inbox`);
  }
  return _webPushModule;
}

function _configure(webpush, vapid, logger) {
  if (_webPushConfigured) return true;
  try {
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
    _webPushConfigured = true;
    return true;
  } catch {
    _announceOnce('vapid-invalid', logger, 'warn',
      '[webpush-delivery] setVapidDetails rejected the VAPID configuration; critical notifications stay in the in-app inbox');
    return false;
  }
}

function _bumpCounter(name, delta = 1) {
  if (!delta) return;
  try {
    // eslint-disable-next-line global-require
    const metrics = require('../utils/metrics');
    if (metrics && typeof metrics.counter === 'function') {
      metrics.counter(name, {}, delta);
    }
  } catch { /* metrics best-effort */ }
}

function _buildPayload(notification) {
  return JSON.stringify({
    id: notification.id || null,
    title: notification.title || 'Notification',
    body: notification.message || '',
    severity: notification.severity || 'info',
    type: notification.type || null,
    createdAt: notification.createdAt
      ? new Date(notification.createdAt).toISOString()
      : new Date().toISOString(),
    metadata: notification.metadata || null,
  });
}

function _toSubscriptionObject(row) {
  // The PushSubscription model stores p256dh/auth + endpoint. The
  // web-push lib expects { endpoint, keys: { p256dh, auth } }. Native
  // (iOS / Android) tokens have no endpoint and are skipped here —
  // they need a separate APNs/FCM dispatcher.
  if (!row?.endpoint || !row.p256dh || !row.auth) return null;
  return {
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
  };
}

/**
 * Deliver a Notification to every browser-capable PushSubscription the
 * user owns, but only when severity === 'critical'.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ userId: string, severity: string, title?: string, message?: string,
 *           id?: string, type?: string, metadata?: any, createdAt?: any }} notification
 * @param {{ logger?: { debug?: Function, info: Function, warn: Function, error: Function },
 *           webpush?: any, loadWebPush?: () => any }} [opts]
 */
async function maybeDeliver(prisma, notification, opts = {}) {
  const logger = opts.logger || console;
  if (!notification || notification.severity !== 'critical') {
    return { attempted: 0, delivered: 0, failed: 0, skipped: true, reason: 'not-critical' };
  }
  const userId = notification.userId;
  if (!userId) {
    return { attempted: 0, delivered: 0, failed: 0, skipped: true, reason: 'no-user' };
  }
  if (!prisma?.pushSubscription) {
    return { attempted: 0, delivered: 0, failed: 0, skipped: true, reason: 'no-model' };
  }

  const vapid = _vapidFromEnv();
  if (!vapid) {
    _announceOnce('no-vapid', logger, 'debug',
      '[webpush-delivery] web push not configured (VAPID keys missing); critical notifications stay in the in-app inbox');
    return { attempted: 0, delivered: 0, failed: 0, skipped: true, reason: 'no-vapid' };
  }
  const webpush = opts.webpush || _loadWebPush(logger, opts.loadWebPush);
  if (!webpush) {
    return { attempted: 0, delivered: 0, failed: 0, skipped: true, reason: 'no-webpush-lib' };
  }
  if (!_configure(webpush, vapid, logger)) {
    return { attempted: 0, delivered: 0, failed: 0, skipped: true, reason: 'no-vapid' };
  }

  let subs = [];
  try {
    subs = await prisma.pushSubscription.findMany({ where: { userId } });
  } catch (err) {
    logger.warn?.(`[webpush-delivery] findMany failed: ${err?.message || err}`);
    return { attempted: 0, delivered: 0, failed: 0, skipped: true, reason: 'lookup-failed' };
  }

  const browserSubs = subs
    .filter((s) => s.platform === 'web' || _toSubscriptionObject(s))
    .map((s) => ({ row: s, sub: _toSubscriptionObject(s) }))
    .filter((x) => x.sub);

  if (browserSubs.length === 0) {
    return { attempted: 0, delivered: 0, failed: 0, skipped: false, reason: 'no-subs' };
  }

  const payload = _buildPayload(notification);
  let delivered = 0;
  let failed = 0;

  await Promise.all(
    browserSubs.map(async ({ row, sub }) => {
      try {
        await webpush.sendNotification(sub, payload);
        delivered += 1;
      } catch (err) {
        failed += 1;
        const status = err?.statusCode;
        if (status === 404 || status === 410) {
          // Gone — drop the dead subscription row.
          try {
            await prisma.pushSubscription.delete({ where: { id: row.id } });
            _bumpCounter('siragpt_push_subscriptions_pruned_total');
          } catch (delErr) {
            logger.warn?.(`[webpush-delivery] failed to delete dead sub ${row.id}: ${delErr?.message || delErr}`);
          }
        } else {
          logger.warn?.(`[webpush-delivery] send failed for ${row.id}: ${err?.message || err}`);
        }
      }
    }),
  );

  _bumpCounter('siragpt_webpush_critical_delivered_total', delivered);
  if (failed) _bumpCounter('siragpt_webpush_critical_failed_total', failed);

  return {
    attempted: browserSubs.length,
    delivered,
    failed,
    skipped: false,
  };
}

function _resetForTests() {
  _webPushModule = undefined;
  _webPushLoadAttempted = false;
  _webPushConfigured = false;
  _announced.clear();
}

module.exports = {
  maybeDeliver,
  _resetForTests,
};
