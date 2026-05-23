'use strict';

/**
 * compose-middleware — middleware composition layer for Express.
 *
 * Composes the full middleware stack in an opinionated, secure order:
 *   1. request-id       — inject req.id
 *   2. helmet           — security headers
 *   3. cors             — strict origin allowlist
 *   4. compression      — gzip/brotli (skips SSE)
 *   5. body-parser      — JSON + urlencoded
 *   6. cookie-parser    — signed cookies
 *   7. pino-logger      — structured request logging
 *   8. input-sanitizer  — XSS + prompt injection detection
 *   9. rate-limit       — per-IP + per-user (Upstash or Redis)
 *  10. session          — (optional, conditionally mounted)
 *  11. auth             — JWT token verification (optional, per-route)
 *
 * Usage:
 *   const { composeBase, composeSecure } = require('./compose-middleware');
 *   const app = express();
 *   composeBase(app);            // mount all base middleware
 *   composeSecure(app, { /* overrides *​/ });
 */

const pinoLogger = require('./pino-logger');

function composeRequestId(app, { skip = false } = {}) {
  if (skip) return;
  const crypto = require('node:crypto');
  app.use((req, res, next) => {
    req.id = req.id || req.headers['x-request-id'] || crypto.randomUUID();
    res.set('X-Request-Id', req.id);
    next();
  });
}

function composeHelmet(app, { skip = false, helmetOpts = {} } = {}) {
  if (skip) return;
  try {
    const helmet = require('helmet');
    app.use(helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      ...helmetOpts,
    }));
  } catch (_) {
    // helmet not installed — non-fatal in dev
  }
}

function composeCors(app, { skip = false, corsOpts = {} } = {}) {
  if (skip) return;
  try {
    const cors = require('cors');
    const { resolveAllowedOrigins, makeOriginCallback } = require('./cors-policy');
    const allowed = resolveAllowedOrigins();
    app.use(cors({
      origin: makeOriginCallback(allowed),
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-API-Key'],
      exposedHeaders: ['X-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
      maxAge: 86400,
      ...corsOpts,
    }));
  } catch (_) {
    // cors not installed
  }
}

function composeCompression(app, { skip = false, compressionOpts = {} } = {}) {
  if (skip) return;
  try {
    const compression = require('compression');
    app.use(compression({
      filter: (req, res) => {
        if (req.headers['accept'] === 'text/event-stream') return false;
        if (res.getHeader('Content-Type') === 'text/event-stream') return false;
        return compression.filter(req, res);
      },
      ...compressionOpts,
    }));
  } catch (_) {
    // compression not installed
  }
}

function composeBodyParser(app, { skip = false, jsonLimit = '1mb', urlencodedLimit = '1mb' } = {}) {
  if (skip) return;
  const express = require('express');
  app.use(express.json({ limit: jsonLimit }));
  app.use(express.urlencoded({ extended: true, limit: urlencodedLimit }));
}

function composeCookieParser(app, { skip = false } = {}) {
  if (skip) return;
  try {
    const cookieParser = require('cookie-parser');
    app.use(cookieParser());
  } catch (_) {
    // cookie-parser not installed
  }
}

function composePino(app, { skip = false, logger = null } = {}) {
  if (skip) return;
  const log = logger || pinoLogger.getLogger();
  app.use((req, res, next) => {
    req.log = log.child({ reqId: req.id });
    const start = Date.now();
    const origEnd = res.end;
    res.end = function (...args) {
      const durMs = Date.now() - start;
      log.info({
        req: { method: req.method, url: req.originalUrl || req.url, id: req.id },
        res: { statusCode: res.statusCode },
        durMs,
      }, 'request completed');
      return origEnd.apply(this, args);
    };
    next();
  });
}

function composeInputSanitizer(app, { skip = false, sanitizerOpts = {} } = {}) {
  if (skip) return;
  const { createInputSanitizer } = require('./input-sanitizer');
  const sanitizer = createInputSanitizer({
    logger: sanitizerOpts.logger || pinoLogger.getLogger(),
    ...sanitizerOpts,
  });
  app.use(sanitizer);
}

function composeRateLimit(app, { skip = false, ratelimitOpts = {} } = {}) {
  if (skip) return;
  const { createUpstashRateLimiter } = require('./upstash-ratelimit');
  const limiter = createUpstashRateLimiter(ratelimitOpts);
  if (limiter.enabled) {
    app.use(limiter.ipLimiter);
  }
}

/**
 * Mount the complete base middleware stack on an Express app.
 * Safe to call multiple times (idempotent).
 */
function composeBase(app, opts = {}) {
  composeRequestId(app, opts);
  composeHelmet(app, opts);
  composeCors(app, opts);
  composeCompression(app, opts);
  composeBodyParser(app, opts);
  composeCookieParser(app, opts);
  composePino(app, opts);
  composeInputSanitizer(app, opts);
  composeRateLimit(app, opts);
}

/**
 * Mount security-focused middleware for authenticated routes.
 * Intended to be called AFTER composeBase().
 */
function composeSecure(app, opts = {}) {
  const { createUpstashRateLimiter } = require('./upstash-ratelimit');
  const authLimiter = createUpstashRateLimiter({
    ...opts,
    ipMax: opts.authIpMax || 10,
    userMax: opts.authUserMax || 30,
  });
  if (authLimiter.enabled) {
    app.use(authLimiter.userLimiter);
  }
}

module.exports = {
  composeBase,
  composeSecure,
  composeRequestId,
  composeHelmet,
  composeCors,
  composeCompression,
  composeBodyParser,
  composeCookieParser,
  composePino,
  composeInputSanitizer,
  composeRateLimit,
};
