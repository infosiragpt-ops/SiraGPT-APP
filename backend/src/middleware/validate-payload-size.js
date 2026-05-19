'use strict';

/**
 * validate-payload-size — structured request payload guard.
 *
 * Why a dedicated middleware when express.json({ limit }) already caps body
 * size?
 *   - Express's body-parser throws a generic `entity.too.large` SyntaxError
 *     once it has *already* buffered the offending bytes. By that point we
 *     have paid the I/O cost AND we surface an error envelope that doesn't
 *     match the rest of the API (no `code`, no `limit` hint for the FE).
 *   - We want a single, *cheap* `Content-Length` short-circuit BEFORE the
 *     parser runs, so a 50MB JSON spammer is rejected without us ever
 *     reading the socket.
 *   - We want a different cap for JSON (~1MB) vs multipart (~10MB) and we
 *     want each route to be able to override either, declaratively.
 *
 * The returned 413 response uses the shared validation envelope shape so
 * the FE has one branch for all "payload rejected" failures:
 *   {
 *     "error": "Payload too large",
 *     "code": "payload.too_large",
 *     "limit": <bytes>,
 *     "received": <bytes>,
 *     "kind": "json" | "multipart"
 *   }
 *
 * Usage:
 *   const validatePayloadSize = require('../middleware/validate-payload-size');
 *
 *   // Defaults: 1MB JSON, 10MB multipart.
 *   router.post('/foo', validatePayloadSize(), handler);
 *
 *   // Per-route override (smaller cap on a sensitive endpoint):
 *   router.post('/auth/login', validatePayloadSize({ jsonBytes: 64 * 1024 }), handler);
 *
 *   // Multipart-heavy endpoint with a generous cap:
 *   router.post('/files/upload', validatePayloadSize({ multipartBytes: 250 * 1024 * 1024 }), handler);
 *
 *   // Disable one branch entirely (e.g. JSON-only route).
 *   router.post('/x', validatePayloadSize({ multipartBytes: 0 }), handler);
 */

const DEFAULT_JSON_BYTES = 1 * 1024 * 1024; // 1 MB
const DEFAULT_MULTIPART_BYTES = 10 * 1024 * 1024; // 10 MB

const JSON_RE = /^application\/(?:[^;]+\+)?json\b/i;
const MULTIPART_RE = /^multipart\/(?:form-data|mixed|related)\b/i;

/**
 * Decide which family the request's Content-Type belongs to so we can pick
 * the right cap. We deliberately classify *only* JSON and multipart — other
 * content types fall through (text/plain, urlencoded, etc.) because they
 * have their own appropriate caps elsewhere or are explicitly opted-out.
 *
 * @param {string} contentType
 * @returns {'json' | 'multipart' | 'other'}
 */
function classifyContentType(contentType) {
  if (typeof contentType !== 'string' || !contentType) return 'other';
  if (JSON_RE.test(contentType)) return 'json';
  if (MULTIPART_RE.test(contentType)) return 'multipart';
  return 'other';
}

/**
 * Parse a Content-Length header. Returns NaN when the header is missing or
 * malformed so the caller can decide whether to defer enforcement to a
 * downstream streaming check (we do — see middleware body).
 */
function parseContentLength(raw) {
  if (raw === undefined || raw === null || raw === '') return NaN;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return Math.trunc(n);
}

function reject(res, { kind, limit, received }) {
  if (res.headersSent) return;
  res.status(413).json({
    error: 'Payload too large',
    code: 'payload.too_large',
    kind,
    limit,
    received,
  });
}

/**
 * Factory. Returns an Express middleware enforcing the configured caps for
 * JSON and multipart requests. A cap of `0` disables that branch (the
 * middleware becomes a no-op for that content type — useful when a route
 * really does need to accept arbitrary-size streams and has its own
 * checks).
 *
 * Options:
 *   - jsonBytes      — number, default 1 MiB
 *   - multipartBytes — number, default 10 MiB
 *   - onReject       — optional callback `(req, info) => void` for metrics
 */
function validatePayloadSize(opts = {}) {
  const jsonBytes = Number.isFinite(opts.jsonBytes) ? Math.max(0, opts.jsonBytes) : DEFAULT_JSON_BYTES;
  const multipartBytes = Number.isFinite(opts.multipartBytes)
    ? Math.max(0, opts.multipartBytes)
    : DEFAULT_MULTIPART_BYTES;
  const onReject = typeof opts.onReject === 'function' ? opts.onReject : null;

  return function validatePayloadSizeMiddleware(req, res, next) {
    // GET/HEAD/DELETE/OPTIONS have no body to police — fast-path them so
    // we never pay the header parsing cost on the hot read path.
    const method = req.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || method === 'DELETE') {
      return next();
    }

    const kind = classifyContentType(req.headers['content-type']);
    if (kind === 'other') return next();

    const limit = kind === 'json' ? jsonBytes : multipartBytes;
    if (limit <= 0) return next(); // explicit opt-out for this branch

    const declared = parseContentLength(req.headers['content-length']);

    // Cheap path: declared length exceeds cap → reject immediately without
    // reading the body.
    if (Number.isFinite(declared) && declared > limit) {
      if (onReject) {
        try { onReject(req, { kind, limit, received: declared, stage: 'header' }); } catch { /* noop */ }
      }
      return reject(res, { kind, limit, received: declared });
    }

    // Streaming guard: chunked or missing Content-Length. We tally bytes
    // as they arrive and abort the read as soon as we cross the cap. This
    // protects against clients that omit/lie about Content-Length.
    let received = 0;
    let aborted = false;
    function onData(chunk) {
      if (aborted) return;
      received += chunk.length;
      if (received > limit) {
        aborted = true;
        if (onReject) {
          try { onReject(req, { kind, limit, received, stage: 'stream' }); } catch { /* noop */ }
        }
        // Stop further data flow and respond. We intentionally do NOT
        // destroy the socket — that would surface as a confusing
        // connection reset on the client; a clean 413 is friendlier.
        req.removeListener('data', onData);
        req.pause();
        reject(res, { kind, limit, received });
      }
    }
    req.on('data', onData);
    req.once('end', () => req.removeListener('data', onData));
    req.once('close', () => req.removeListener('data', onData));
    return next();
  };
}

module.exports = validatePayloadSize;
module.exports.validatePayloadSize = validatePayloadSize;
module.exports.DEFAULT_JSON_BYTES = DEFAULT_JSON_BYTES;
module.exports.DEFAULT_MULTIPART_BYTES = DEFAULT_MULTIPART_BYTES;
module.exports.classifyContentType = classifyContentType;
module.exports.parseContentLength = parseContentLength;
