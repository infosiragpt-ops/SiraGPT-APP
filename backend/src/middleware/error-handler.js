'use strict';

const http = require('http');
const multer = require('multer');
const { validationResult } = require('express-validator');
const { logger: defaultLogger } = require('./logger');
const { getRequestId } = require('./request-id');
const { redactPayloadDeep } = require('../utils/log-redaction');
const { redactErrorMessage } = require('../utils/secret-redactor');

function statusMessage(statusCode) {
  return http.STATUS_CODES[statusCode] || 'Request failed';
}

function toStatusCode(value, fallback = 500) {
  const status = Number.parseInt(value, 10);
  if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  return fallback;
}

function getRequestLogContext(req, statusCode, body = {}) {
  return {
    statusCode,
    error: body?.error,
    message: body?.message,
    method: req.method,
    path: req.originalUrl || req.url,
    requestId: getRequestId(req),
  };
}

function sanitizeValidationErrors(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.map((item) => {
    if (!item || typeof item !== 'object') {
      return { msg: String(item) };
    }
    const sanitized = {};
    for (const key of ['type', 'location', 'path', 'param', 'msg', 'message']) {
      if (item[key] != null) sanitized[key] = item[key];
    }
    return sanitized;
  });
}

function hasValidationErrors(body) {
  return Array.isArray(body?.errors) && body.errors.length > 0;
}

function validationMessage(errors) {
  const first = Array.isArray(errors) ? errors[0] : null;
  if (!first) return 'Validation failed';
  const field = first.path || first.param || first.location || 'request';
  const msg = first.msg || first.message || 'Invalid value';
  return `${field}: ${msg}`;
}

function sanitizeErrorDetails(details) {
  if (details === undefined) return undefined;
  if (details === null) return null;
  if (typeof details === 'string') return details.slice(0, 1000);
  if (typeof details !== 'object' || Buffer.isBuffer(details)) return details;
  return redactPayloadDeep(details, { maxDepth: 6, maxArrayItems: 25 });
}

function normalizeErrorBody(body, { statusCode = 500, requestId = null } = {}) {
  const source = body && typeof body === 'object' && !Buffer.isBuffer(body)
    ? redactPayloadDeep({ ...body }, { maxDepth: 6, maxArrayItems: 25 })
    : { error: body == null ? statusMessage(statusCode) : String(body) };

  const validationErrors = hasValidationErrors(source);
  if (validationErrors) {
    source.errors = sanitizeValidationErrors(source.errors);
  }
  const rawError = source.error;
  const rawMessage = source.message;
  const error = typeof rawError === 'string' && rawError.trim()
    ? rawError
    : validationErrors
      ? 'Validation failed'
      : statusMessage(statusCode);
  const message = typeof rawMessage === 'string' && rawMessage.trim()
    ? rawMessage
    : validationErrors
      ? validationMessage(source.errors)
      : error;

  return {
    ...source,
    ok: false,
    error,
    message,
    ...(requestId && !source.requestId ? { requestId } : {}),
  };
}

function logErrorResponse(req, res, body) {
  if (res.locals.errorResponseLogged) return;
  res.locals.errorResponseLogged = true;

  const statusCode = res.statusCode;
  const log = req.log || defaultLogger;
  const level = statusCode >= 500 ? 'error' : 'warn';
  log[level](getRequestLogContext(req, statusCode, body), 'http_error_response');
}

function standardizeErrorResponses() {
  return (req, res, next) => {
    if (res.locals.standardErrorResponsesInstalled) return next();
    res.locals.standardErrorResponsesInstalled = true;

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 400) {
        const normalized = normalizeErrorBody(body, {
          statusCode: res.statusCode,
          requestId: req.requestId || req.id || null,
        });
        logErrorResponse(req, res, normalized);
        return originalJson(normalized);
      }
      return originalJson(body);
    };

    next();
  };
}

function createHttpError(statusCode, message, options = {}) {
  const status = toStatusCode(statusCode, 500);
  const err = new Error(message || statusMessage(status));
  err.status = status;
  err.statusCode = status;
  if (options.code) err.code = options.code;
  if (options.error) err.error = options.error;
  if (options.details) err.details = options.details;
  if (options.errors) err.errors = options.errors;
  if (options.expose != null) err.expose = Boolean(options.expose);
  return err;
}

function createValidationError(errors) {
  const sanitizedErrors = sanitizeValidationErrors(errors);
  return createHttpError(400, validationMessage(sanitizedErrors), {
    code: 'validation_failed',
    error: 'Validation failed',
    errors: sanitizedErrors,
    expose: true,
  });
}

function validateRequest(req, _res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();
  return next(createValidationError(result.array()));
}

