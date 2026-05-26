/**
 * scheduler-internal.js — internal status endpoint (no UI).
 *
 * Mount with:
 *   const { router, attachScheduler } = require('./routes/scheduler-internal');
 *   attachScheduler(scheduler);
 *   app.use('/internal/scheduler', router);
 *
 * Endpoint: GET /internal/scheduler/status -> JSON snapshot of registered jobs.
 *
 * Access is gated by a shared token. Set SCHEDULER_INTERNAL_TOKEN to require
 * `Authorization: Bearer <token>` on the request. If unset, the route is
 * available only on loopback addresses.
 */

'use strict';

const express = require('express');

let _scheduler = null;

function attachScheduler(scheduler) {
  _scheduler = scheduler;
}

const router = express.Router();

function isLoopback(req) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function authorize(req, res, next) {
  const token = process.env.SCHEDULER_INTERNAL_TOKEN;
  if (token) {
    const header = req.get('authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || match[1] !== token) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
  }
  if (!isLoopback(req)) return res.status(403).json({ error: 'forbidden' });
  return next();
}

router.get('/status', authorize, (req, res) => {
  if (!_scheduler) return res.status(503).json({ error: 'scheduler_not_attached' });
  return res.json(_scheduler.status());
});

module.exports = { router, attachScheduler };
