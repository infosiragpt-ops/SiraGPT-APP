'use strict';
function validateZod(schema) {
  return (req, res, next) => {
    try {
      req.validated = schema.parse(req.body);
      next();
    } catch (err) {
      const zodError = /** @type {import('zod').ZodError} */ (err);
      return res.status(400).json({ error: 'Validation failed', details: zodError.errors });
    }
  };
}
module.exports = { validateZod };
