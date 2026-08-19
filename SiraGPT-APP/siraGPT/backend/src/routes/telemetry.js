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
} = require('../services/client-event-log');

router.post('/error', express.json({ limit: '32kb' }), optionalAuth, async (req, res) => {
  const body = (req && req.body && typeof req.body === 'object') ? req.body : {};
  const event = sanitizeClientEvent(body, req);
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

  res.status(202).json({
    accepted: true,
    requestId: req.requestId || req.headers?.['x-request-id'] || null,
  });
});

module.exports = router;
