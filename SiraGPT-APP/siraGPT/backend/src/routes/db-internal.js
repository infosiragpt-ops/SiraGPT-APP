'use strict';

// ──────────────────────────────────────────────────────────────
// siraGPT — Internal DB diagnostics router
// ──────────────────────────────────────────────────────────────
// Mount with:
//   const { router, attachSlowQueryLogger, attachPrisma } =
//     require('./routes/db-internal');
//   attachSlowQueryLogger(slowLogger);
//   attachPrisma(prisma);
//   app.use('/internal/db', router);
//
// Endpoints:
//   GET  /internal/db/slow-queries   -> top-N recent slow queries
//   POST /internal/db/explain        -> EXPLAIN plan for a query (non-prod)
//
// Access is gated by DB_INTERNAL_TOKEN bearer or loopback-only.
// ──────────────────────────────────────────────────────────────

const express = require('express');
const { explain, ExplainNotAllowedError, ExplainInvalidQueryError } = require('../db/explain');

let _slowLogger = null;
let _prisma = null;

function attachSlowQueryLogger(logger) { _slowLogger = logger; }
function attachPrisma(prisma) { _prisma = prisma; }

const router = express.Router();

function isLoopback(req) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function authorize(req, res, next) {
  const token = process.env.DB_INTERNAL_TOKEN;
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

router.get('/slow-queries', authorize, (req, res) => {
  if (!_slowLogger) return res.status(503).json({ error: 'slow_query_logger_not_attached' });
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 500));
  return res.json({
    stats: _slowLogger.getStats(),
    queries: _slowLogger.getSlowQueries(limit),
  });
});

router.post('/explain', authorize, express.json({ limit: '64kb' }), async (req, res) => {
  if (!_prisma) return res.status(503).json({ error: 'prisma_not_attached' });
  const { sql, params, options } = req.body || {};
  try {
    const result = await explain(_prisma, sql, Array.isArray(params) ? params : [], options || {});
    return res.json(result);
  } catch (err) {
    if (err instanceof ExplainNotAllowedError) return res.status(403).json({ error: err.code, message: err.message });
    if (err instanceof ExplainInvalidQueryError) return res.status(400).json({ error: err.code, message: err.message });
    return res.status(500).json({ error: 'explain_failed', message: String(err && err.message || err) });
  }
});

module.exports = {
  router,
  attachSlowQueryLogger,
  attachPrisma,
};
