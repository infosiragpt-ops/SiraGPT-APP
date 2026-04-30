/**
 * request-id — Express middleware that pins a single `request_id` to
 * every HTTP request and echoes it back to the caller.
 *
 * Why this exists:
 *   - `pino-http` (in middleware/logger.js) already mints `req.id` from
 *     an incoming `x-request-id` header (or a fresh UUID). That id is
 *     attached to every log line via `req.log`, but it is not surfaced
 *     to the client and it is not threaded through the Sira pipeline.
 *   - Sira's `task-envelope-builder` used to mint its own unrelated
 *     `request_id` (`req_<base36>_<hex>`), so the same logical turn had
 *     two unconnected ids: one in the access log, one in the audit log.
 *
 * What this middleware does:
 *   1. Reads `req.id` (set upstream by pino-http; we never overwrite it).
 *   2. Sets the `X-Request-Id` response header so the client and any
 *      downstream proxy see the same id the server logged under.
 *   3. Exposes `req.requestId` and `res.locals.requestId` as canonical
 *      handles for route handlers; downstream code passes this same
 *      value into `handleChatTurn`/`runUserMessage`/`buildEnvelope` so
 *      the envelope, audit events, and access log share one id.
 *
 * Mount order (in index.js): immediately after `httpLogger`. Before any
 * route handler. The middleware must run on every request (including
 * 4xx and 5xx) so even errored responses carry the header.
 *
 * Trust model: `x-request-id` is honored from any upstream source. If
 * an attacker sends a chosen id, the only consequence is that their
 * own logs/audit rows are filed under that id; nothing about
 * authorization or routing depends on the value. We therefore do not
 * sanitize the contents beyond what `pino-http` already did at parse
 * time.
 */

const HEADER = 'X-Request-Id';

function requestIdMiddleware(req, res, next) {
  // pino-http populates `req.id` — either from `x-request-id` upstream
  // or as a fresh UUID. We just pin it onto `req.requestId` for clearer
  // semantics in route handlers and onto the response header for the
  // client/proxies. If somehow `req.id` is missing (a route mounted
  // before the http logger), fall back to a string version of the
  // header so we never emit an empty `X-Request-Id`.
  const id = (req.id != null ? String(req.id) : '') || String(req.headers['x-request-id'] || '');

  if (id) {
    req.requestId = id;
    res.locals = res.locals || {};
    res.locals.requestId = id;
    // setHeader (not append/set after writeHead) — runs before any
    // route handler writes to the response. Express returns the same
    // res object to error handlers, so this header survives errors.
    res.setHeader(HEADER, id);
  }

  next();
}

/**
 * Read the request id from a request object. Prefer `req.requestId`
 * (set by this middleware), fall back to `req.id` (pino-http) and
 * finally to the raw header. Returns `null` if none present.
 */
function getRequestId(req) {
  if (!req) return null;
  if (req.requestId) return String(req.requestId);
  if (req.id) return String(req.id);
  const headerVal = req.headers && req.headers['x-request-id'];
  return headerVal ? String(headerVal) : null;
}

module.exports = {
  requestIdMiddleware,
  getRequestId,
  HEADER,
};
