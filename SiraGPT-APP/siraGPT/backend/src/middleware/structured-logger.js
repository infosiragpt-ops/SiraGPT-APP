'use strict';

let _pino = null;
let _pinoHttp = null;
let _logger = null;

function initPino(opts = {}) {
  if (_logger) return _logger;
  try {
    _pino = require('pino');
    _pinoHttp = require('pino-http');
  } catch (_) {
    _logger = console;
    return _logger;
  }

  const level = process.env.LOG_LEVEL || process.env.SIRAGPT_LOG_LEVEL || 'info';
  const prettyPrint = process.env.NODE_ENV !== 'production' || process.env.SIRAGPT_LOG_PRETTY === '1';

  const config = {
    level,
    ...opts,
  };

  if (prettyPrint) {
    try {
      config.transport = { target: 'pino-pretty', options: { colorize: true } };
    } catch (_) {}
  }

  _logger = _pino(config);
  return _logger;
}

function getLogger() {
  return _logger || initPino();
}

function createPinoMiddleware(opts = {}) {
  const logger = getLogger();
  if (!_pinoHttp) return (req, res, next) => next();

  const pinoMiddleware = _pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => req.url?.startsWith('/api/health') || req.url?.startsWith('/_next'),
    },
    serializers: {
      req: (req) => ({
        method: req.method,
        url: req.url,
        path: req.route?.path || req.path,
        parameters: req.params,
        headers: { 'user-agent': req.headers?.['user-agent'], 'x-forwarded-for': req.headers?.['x-forwarded-for'] },
      }),
      res: (res) => ({
        statusCode: res.statusCode,
        contentLength: res.getHeader?.('content-length'),
      }),
    },
    ...opts,
  });

  return pinoMiddleware;
}

function sentryCaptureError(err, req, context = {}) {
  try {
    if (!process.env.SENTRY_DSN) return;
    const Sentry = require('@sentry/node');
    if (Sentry.isInitialized?.() || true) {
      Sentry.withScope(scope => {
        if (req) {
          scope.setTag('method', req.method);
          scope.setTag('path', req.path || req.url);
        }
        if (context.userId) scope.setUser({ id: String(context.userId) });
        scope.setExtras(context);
        Sentry.captureException(err);
      });
    }
  } catch (captureErr) {
    try { console.warn('[sentry] capture failed:', captureErr.message); } catch (_) {}
  }
}

function initSentry(opts = {}) {
  const dsn = process.env.SENTRY_DSN || opts.dsn;
  if (!dsn) return false;
  try {
    const Sentry = require('@sentry/node');
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: Number.parseFloat(process.env.SIRAGPT_SENTRY_SAMPLE_RATE || '0.1'),
      profilesSampleRate: Number.parseFloat(process.env.SIRAGPT_SENTRY_PROFILES_SAMPLE_RATE || '0.05'),
      ...opts,
    });
    return true;
  } catch (err) {
    try { console.warn('[sentry] init failed:', err.message); } catch (_) {}
    return false;
  }
}

function createSentryRequestHandler() {
  try {
    if (!process.env.SENTRY_DSN) return (req, res, next) => next();
    const Sentry = require('@sentry/node');
    return Sentry.Handlers.requestHandler();
  } catch (_) {
    return (req, res, next) => next();
  }
}

function createSentryErrorHandler() {
  try {
    if (!process.env.SENTRY_DSN) return (err, req, res, next) => next(err);
    const Sentry = require('@sentry/node');
    return Sentry.Handlers.errorHandler();
  } catch (_) {
    return (err, req, res, next) => next(err);
  }
}

module.exports = {
  initPino,
  getLogger,
  createPinoMiddleware,
  initSentry,
  sentryCaptureError,
  createSentryRequestHandler,
  createSentryErrorHandler,
};
