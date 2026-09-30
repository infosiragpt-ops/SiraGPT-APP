'use strict';

/**
 * telemetry.js — front-end telemetry intake.
 *
 * Currently surfaces a single endpoint: `POST /api/telemetry/error`,
 * which receives error-boundary reports from the React app and forwards
 * them through the alerting pipeline at `info` severity (so they show
 * up in Slack but don't page anyone overnight).
 *
 * Best-effort: malformed payloads return 202 to avoid retry storms from
 * confused clients. Real validation lives in `alerting.js`.
 */

const express = require('express');
const router = express.Router();

const alerting = require('../services/alerting');
const prisma = require('../config/database');
const { optionalAuth } = require('../middleware/optionalAuth');
const { writeAuditLog } = require('../utils/audit-log');
const {
  sanitizeClientEvent,
  buildClientEventAuditEntry,
  isExpectedAuthClientEvent,
  isExpectedQuotaClientEvent,
  isExpectedConfigClientEvent,
  isEmptyClientEvent,
} = require('../services/client-event-log');

function accepted(req, res) {
  const responseBody = { accepted: true };
  const requestId = req.requestId || req.headers?.['x-request-id'] || null;
  if (requestId) responseBody.requestId = requestId;
  return res.status(202).json(responseBody);
}

router.post('/error', express.json({ limit: '32kb' }), optionalAuth, async (req, res) => {
  const body = (req && req.body && typeof req.body === 'object') ? req.body : {};
  // Nothing reported → nothing recorded. Still 202: the beacon never retries.
  if (isEmptyClientEvent(body)) return accepted(req, res);
  const event = sanitizeClientEvent(body, req);
  const expectedClientNoise = isExpectedAuthClientEvent(event)
    || isExpectedQuotaClientEvent(event)
    || isExpectedConfigClientEvent(event);
  if (!expectedClientNoise) {
    // Fire-and-forget — never block the client on alerting I/O.
    Promise.resolve().then(() => alerting.notifyFrontendError({
      page: event.page,
      message: event.message,
      stack: event.stack || '',
      userAgent: event.browser || '',
      userId: (req.user && req.user.id) || null,
    })).catch(() => {});

    Promise.resolve()
      .then(() => writeAuditLog(prisma, buildClientEventAuditEntry(event, req)))
      .catch(() => {});

    // «Errores del sistema»: browser crashes / render errors group into
    // issues next to the backend ones (API failures are captured server-side).
    Promise.resolve()
      .then(() => require('../services/observability/system-errors').captureFrontendEvent(event, req))
      .catch(() => {});
  }

  // Browser-side turn failure (stream error, no activity, empty close,
  // render crash on a chat): merge into the same «Fallos de respuesta» row
  // the server finalizer writes for that turn (chatId + idempotencyKey).
  if (body.turn && typeof body.turn === 'object' && req.user) {
    Promise.resolve()
      .then(() => require('../services/observability/turn-failures').recordClientSignal(body, req))
      .catch(() => {});
  }

  return accepted(req, res);
});

module.exports = router;
