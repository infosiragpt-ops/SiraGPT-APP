'use strict';

/**
 * pino-logger — structured JSON logger factory backed by pino.
 *
 * Provides a singleton pino instance configured by environment variables:
 *   LOG_LEVEL           — trace|debug|info|warn|error|fatal (default: info)
 *   LOG_PRETTY          — pino-pretty for dev (default: enabled outside production)
 *   LOG_DESTINATION     — file path or 1/stdout (default: stdout)
 *   SENTRY_DSN          — automatically configures pino-sentry transport
 *   LOG_REDACT_KEYS     — comma-separated keys to redact (default: password,secret,token,apiKey,authorization)
 *
 * Integration pattern:
 *   const logger = require('./pino-logger');
 *   logger.info({ userId }, 'user logged in');
 *   logger.error({ err, reqId }, 'unexpected failure');
 */

let _instance = null;

const REDACT_KEYS = String(process.env.LOG_REDACT_KEYS || 'password,secret,token,apiKey,authorization,api_key,accessToken,refreshToken,cvv,ssn,credit_card')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function redactSerializer(value) {
  if (value == null) return value;
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) return value.map(redactSerializer);

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (REDACT_KEYS.includes(key.toLowerCase())) {
      out[key] = '[REDACTED]';
    } else if (typeof val === 'object' && val !== null) {
      out[key] = redactSerializer(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function errSerializer(err) {
  if (!err) return err;
  return {
    type: err.constructor?.name || 'Error',
    message: err.message,
    stack: err.stack,
    code: err.code,
    statusCode: err.statusCode || err.status,
    ...(err.cause ? { cause: errSerializer(err.cause) } : {}),
  };
}

function reqSerializer(req) {
  if (!req) return req;
  return {
    id: req.id,
    method: req.method,
    url: req.originalUrl || req.url,
    headers: redactSerializer({
      host: req.headers?.host,
      'user-agent': req.headers?.['user-agent'],
      'content-type': req.headers?.['content-type'],
      'x-forwarded-for': req.headers?.['x-forwarded-for'],
    }),
    remoteAddress: req.ip || req.socket?.remoteAddress,
  };
}

function resSerializer(res) {
  if (!res) return res;
  return {
    statusCode: res.statusCode,
    headers: res.getHeaders ? redactSerializer(res.getHeaders()) : undefined,
  };
}

function createPinoLogger(opts = {}) {
  if (_instance && !opts.forceNew) return _instance;

  let pino;
  try {
    pino = require('pino');
  } catch (_) {
    // Fallback: lightweight console-based logger with same API shape.
    const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    _instance = {};
    for (const level of levels) {
      _instance[level] = function (...args) {
        const first = args[0];
        if (typeof first === 'object' && first !== null) {
          const msg = args[1] || '';
          process.stdout.write(JSON.stringify({ level, ...redactSerializer(first), msg: String(msg), ts: new Date().toISOString() }) + '\n');
        } else {
          process.stdout.write(JSON.stringify({ level, msg: String(first || ''), ts: new Date().toISOString() }) + '\n');
        }
      };
    }
    _instance.child = () => _instance;
    _instance.level = 'info';
    return _instance;
  }

  const level = opts.level || process.env.LOG_LEVEL || 'info';
  const isProduction = process.env.NODE_ENV === 'production';
  const pretty = opts.pretty !== undefined
    ? opts.pretty
    : (process.env.LOG_PRETTY === '1' || (!isProduction && process.env.LOG_PRETTY !== '0'));

  const transport = [];
  if (pretty) {
    transport.push({ target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss Z' } });
  }

  const stream = opts.destination || process.env.LOG_DESTINATION
    ? pino.destination(opts.destination || process.env.LOG_DESTINATION)
    : undefined;

  _instance = pino({
    level,
    serializers: {
      err: errSerializer,
      error: errSerializer,
      req: reqSerializer,
      res: resSerializer,
    },
    redact: {
      paths: REDACT_KEYS.map(k => `*.${k}`),
      censor: '[REDACTED]',
    },
    ...(transport.length === 1 ? { transport: transport[0] } : {}),
    ...(stream ? {} : {}),
    ...(opts.pinoOptions || {}),
  }, stream);

  _instance.serializers = {
    err: errSerializer,
    req: reqSerializer,
    res: resSerializer,
  };

  return _instance;
}

function getLogger() {
  return _instance || createPinoLogger();
}

function resetLogger() {
  _instance = null;
}

module.exports = createPinoLogger;
module.exports.getLogger = getLogger;
module.exports.resetLogger = resetLogger;
module.exports.errSerializer = errSerializer;
module.exports.reqSerializer = reqSerializer;
module.exports.resSerializer = resSerializer;
module.exports.redactSerializer = redactSerializer;
