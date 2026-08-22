'use strict';

const http = require('http');
const multer = require('multer');
const { validationResult } = require('express-validator');
const { logger: defaultLogger } = require('./logger');
const { getRequestId } = require('./request-id');
const { redactPreviewUrl } = require('../utils/preview-url-redaction');
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
    path: redactPreviewUrl(req.originalUrl || req.url),
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

// A caller-supplied message on a >=500 response is by definition an
// internal detail (route code interpolates err.message into it). The
// client contract for unmapped server failures is the generic phrase;
// known-error classifications bypass res.json entirely via their own
// mapped bodies, so this only masks genuinely unexpected leaks.
const GENERIC_5XX_MESSAGE = 'Internal server error';

function normalizeErrorBody(body, { statusCode = 500, requestId = null } = {}) {
  const source = body && typeof body === 'object' && !Buffer.isBuffer(body)
    ? redactPayloadDeep({ ...body }, { maxDepth: 6, maxArrayItems: 25 })
    : { error: body == null ? statusMessage(statusCode) : String(body) };

  const validationErrors = hasValidationErrors(source);
  if (validationErrors) {
    source.errors = sanitizeValidationErrors(source.errors);
  }
  const maskMessage = statusCode >= 500;
  const rawError = source.error;
  const rawMessage = source.message;
  // On 5xx the `error` slot is only safe if it is an HTTP status phrase
  // ('Internal Server Error'); a caller-supplied string like
  // 'boom_failed' or an interpolated err.message is internal detail.
  const httpErrorPhrase = statusMessage(statusCode);
  const error = typeof rawError === 'string' && rawError.trim()
    ? rawError
    : validationErrors
      ? 'Validation failed'
      : httpErrorPhrase;
  const message = typeof rawMessage === 'string' && rawMessage.trim()
    ? rawMessage
    : validationErrors
      ? validationMessage(source.errors)
      : error;

  return {
    ...source,
    ok: false,
    error: maskMessage && error !== httpErrorPhrase ? GENERIC_5XX_MESSAGE : error,
    message: maskMessage ? GENERIC_5XX_MESSAGE : message,
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
//
// Mapped results carry `clientCode` so the stable snake_case contract
// code wins over raw provider/system codes (err.code like
// 'rate_limit_exceeded' or 'ECONNREFUSED' must never reach the body).

const OPENAI_ERROR_NAMES = new Set([
  'APIError',
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'APIUserAbortError',
  'BadRequestError',
  'AuthenticationError',
  'PermissionDeniedError',
  'NotFoundError',
  'ConflictError',
  'UnprocessableEntityError',
  'RateLimitError',
  'InternalServerError',
]);

function openaiErrorModule() {
  try {
    return require('openai');
  } catch (_err) {
    return null;
  }
}

function isOpenAiApiError(err) {
  if (err.name === 'APIError') return true;
  if (OPENAI_ERROR_NAMES.has(err.name)) return true;
  const mod = openaiErrorModule();
  // openai v5 leaves err.name as 'Error'; constructor/prototype chain
  // is the only reliable discriminator for real SDK instances.
  return Boolean(
    mod
    && typeof mod.APIError === 'function'
    && (err instanceof mod.APIError || err.constructor?.name === 'APIError'),
  );
}

function parseRetryAfterHeader(headers) {
  if (!headers || typeof headers.get !== 'function') {
    const raw = headers && headers['retry-after'];
    if (raw == null) return null;
    return parseRetryAfterValue(raw);
  }
  return parseRetryAfterValue(headers.get('retry-after'));
}

function parseRetryAfterValue(raw) {
  if (raw == null) return null;
  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  const date = Date.parse(String(raw));
  if (Number.isFinite(date)) {
    const delta = Math.ceil((date - Date.now()) / 1000);
    return delta > 0 ? delta : 1;
  }
  return null;
}

function axiosNetworkFailure(err) {
  // A response-less axios error is a transport failure by definition;
  // the code set makes intent explicit for common system codes.
  return NETWORK_FAILURE_CODES.has(err.code)
    || !Number.isFinite(Number(err.response?.status));
}

const NETWORK_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

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
  // Circuit breaker OPEN/HALF_OPEN — the AI provider is known to be
  // failing; fail fast with an honest 503. breakerName/state stay in
  // logs only.
  if (name === 'CircuitBreakerError') {
    return {
      statusCode: 503,
      clientCode: 'provider_unavailable',
      error: 'Service unavailable',
      message: 'El proveedor de IA está temporalmente saturado; reintentá en unos segundos',
      retryAfterSeconds: secondsUntil(err.nextAttemptAt) || undefined,
    };
  }
  // OpenAI SDK — never forward the provider's status/message verbatim:
  // auth failures would leak key validity and 5xx text is provider
  // internals. Auth/config problems are our operational issue → 503,
  // not a 401 the client could misread as "your credentials". The
  // mapped status overrides err.status (errorToResponse prefers it)
  // so a raw provider 401/5xx cannot leak through.
  if (isOpenAiApiError(err)) {
    const retryAfter = parseRetryAfterHeader(err.headers);
    if (name === 'RateLimitError' || toStatusCode(err.status, 0) === 429) {
      return {
        overrideStatus: 429,
        clientCode: 'rate_limited',
        error: 'Too many requests',
        message: 'Demasiadas solicitudes; esperá un momento antes de reintentar',
        ...(retryAfter ? { retryAfterSeconds: retryAfter } : {}),
      };
    }
    if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError'
        || name === 'APIUserAbortError' || !Number.isFinite(Number(err.status))) {
      return {
        overrideStatus: 503,
        clientCode: 'ai_provider_unavailable',
        error: 'Service unavailable',
        message: 'El proveedor de IA no está disponible en este momento; reintentá en unos segundos',
      };
    }
    const upstreamStatus = Number(err.status);
    if (upstreamStatus >= 500) {
      return {
        overrideStatus: 503,
        clientCode: 'ai_provider_unavailable',
        error: 'Service unavailable',
        message: 'El proveedor de IA no está disponible en este momento; reintentá en unos segundos',
      };
    }
    if (upstreamStatus === 401 || upstreamStatus === 403) {
      return {
        overrideStatus: 503,
        clientCode: 'ai_provider_misconfigured',
        error: 'Service unavailable',
        message: 'El servicio de IA está mal configurado; contactá a soporte',
      };
    }
    return null;
  }
  // Axios — same contract as OpenAI above, for generic HTTP upstreams.
  if (err.isAxiosError === true) {
    const upstreamStatus = Number(err.response?.status);
    const retryAfter = parseRetryAfterHeader(err.response?.headers);
    if (!Number.isFinite(upstreamStatus)) {
      return {
        overrideStatus: 503,
        clientCode: 'upstream_unavailable',
        error: 'Service unavailable',
        message: 'El servicio solicitado no está disponible en este momento; reintentá en unos segundos',
      };
    }
    if (upstreamStatus >= 500) {
      return {
        overrideStatus: 503,
        clientCode: 'upstream_unavailable',
        error: 'Service unavailable',
        message: 'El servicio solicitado no está disponible en este momento; reintentá en unos segundos',
        ...(retryAfter ? { retryAfterSeconds: retryAfter } : {}),
      };
    }
    if (upstreamStatus === 429) {
      return {
        overrideStatus: 429,
        clientCode: 'rate_limited',
        error: 'Too many requests',
        message: 'Demasiadas solicitudes; esperá un momento antes de reintentar',
        ...(retryAfter ? { retryAfterSeconds: retryAfter } : {}),
      };
    }
    return null;
  }
  return null;
}

