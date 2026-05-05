// ──────────────────────────────────────────────────────────────
// siraGPT — Async Route Handler Wrapper
// ──────────────────────────────────────────────────────────────
// Express 4.x does NOT catch rejected promises from async route
// handlers. Without this wrapper (or express-async-errors), an
// uncaught async error becomes an unhandledRejection — and the
// client gets a hanging request until timeout.
//
// Usage:
//   router.get('/data', asyncHandler(async (req, res) => {
//     const data = await riskyOperation();
//     res.json(data);
//   }));
//
// This also works for middleware that returns promises:
//   app.use(asyncHandler(async (req, res, next) => {
//     req.user = await loadUser(req);
//     next();
//   }));
// ──────────────────────────────────────────────────────────────

/**
 * Wraps an async Express route handler so that rejected promises
 * automatically forward to the next() error handler.
 *
 * @param {Function} fn - Async route handler: (req, res, next) => Promise
 * @returns {Function} Express middleware that catches async errors
 */
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

module.exports = { asyncHandler };
