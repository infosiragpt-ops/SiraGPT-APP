'use strict';

function createZodValidator() {
  return {
    body(schema) {
      return (req, res, next) => {
        if (!schema || typeof schema.parse !== 'function') {
          return next();
        }

        const result = schema.safeParse(req.body);
        if (!result.success) {
          const errors = result.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
            code: issue.code,
          }));

          return res.status(400).json({
            error: 'validation_error',
            message: 'Los datos enviados no cumplen con el formato esperado.',
            details: errors,
          });
        }

        req.body = result.data;
        next();
      };
    },

    query(schema) {
      return (req, res, next) => {
        if (!schema || typeof schema.parse !== 'function') {
          return next();
        }

        const result = schema.safeParse(req.query);
        if (!result.success) {
          const errors = result.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
            code: issue.code,
          }));

          return res.status(400).json({
            error: 'validation_error',
            message: 'Los parámetros de consulta no son válidos.',
            details: errors,
          });
        }

        req.query = result.data;
        next();
      };
    },

    params(schema) {
      return (req, res, next) => {
        if (!schema || typeof schema.parse !== 'function') {
          return next();
        }

        const result = schema.safeParse(req.params);
        if (!result.success) {
          const errors = result.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
            code: issue.code,
          }));

          return res.status(400).json({
            error: 'validation_error',
            message: 'Los parámetros de ruta no son válidos.',
            details: errors,
          });
        }

        req.params = result.data;
        next();
      };
    },
  };
}

module.exports = { createZodValidator };
