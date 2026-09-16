'use strict';

/**
 * RLCD — calibrated decisions. Read-only telemetry: every authenticated
 * caller sees the headline calibration per decision kind; admins get the
 * reliability bins, outcome mix and lane counters.
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const rlcd = require('../services/rlcd');

const router = express.Router();

router.get('/stats', authenticateToken, (req, res) => {
  const isAdmin = Boolean(req.user && (req.user.isAdmin || req.user.isSuperAdmin));
  res.set('Cache-Control', 'no-store');
  return res.json({ ok: true, ...rlcd.stats({ admin: isAdmin }) });
});

module.exports = router;
