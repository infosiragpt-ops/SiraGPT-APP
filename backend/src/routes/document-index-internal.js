'use strict';

// ──────────────────────────────────────────────────────────────────
// siraGPT — RAG document index internal router
// ──────────────────────────────────────────────────────────────────
// Mount with:
//   const docIndex = require('./routes/document-index-internal');
//   docIndex.attachStore(indexStore);
//   app.use('/internal/document-index', docIndex.router);
//
// Endpoints:
//   GET  /internal/document-index/stats   -> aggregated cache metrics
//   POST /internal/document-index/gc      -> trigger GC (returns removed)
//
// Access is gated by DOC_INDEX_INTERNAL_TOKEN bearer or loopback-only,
// matching the convention used by /internal/db.
// ──────────────────────────────────────────────────────────────────

const express = require('express');

let _store = null;
function attachStore(store) { _store = store; }

const router = express.Router();

function isLoopback(req) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function authorize(req, res, next) {
  const token = process.env.DOC_INDEX_INTERNAL_TOKEN;
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

router.get('/stats', authorize, async (req, res) => {
  if (!_store) {
    return res.status(503).json({ error: 'document_index_not_attached' });
  }
  try {
    const limit = clampInt(req.query.limit, 50, 1, 500);
    const out = await _store.stats({ limit });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: 'stats_failed', message: String(err && err.message || err) });
  }
});

router.post('/gc', authorize, express.json({ limit: '4kb' }), async (req, res) => {
  if (!_store) {
    return res.status(503).json({ error: 'document_index_not_attached' });
  }
  try {
    const ttlMs = req.body && Number(req.body.ttlMs);
    const out = await _store.gc(ttlMs > 0 ? { ttlMs } : {});
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: 'gc_failed', message: String(err && err.message || err) });
  }
});

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

module.exports = { router, attachStore };
