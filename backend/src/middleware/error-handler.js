'use strict';

const http = require('http');
const multer = require('multer');
const { validationResult } = require('express-validator');
const { logger: defaultLogger } = require('./logger');
const { getRequestId } = require('./request-id');

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

function normalizeErrorBody(body, { statusCode = 500, requestId = null } = {}) {
  const source = body && typeof body === 'object' && !Buffer.isBuffer(body)
    ? { ...body }
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

  const statusCode = toStatusCode(err?.status || err?.statusCode, 500);
  const production = process.env.NODE_ENV === 'production';
  const expose = err?.expose === true || statusCode < 500;
  const safeMessage = production && statusCode >= 500 && !expose
    ? 'Internal server error'
    : err?.message || statusMessage(statusCode);
  const body = {
    ok: false,
    error: err?.error || safeMessage,
    message: safeMessage,
    ...(err?.code ? { code: err.code } : {}),
    ...(Array.isArray(err?.errors) ? { errors: sanitizeValidationErrors(err.errors) } : {}),
    ...(err?.details ? { details: err.details } : {}),
    ...(getRequestId(req) ? { requestId: getRequestId(req) } : {}),
    ...(exposeStack && err?.stack ? { stack: err.stack } : {}),
  };
  return { statusCode, body };
}

function globalErrorHandler({ logger = defaultLogger, captureException = null } = {}) {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);

    const { statusCode, body } = errorToResponse(err, req, {
      exposeStack: process.env.NODE_ENV !== 'production',
    });
    const log = req.log || logger;
    const level = statusCode >= 500 ? 'error' : 'warn';
    log[level](
      {
        err,
        ...getRequestLogContext(req, statusCode, body),
      },
      'request_failed',
    );
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
  createHttpError,
  createValidationError,
  errorToResponse,
  globalErrorHandler,
  normalizeErrorBody,
  notFoundHandler,
  sanitizeValidationErrors,
  standardizeErrorResponses,
  validateRequest,
};
