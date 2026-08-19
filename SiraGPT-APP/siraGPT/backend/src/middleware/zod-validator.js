'use strict';

const { getRequestId } = require('./request-id');
const { setValidationResponseHeaders } = require('./validate');

function hasSafeParse(schema) {
  return schema && typeof schema.safeParse === 'function';
}

function formatIssues(error) {
  return (error && Array.isArray(error.issues) ? error.issues : []).map((issue) => ({
    path: Array.isArray(issue.path) ? issue.path.join('.') : '',
    message: issue.message,
    code: issue.code,
  }));
}

function sendValidationError(req, res, message, error) {
  setValidationResponseHeaders(res);
  const payload = {
    ok: false,
    error: 'validation_error',
    code: 'validation_failed',
    message,
    details: formatIssues(error),
  };
  const requestId = getRequestId(req);
  if (requestId) payload.requestId = requestId;
  return res.status(400).json(payload);
}

function createZodValidator() {
  return {
    body(schema) {
      return (req, res, next) => {
        if (!hasSafeParse(schema)) {
          return next();
        }

        const result = schema.safeParse(req.body);
        if (!result.success) {
          return sendValidationError(
            req,
            res,
            'Los datos enviados no cumplen con el formato esperado.',
            result.error,
          );
        }

        req.body = result.data;
        next();
      };
    },

    query(schema) {
      return (req, res, next) => {
        if (!hasSafeParse(schema)) {
          return next();
        }

        const result = schema.safeParse(req.query);
        if (!result.success) {
          return sendValidationError(
            req,
            res,
            'Los parámetros de consulta no son válidos.',
            result.error,
          );
        }

        req.query = result.data;
        next();
      };
    },

    params(schema) {
      return (req, res, next) => {
        if (!hasSafeParse(schema)) {
          return next();
        }

        const result = schema.safeParse(req.params);
        if (!result.success) {
          return sendValidationError(
            req,
            res,
            'Los parámetros de ruta no son válidos.',
            result.error,
          );
        }

        req.params = result.data;
        next();
      };
    },
  };
}

module.exports = {
  createZodValidator,
  formatIssues,
};
