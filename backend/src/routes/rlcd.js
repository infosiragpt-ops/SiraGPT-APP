'use strict';

/**
 * RLCD — calibrated decisions. Read-only telemetry: every authenticated
 * caller sees the headline calibration per decision kind; admins get the
 * reliability bins, outcome mix, lane counters, effective configuration,
 * persistence status and the recent-decisions ring, plus a manual flush.
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const rlcd = require('../services/rlcd');

const router = express.Router();

function isAdmin(req) {
  return Boolean(req.user && (req.user.isAdmin || req.user.isSuperAdmin));
}

router.get('/stats', authenticateToken, (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json({ ok: true, ...rlcd.stats({ admin: isAdmin(req) }) });
});

router.get('/decisions', authenticateToken, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'admin_required' });
  res.set('Cache-Control', 'no-store');
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const kind = req.query.kind ? String(req.query.kind).slice(0, 40) : null;
  return res.json({ ok: true, decisions: rlcd.recentDecisions({ limit, kind }) });
});

router.post('/persist', authenticateToken, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'admin_required' });
  try {
    // eslint-disable-next-line global-require
    const prisma = require('../config/database');
    const out = await rlcd.persistence.save({ prisma, force: true });
    return res.status(out.ok ? 200 : 503).json({ ok: out.ok, ...out, status: rlcd.persistence.status() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err && err.message) });
  }
});

module.exports = router;