function secondsUntil(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  const delta = Math.ceil((date.getTime() - Date.now()) / 1000);
  return delta > 0 ? delta : 1;
}

// Client-initiated cancellations (SSE stream closed mid-turn, user
// navigated away, AbortController fired) are not server faults. The
// openai SDK's APIUserAbortError is handled by the OpenAI mapping
// above; everything else with abort markers is treated here.
function isClientAbortError(err) {
  if (!err || typeof err !== 'object') return false;
  return err.name === 'AbortError'
    || err.code === 'ABORT_ERR'
    || (err instanceof DOMException && err.code === DOMException.ABORT_ERR);
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
  // ValidationError). overrideStatus beats err.status: a mapped
  // provider/upstream error must present the contract status even
  // though the SDK attached a raw status (a provider 401/5xx must
  // never leak through as-is).
  const classified = classifyKnownError(err);
  const rawStatus = (classified && (classified.overrideStatus || classified.statusCode))
    || err?.status
    || err?.statusCode;
  const statusCode = toStatusCode(rawStatus, 500);
  const expose = err?.expose === true || statusCode < 500 || Boolean(classified);
  const baseMessage = (classified && classified.message) || err?.message || statusMessage(statusCode);
  const safeMessage = statusCode >= 500 && !expose
    ? 'Internal server error'
    : baseMessage;
  const reqId = getRequestId(req);
  const contractCode = (classified && (classified.clientCode || classified.code)) || err?.code;
  // err.error on openai SDK errors is the raw provider payload object
  // (e.g. {message:'The server had an error'}) — never expose it when
  // a mapping exists; the mapped phrase is the contract.
  const mappedError = (classified && classified.error) || safeMessage;
  const body = {
    ok: false,
    error: classified ? mappedError : (err?.error || mappedError),
    message: safeMessage,
    ...(contractCode ? { code: contractCode } : {}),
    ...(Array.isArray(err?.errors) ? { errors: sanitizeValidationErrors(err.errors) } : {}),
    ...(err?.details ? { details: sanitizeErrorDetails(err.details) } : {}),
    ...(err?.retryable === true ? { retryable: true } : {}),
    ...(reqId ? { requestId: reqId, reqId } : {}),
    ...(exposeStack && statusCode < 500 && err?.stack ? { stack: truncateStack(err.stack) } : {}),
  };
  const retryAfterSeconds = Number(err?.retryAfterSeconds)
    || Number(classified && classified.retryAfterSeconds);
  return {
    statusCode,
    body,
    ...(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? { retryAfterSeconds: Math.ceil(retryAfterSeconds) }
      : {}),
  };
}