// Map well-known third-party error classes to (status, code, message).
// Returns null if the error is not a known type. The mapping is
// conservative: only error shapes we have actually observed in
// production get a special status — everything else falls through
// to the generic 500 / err.status path so we don't silently mask
// novel errors with stale mappings.
function classifyKnownError(err) {
  if (!err || typeof err !== 'object') return null;
  const name = err.name || '';
  const code = err.code || '';
  if (err.isStripeOperationalError) {
    return {
      statusCode: err.statusCode || 503,
      code: err.code || 'stripe_provider_error',
      error: err.publicError || 'Payment provider unavailable',
      message: err.publicMessage || 'Payment processing is temporarily unavailable. Please contact support.',
    };
  }
  // ZodError — schema validation. ZodError instances always have an
  // `issues` array. Surface the first issue's path + message.
  if (name === 'ZodError' && Array.isArray(err.issues)) {
    const first = err.issues[0] || {};
    const field = Array.isArray(first.path) && first.path.length ? first.path.join('.') : 'request';
    const message = `${field}: ${first.message || 'Invalid value'}`;
    return { statusCode: 400, code: 'validation_failed', error: 'Validation failed', message };
  }
  // express-validator + custom ValidationError class.
  if (name === 'ValidationError') {
    return { statusCode: 400, code: 'validation_failed', error: 'Validation failed', message: err.message || 'Validation failed' };
  }
  // Prisma — distinguish known request errors from unknown engine crashes.
  // Codes: https://www.prisma.io/docs/reference/api-reference/error-reference
  if (name === 'PrismaClientKnownRequestError') {
    if (code === 'P2002') return { statusCode: 409, code: 'unique_constraint_violation', error: 'Conflict', message: 'Resource already exists' };
    if (code === 'P2025') return { statusCode: 404, code: 'not_found', error: 'Not found', message: 'Resource not found' };
    if (code === 'P2003') return { statusCode: 409, code: 'foreign_key_violation', error: 'Conflict', message: 'Referenced resource missing' };
    if (code === 'P2000' || code === 'P2001') return { statusCode: 400, code: 'invalid_input', error: 'Bad request', message: 'Invalid input for database operation' };
    return { statusCode: 400, code: 'database_error', error: 'Bad request', message: 'Database request failed' };
  }
  if (name === 'PrismaClientValidationError') {
    return { statusCode: 400, code: 'database_validation_error', error: 'Validation failed', message: 'Invalid data for database operation' };
  }
  if (name === 'PrismaClientInitializationError' || name === 'PrismaClientRustPanicError') {
    return { statusCode: 503, code: 'database_unavailable', error: 'Service unavailable', message: 'Database temporarily unavailable' };
  }
  // Stripe — every Stripe error subclasses StripeError and exposes `type`.
  // Status codes follow Stripe's HTTP semantics.
  if (name === 'StripeCardError' || err.type === 'StripeCardError') {
    return { statusCode: 402, code: 'card_declined', error: 'Payment required', message: redactErrorMessage(err) || 'Card declined' };
  }
  if (name === 'StripeInvalidRequestError' || err.type === 'StripeInvalidRequestError') {
    return { statusCode: 400, code: 'stripe_invalid_request', error: 'Bad request', message: redactErrorMessage(err) || 'Invalid payment request' };
  }
  if (name === 'StripeAuthenticationError' || err.type === 'StripeAuthenticationError') {
    return { statusCode: 503, code: 'stripe_authentication_error', error: 'Service unavailable', message: 'Payment provider authentication failed' };
  }
  if (name === 'StripeRateLimitError' || err.type === 'StripeRateLimitError') {
    return { statusCode: 429, code: 'stripe_rate_limit', error: 'Too many requests', message: 'Payment provider rate limit exceeded' };
  }
  if (name === 'StripeConnectionError' || err.type === 'StripeConnectionError'
      || name === 'StripeAPIError' || err.type === 'StripeAPIError') {
    return { statusCode: 503, code: 'stripe_unavailable', error: 'Service unavailable', message: 'Payment provider temporarily unavailable' };
  }
  return null;
}

// Cap the stack to 2 KB so a runaway recursion or compiled regex
// frame can't blow up the log line.
function truncateStack(stack) {
  if (!stack || typeof stack !== 'string') return '';
  const MAX = 2048;
  if (stack.length <= MAX) return stack;
  return `${stack.slice(0, MAX - 14)}…[truncated]`;
}

