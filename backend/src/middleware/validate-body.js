'use strict';

/**
 * validate-body — Zod-based request body validation middleware
 *
 * Usage:
 *   const { validateBody } = require('../middleware/validate-body');
 *   const { someSchema } = require('../../server/schemas');
 *   router.post('/route', validateBody(someSchema), handler);
 *
 * On validation failure the middleware returns HTTP 400 with a
 * structured error object. On success `req.validatedBody` is set
 * and the raw `req.body` is left untouched for backward compat.
 */

const { getRequestId } = require('./request-id');

function setValidationHeaders(res) {
  if (!res || typeof res.setHeader !== 'function') return;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function formatZodError(zodError) {
  const details = (zodError.errors || zodError.issues || []).map(err => ({
    path: Array.isArray(err.path) ? err.path.join('.') : '',
    message: err.message,
    code: err.code,
  }));
  return {
    ok: false,
    error: 'validation_failed',
    message: 'Request body validation failed',
    details,
  };
}

function validateBody(schema) {
  if (!schema || typeof schema.parse !== 'function') {
    throw new TypeError('validateBody requires a Zod schema with .parse()');
  }
  return (req, res, next) => {
    try {
      const result = schema.parse(req.body);
      req.validatedBody = result;
      next();
    } catch (err) {
      if (err && err.name === 'ZodError') {
        setValidationHeaders(res);
        const payload = formatZodError(err);
        const requestId = getRequestId(req);
        if (requestId) payload.requestId = requestId;
        return res.status(400).json(payload);
      }
      next(err);
    }
  };
}

module.exports = { formatZodError, setValidationHeaders, validateBody };
