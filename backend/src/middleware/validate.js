'use strict';

/**
 * Zod-backed validation middleware.
 *
 * Why this exists alongside the existing express-validator usage:
 *   - express-validator returns generic strings; the FE has no stable code
 *     to look up for i18n. Here we always return a structured `code` (e.g.
 *     `auth.email.invalid`) drawn from the schema's `message` field.
 *   - We can share the SAME schema with the frontend by code-generating
 *     TypeScript types from `backend/src/schemas/`.
 *
 * The middleware is intentionally tiny — `validateBody`, `validateQuery`,
 * `validateParams`. They all share the same error shape so the FE can
 * branch on one envelope.
 *
 * Error envelope:
 *   {
 *     "ok": false,
 *     "error": "Validation failed",
 *     "code": "validation_failed",
 *     "validation": [
 *       { "field": "email", "code": "auth.email.invalid", "expected": "...", "received": "invalid_type" }
 *     ]
 *   }
 */

const { ZodError } = require('zod');
const { getRequestId } = require('./request-id');
const { redactPayloadDeep } = require('../utils/log-redaction');

function setValidationResponseHeaders(res) {
  if (!res || typeof res.setHeader !== 'function') return;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function normalizeBuildOptions(codePrefix, opts) {
  if (codePrefix && typeof codePrefix === 'object') {
    return {
      codePrefix: codePrefix.codePrefix || 'validation',
      requestId: codePrefix.requestId || null,
    };
  }
  return {
    codePrefix: codePrefix || 'validation',
    requestId: opts && opts.requestId ? opts.requestId : null,
  };
}

function formatIssuePath(path) {
  if (!Array.isArray(path) || path.length === 0) return '(root)';
  return path.map(part => String(part)).join('.') || '(root)';
}

function validationDetailFromIssue(issue, codePrefix) {
  const field = formatIssuePath(issue && issue.path);
  // We treat the `message` as the i18n code when it looks like one
  // (dot-separated lowercase). Otherwise we synthesize a code from the
  // path + zod issue code so the FE still has a stable key.
  const raw = typeof issue?.message === 'string' ? issue.message : '';
  const looksLikeCode = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(raw);
  const issueCode = issue?.code || 'invalid';
  const safeField = field === '(root)' ? 'root' : field;
  const code = looksLikeCode ? raw : `${codePrefix}.${safeField}.${issueCode}`;
  return {
    field,
    code,
    message: raw || `${field} is invalid`,
    expected: issue?.expected ?? issue?.options ?? undefined,
    received: issue?.received ?? undefined,
  };
}

/**
 * Convert a ZodError into the structured envelope above.
 * Falls back to a generic code prefix when the schema didn't supply one.
 *
 * @param {ZodError} err
 * @param {string} codePrefix — fallback i18n namespace, e.g. "validation"
 */
function buildValidationPayload(err, codePrefix = 'validation', opts = {}) {
  const buildOpts = normalizeBuildOptions(codePrefix, opts);
  const issues = Array.isArray(err && err.issues) ? err.issues : [];
  const payload = {
    ok: false,
    error: 'Validation failed',
    code: 'validation_failed',
    validation: issues.map(issue => validationDetailFromIssue(issue, buildOpts.codePrefix)),
  };
  if (buildOpts.requestId) {
    payload.requestId = buildOpts.requestId;
  }
  return payload;
}

function validationPayloadForRequest(err, req, codePrefix) {
  return buildValidationPayload(err, codePrefix, { requestId: getRequestId(req) });
}

function sanitizeReceivedValue(value, opts = {}) {
  if (!opts.includeReceived) return undefined;
  return redactPayloadDeep(value, { maxDepth: 4, maxArrayItems: 10 });
}

function formatExpressValidatorError(e, codePrefix, opts) {
  const field = e?.path || e?.param || '(root)';
  const raw = typeof e?.msg === 'string' ? e.msg : '';
  const looksLikeCode = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(raw);
  const code = looksLikeCode ? raw : `${codePrefix}.${field}.invalid`;
  const detail = {
    field,
    code,
    message: raw || `${field} is invalid`,
  };
  const received = sanitizeReceivedValue(e?.value, opts);
  if (received !== undefined) detail.received = received;
  return detail;
}

function validate(target, schema, opts = {}) {
  const codePrefix = opts.codePrefix || 'validation';
  if (!schema || typeof schema.safeParse !== 'function') {
    throw new TypeError('validate(): expected a zod schema');
  }
  return function validateMiddleware(req, res, next) {
    const input = req[target];
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      setValidationResponseHeaders(res);
      const payload = validationPayloadForRequest(parsed.error, req, codePrefix);
      return res.status(400).json(payload);
    }
    // Replace with the parsed (and possibly coerced) value so downstream
    // handlers see normalized data.
    try {
      req[target] = parsed.data;
    } catch {
      // req.query is a getter in some express versions — fall through.
    }
    return next();
  };
}

function validateBody(schema, opts) {
  return validate('body', schema, opts);
}

function validateQuery(schema, opts) {
  return validate('query', schema, opts);
}

function validateParams(schema, opts) {
  return validate('params', schema, opts);
}

/**
 * Helper for code paths that already parsed and just need a thrown ZodError
 * converted into a response — used by the AI response validator when it
 * decides to surface a parse failure to the caller.
 */
function sendValidationError(res, err, opts = {}) {
  setValidationResponseHeaders(res);
  const requestId = opts.requestId || getRequestId(opts.req);
  if (err instanceof ZodError) {
    return res.status(400).json(buildValidationPayload(err, opts.codePrefix, { requestId }));
  }
  return res.status(400).json({
    ok: false,
    error: 'Validation failed',
    code: 'validation_failed',
    validation: [],
    ...(requestId ? { requestId } : {}),
  });
}

/**
 * Adapter that turns express-validator's `errors.array()` into the same
 * envelope so the FE only learns one shape. Existing routes can call
 * `formatExpressValidatorErrors(errors.array())` and send it directly.
 */
function formatExpressValidatorErrors(errArray, opts = {}) {
  const codePrefix = opts.codePrefix || 'validation';
  const payload = {
    ok: false,
    error: 'Validation failed',
    code: 'validation_failed',
    validation: (errArray || []).map(e => formatExpressValidatorError(e, codePrefix, opts)),
  };
  if (opts.requestId) payload.requestId = opts.requestId;
  return payload;
}

module.exports = {
  validate,
  validateBody,
  validateQuery,
  validateParams,
  sendValidationError,
  buildValidationPayload,
  setValidationResponseHeaders,
  formatExpressValidatorErrors,
};