function errorToResponse(err, req, { exposeStack = false } = {}) {
  if (err?.type === 'entity.too.large') {
    return {
      statusCode: 413,
      body: {
        ok: false,
        error: 'File too large',
        message: 'File too large',
        code: 'payload_too_large',
        requestId: getRequestId(req),
      },
    };
  }

  if (err instanceof multer.MulterError || /^Tipo no permitido:/i.test(err?.message || '')) {
    const message = err.message || 'Upload validation failed';
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: message,
        message,
        code: err.code || 'upload_validation_failed',
        requestId: getRequestId(req),
      },
    };
  }

  // Try known-error classification first (ZodError, Prisma, Stripe,
  // ValidationError). If a match is found and the original error
  // didn't already carry a status, use the classified status.
  const classified = classifyKnownError(err);
  const rawStatus = err?.status || err?.statusCode || (classified && classified.statusCode);
  const statusCode = toStatusCode(rawStatus, 500);
  const production = process.env.NODE_ENV === 'production';
  const expose = err?.expose === true || statusCode < 500 || Boolean(classified);
  const baseMessage = (classified && classified.message) || err?.message || statusMessage(statusCode);
  const safeMessage = production && statusCode >= 500 && !expose
    ? 'Internal server error'
    : baseMessage;
  const reqId = getRequestId(req);
  const body = {
    ok: false,
    error: err?.error || (classified && classified.error) || safeMessage,
    message: safeMessage,
    ...(err?.code || (classified && classified.code) ? { code: err?.code || classified.code } : {}),
    ...(Array.isArray(err?.errors) ? { errors: sanitizeValidationErrors(err.errors) } : {}),
    ...(err?.details ? { details: sanitizeErrorDetails(err.details) } : {}),
    ...(err?.retryable === true ? { retryable: true } : {}),
    ...(reqId ? { requestId: reqId, reqId } : {}),
    ...(exposeStack && err?.stack ? { stack: truncateStack(err.stack) } : {}),
  };
  return { statusCode, body };
}

function globalErrorHandler({ logger = defaultLogger, captureException = null, stdout = null } = {}) {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);

    const { statusCode, body } = errorToResponse(err, req, {
      exposeStack: process.env.NODE_ENV !== 'production',
    });
    const reqId = getRequestId(req);
    const log = req.log || logger;
    const level = statusCode >= 500 ? 'error' : 'warn';
    log[level](
      {
        err,
        ...getRequestLogContext(req, statusCode, body),
      },
      'request_failed',
    );

    // Also emit a single-line JSON record matching request-logger's
    // format so the access-log pipeline picks it up. This is the
    // canonical machine-readable error event: it always includes
    // reqId (set by the request logger upstream), err.name, err.message,
    // and stack truncated to 2 KB. Falls back to stdout but is
    // injectable for tests.
    try {
      const errPayload = {
        ts: new Date().toISOString(),
        level: 'error',
        method: req.method || '',
        path: (req.originalUrl || req.url || '').split('?')[0],
        status: statusCode,
        reqId: reqId || '',
        errName: err && err.name ? String(err.name) : 'Error',
        errMessage: err && err.message ? String(err.message).slice(0, 1024) : '',
        errStack: truncateStack(err && err.stack),
      };
      // Lazily include a PII-masked body preview when the operator has
      // explicitly enabled body logging. Off by default — we never log
      // raw request bodies. The lazy require keeps the hot path free
      // of the regex compile in the common case.
      if (process.env.SIRAGPT_LOG_REQUEST_BODY === '1' && req && req.body) {
        try {
          const { mask } = require('../utils/pii-mask');
          const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
          errPayload.body = mask(raw).slice(0, 4000);
        } catch { /* swallow */ }
      }
      const out = typeof stdout === 'function' ? stdout : (line) => process.stdout.write(line);
      out(`${JSON.stringify(errPayload)}\n`);
    } catch { /* never throw from the error handler */ }

    res.locals.errorResponseLogged = true;

    if (typeof captureException === 'function') {
      captureException(err, {
        req,
        tags: {
          surface: 'express_error_handler',
          status: statusCode,
        },
      });
    }

    const retryAfterSeconds = Number(err?.retryAfterSeconds);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      res.setHeader('Retry-After', String(Math.ceil(retryAfterSeconds)));
    }
    res.status(statusCode).json(body);
  };
}

function notFoundHandler(req, res) {
  res.status(404).json({
    error: 'Route not found',
    message: `Route not found: ${req.method} ${req.originalUrl || req.url}`,
    code: 'route_not_found',
  });
}

module.exports = {
  classifyKnownError,
  createHttpError,
  createValidationError,
  errorToResponse,
  globalErrorHandler,
  normalizeErrorBody,
  notFoundHandler,
  sanitizeValidationErrors,
  sanitizeErrorDetails,
  standardizeErrorResponses,
  truncateStack,
  validateRequest,
};
