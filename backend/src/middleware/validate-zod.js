'use strict';

const { getRequestId } = require('./request-id');
const { buildValidationPayload, setValidationResponseHeaders } = require('./validate');

function validateZod(schema) {
  if (!schema || typeof schema.parse !== 'function') {
    throw new TypeError('validateZod requires a Zod schema with .parse()');
  }
  return (req, res, next) => {
    try {
      req.validated = schema.parse(req.body);
      next();
    } catch (err) {
      if (!(err && err.name === 'ZodError')) {
        return next(err);
      }
      setValidationResponseHeaders(res);
      return res.status(400).json(buildValidationPayload(err, {
        requestId: getRequestId(req),
      }));
    }
  };
}

module.exports = { validateZod };
