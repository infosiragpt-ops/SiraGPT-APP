'use strict';

/**
 * sms-delivery — Ratchet 45.
 *
 * Bridge between the in-app Notification inbox (cycle 45, Task 1) and
 * Twilio's SMS API. Fan-out for `severity === 'critical'` rows where
 * the recipient user has opted-in by setting `User.phone`.
 *
 * Graceful degradation:
 *   - severity !== 'critical'           → skip (reason: 'not-critical')
 *   - no userId on the row              → skip (reason: 'no-user')
 *   - prisma has no `user` delegate     → skip (reason: 'no-model')
 *   - user has no `phone` column value  → skip (reason: 'no-phone')
 *   - TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN env missing → skip (reason: 'no-twilio-env')
 *   - `twilio` package is not installed → skip (reason: 'no-twilio-lib')
 *   - missing TWILIO_FROM_NUMBER and no TWILIO_MESSAGING_SERVICE_SID → skip (reason: 'no-twilio-sender')
 *   - any send error                    → log + return failed=1 (never throws)
 *
 * The function is fire-and-forget from the caller's POV.
 *
 * Required env:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_FROM_NUMBER          (E.164, e.g. "+15551234567")     OR
 *   TWILIO_MESSAGING_SERVICE_SID (preferred — handles routing for you)
 *
 * Public API:
 *   maybeDeliver(prisma, notification, opts?)
 *     → Promise<{ attempted, delivered, failed, skipped, reason? }>
 */

let _twilioModule;
let _twilioLoadAttempted;
let _twilioClient;

function _loadTwilio(logger) {
  if (_twilioLoadAttempted) return _twilioModule;
  _twilioLoadAttempted = true;
  try {
    // eslint-disable-next-line global-require
    _twilioModule = require('twilio');
  } catch (err) {
    logger?.info?.(`[sms-delivery] twilio not installed, skipping (${err?.message || err})`);
    _twilioModule = null;
  }
  return _twilioModule;
}

function _getClient(twilio, logger) {
  if (_twilioClient) return _twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  try {
    _twilioClient = typeof twilio === 'function' ? twilio(sid, token) : twilio.default?.(sid, token);
  } catch (err) {
    logger?.warn?.(`[sms-delivery] twilio() init failed: ${err?.message || err}`);
    return null;
  }
  return _twilioClient;
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

const MAX_SMS_LEN = 480; // 3 concatenated GSM-7 segments worth.

function _buildBody(notification) {
  const title = (notification.title || 'Notification').trim();
  const msg = (notification.message || '').trim();
  const combined = msg ? `${title}: ${msg}` : title;
  return combined.length > MAX_SMS_LEN ? `${combined.slice(0, MAX_SMS_LEN - 1)}…` : combined;
}

/**
 * Deliver a Notification via SMS when severity === 'critical' AND the
 * recipient has `User.phone` set AND Twilio is configured.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ userId: string, severity: string, title?: string, message?: string,
 *           id?: string, type?: string, metadata?: any }} notification
 * @param {{ logger?: { info: Function, warn: Function, error: Function },
 *           twilio?: any }} [opts]
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
  if (!prisma?.user?.findUnique) {
    return { attempted: 0, delivered: 0, failed: 0, skipped: true, reason: 'no-model' };
  }

  let phone = null;
  try {
    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true },
    });
    phone = row?.phone || null;
  } catch (err) {
    logger.warn?.(`[sms-delivery] user lookup failed: ${err?.message || err}`);
    return { attempted: 0, delivered: 0, failed: 0, skipped: true, reason: 'lookup-failed' };
  }
  if (!phone) {
    return { attempted: 0, delivered: 0, failed: 0, skipped: true, reason: 'no-phone' };
  }

  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    return { attempted: 0, delivered: 0, failed: 0, skipped: true, reason: 'no-twilio-env' };
  }

  const from = process.env.TWILIO_FROM_NUMBER || null;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID || null;
  if (!from && !messagingServiceSid) {
    return { attempted: 0, delivered: 0, failed: 0, skipped: true, reason: 'no-twilio-sender' };
  }

  const twilio = opts.twilio || _loadTwilio(logger);
  if (!twilio) {
    return { attempted: 0, delivered: 0, failed: 0, skipped: true, reason: 'no-twilio-lib' };
  }
  const client = opts.client || _getClient(twilio, logger);
  if (!client?.messages?.create) {
    return { attempted: 0, delivered: 0, failed: 0, skipped: true, reason: 'no-twilio-client' };
  }

  const body = _buildBody(notification);
  const payload = messagingServiceSid
    ? { to: phone, body, messagingServiceSid }
    : { to: phone, body, from };

  try {
    await client.messages.create(payload);
    _bumpCounter('siragpt_sms_critical_delivered_total');
    return { attempted: 1, delivered: 1, failed: 0, skipped: false };
  } catch (err) {
    _bumpCounter('siragpt_sms_critical_failed_total');
    logger.warn?.(`[sms-delivery] send failed for user ${userId}: ${err?.message || err}`);
    return { attempted: 1, delivered: 0, failed: 1, skipped: false, reason: 'send-failed' };
  }
}

function _resetForTests() {
  _twilioModule = undefined;
  _twilioLoadAttempted = false;
  _twilioClient = undefined;
}

module.exports = {
  maybeDeliver,
  _resetForTests,
};
