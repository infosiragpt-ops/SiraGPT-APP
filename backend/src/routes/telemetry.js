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

router.post('/error', express.json({ limit: '32kb' }), async (req, res) => {
  const body = (req && req.body && typeof req.body === 'object') ? req.body : {};
  // Fire-and-forget — never block the client on alerting I/O.
  Promise.resolve().then(() => alerting.notifyFrontendError({
    page: body.page || body.url || 'unknown',
    message: body.message || body.error || '',
    stack: body.stack || '',
    userAgent: req.headers['user-agent'] || '',
    userId: (req.user && req.user.id) || null,
  })).catch(() => {});
  res.status(202).json({ accepted: true });
});

module.exports = router;
