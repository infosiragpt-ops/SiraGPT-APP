'use strict';

const crypto = require('crypto');

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function extractBearer(req) {
  const h = String(req.headers.authorization || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : '';
}

function requireOrchSecret(secret) {
  return function orchAuth(req, res, next) {
    if (req.path === '/health' && req.method === 'GET') return next();
    if (!secret) {
      return res.status(503).json({ error: 'COMPUTER_ORCH_SECRET is not configured' });
    }
    const given = extractBearer(req);
    if (!given || !timingSafeEqualString(given, secret)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
  };
}

module.exports = { timingSafeEqualString, extractBearer, requireOrchSecret };