function globalErrorHandler({ logger = defaultLogger, captureException = null, stdout = null } = {}) {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (isClientAbortError(err)) {
      const log = req.log || logger;
      // The client is gone — no response can be delivered. Log at
      // info so a user closing a tab mid-SSE stream doesn't pollute
      // the error dashboards.
      log.info(
        { ...getRequestLogContext(req, 499), clientDisconnected: true },
        'request_client_disconnected',
      );
      return;
    }

    const { statusCode, body, retryAfterSeconds } = errorToResponse(err, req, {
      // Stack traces are log-only material in EVERY environment: a
      // dev/staging client is still an outside client, and stacks carry
      // paths, provider messages and internal hostnames.
      exposeStack: false,
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
        path: redactPreviewUrl((req.originalUrl || req.url || '').split('?')[0]),
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

    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      res.setHeader('Retry-After', String(retryAfterSeconds));
    }
    res.status(statusCode).json(body);
  };
}

function notFoundHandler(req, res) {
  res.status(404).json({
    error: 'Route not found',
    message: `Route not found: ${req.method} ${redactPreviewUrl(req.originalUrl || req.url)}`,
    code: 'route_not_found',
  });
}

module.exports = {
  classifyKnownError,
  createHttpError,
  createValidationError,
  errorToResponse,
  globalErrorHandler,
  isClientAbortError,
  normalizeErrorBody,
  notFoundHandler,
  sanitizeValidationErrors,
  sanitizeErrorDetails,
  standardizeErrorResponses,
  truncateStack,
  validateRequest,
};
