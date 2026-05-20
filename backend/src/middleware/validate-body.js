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

function formatZodError(zodError) {
  const details = zodError.errors.map(err => ({
    path: err.path.join('.'),
    message: err.message,
    code: err.code,
  }));
  return {
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
        return res.status(400).json(formatZodError(err));
      }
      next(err);
    }
  };
}

module.exports = { formatZodError, validateBody };
