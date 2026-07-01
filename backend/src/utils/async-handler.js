// ──────────────────────────────────────────────────────────────
// siraGPT — Enhanced Async Route Handler Wrapper
// ──────────────────────────────────────────────────────────────
// Express 4.x does NOT catch rejected promises from async route
// handlers. Without this wrapper (or express-async-errors), an
// uncaught async error becomes an unhandledRejection — and the
// client gets a hanging request until timeout.
//
// Enhanced version:
//   - Backward-compatible microtask-level error forwarding (keeps
//     existing asyncHandler test patterns working).
//   - Optional per-handler timeout via AsyncGuard (second arg).
//   - Detects "headers already sent" to avoid double-send in
//     error paths (res.headersSent / res.writableEnded).
//   - Preserves sync-throw propagation from non-async handlers.
//
// Usage:
//   router.get('/data', asyncHandler(async (req, res) => {
//     const data = await riskyOperation();
//     res.json(data);
//   }));
//
// With custom timeout (60s):
//   router.post('/slow', asyncHandler(async (req, res) => {
//     const data = await slowPipeline(req.body);
//     res.json(data);
//   }, { timeoutMs: 60_000 }));
//
// Middleware usage:
//   app.use(asyncHandler(async (req, res, next) => {
//     req.user = await loadUser(req);
//     next();
//   }));
// ──────────────────────────────────────────────────────────────

const { defaultGuard, GuardError } = require('./async-guard');

/**
 * Wraps an async Express route handler or middleware.
 *
 * Errors are forwarded to `next(err)` within the same microtask
 * tick as the original Promise.reject() – identical timing to
 * the classic asyncHandler pattern for full backward compat.
 *
 * When `opts.timeoutMs` is set, the guard runs a parallel timeout
 * watch.  Only GuardError (timeout) is forwarded via this path;
 * regular errors are handled by the direct microtask path only.
 *
 * @param {Function} fn   - Async route handler: (req, res, next) => Promise
 * @param {object}  [opts]
 * @param {number}  [opts.timeoutMs]  - Per-route timeout
 * @param {string}  [opts.label]      - Custom label for observability
 * @returns {Function} Express middleware
 */
function asyncHandler(fn, opts = {}) {
  const label = opts.label || fn.name || 'async_handler';
  const timeoutMs = opts.timeoutMs;

  return function asyncHandlerWrapped(req, res, next) {
    // fn may throw synchronously (non-async handler).  We let that
    // propagate naturally for backward compatibility.
    const result = fn(req, res, next);

    // Only wrap thenables.
    if (result == null || typeof result.then !== 'function') return;

    // ── Direct microtask-level error forwarding (backward compat) ──
    result.then(null, (err) => {
      if (res.headersSent || res.writableEnded) {
        /* eslint-disable-next-line no-console */
        (req.log || console).warn?.(
          { err, handler: label },
          'asyncHandler: response already sent, skipping error forward'
        );
        return;
      }
      next(err);
    });

    // ── Optional guard-based timeout protection ──
    if (timeoutMs != null) {
      const guardOpts = {
        label: `${label}:${req.method} ${req.originalUrl || req.url}`,
        timeoutMs,
      };
      defaultGuard.run(result, guardOpts).catch((err) => {
        // Only forward GuardError from an actual timeout.  Regular
        // errors — and abort-shaped rejections that async-guard wraps
        // in a GuardError with reason 'aborted' — are already forwarded
        // by the microtask path above; forwarding them here too would
        // run the Express error chain twice for one failure.
        if (
          err instanceof GuardError &&
          err.reason === 'timeout' &&
          !res.headersSent &&
          !res.writableEnded
        ) {
          next(err);
        }
      });
    }
  };
}

module.exports = { asyncHandler };
