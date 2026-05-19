/**
 * request-logger — structured one-line JSON access log + request id.
 *
 * Emits a single JSON line per response with method, path, status,
 * duration, user id (if authenticated), request id, ip, user agent.
 * Generates `req.id` via crypto.randomUUID() if no upstream middleware
 * has set it (so this middleware can sit BEFORE body-parser without
 * depending on pino-http to mint the id).
 *
 * Designed for production log shippers — one event per response, JSON
 * encoded, no ANSI colors, never throws. Errors during logging are
 * silently swallowed so logging cannot break a request.
 */

'use strict';

const crypto = require('node:crypto');

function _safeUuid() {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* fall through */ }
  // Fallback for ancient Node — base16 from random bytes.
  return crypto.randomBytes(16).toString('hex');
}

function _clientIp(req) {
  try {
    if (req.ip) return String(req.ip);
    const xff = req.headers && req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    if (req.socket && req.socket.remoteAddress) return String(req.socket.remoteAddress);
  } catch { /* swallow */ }
  return '';
}

function _userId(req) {
  if (!req) return null;
  if (req.user && (req.user.id || req.user.userId)) {
    return String(req.user.id || req.user.userId);
  }
  return null;
}

function _emit(logger, payload) {
  if (typeof logger === 'function') {
    try { logger(payload); } catch { /* swallow */ }
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } catch { /* swallow */ }
}

/**
 * Build the middleware. Tests can inject a custom logger to capture
 * payloads without monkey-patching stdout.
 *
 * @param {object} [opts]
 * @param {Function} [opts.logger] - logger(payload) callback
 * @param {Function} [opts.now] - clock (defaults to Date.now)
 * @returns Express middleware (req, res, next)
 */
function buildRequestLogger(opts = {}) {
  const logger = typeof opts.logger === 'function' ? opts.logger : null;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  return function requestLogger(req, res, next) {
    const start = now();

    if (!req.id) {
      try { req.id = _safeUuid(); } catch { req.id = ''; }
    }

    let finished = false;
    function finalize() {
      if (finished) return;
      finished = true;
      const durMs = Math.max(0, now() - start);
      const payload = {
        ts: new Date().toISOString(),
        level: 'info',
        method: req.method || '',
        path: (req.originalUrl || req.url || '').split('?')[0],
        status: res.statusCode,
        durMs,
        userId: _userId(req),
        reqId: req.id ? String(req.id) : '',
        ip: _clientIp(req),
        ua: (req.headers && req.headers['user-agent']) ? String(req.headers['user-agent']) : '',
      };
      _emit(logger, payload);
    }

    res.on('finish', finalize);
    res.on('close', finalize);

    next();
  };
}

// Default export is a ready-to-mount middleware that writes to stdout.
const requestLogger = buildRequestLogger();

module.exports = requestLogger;
module.exports.buildRequestLogger = buildRequestLogger;
module.exports.default = requestLogger;
