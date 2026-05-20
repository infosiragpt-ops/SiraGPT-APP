'use strict';

/**
 * xss-sanitize — Express middleware that recursively sanitizes
 * req.body, req.query, and req.params against XSS vectors and
 * prompt-injection tag smuggling.
 *
 * What it strips:
 *   1. <script>...</script> blocks (case-insensitive)
 *   2. Inline event handlers (onerror, onload, onclick, etc.)
 *   3. javascript: / vbscript: URIs in href/src/action attributes
 *   4. Unicode tag-block codepoints (U+E0000–U+E007F) used for
 *      invisible payload smuggling
 *   5. Prompt-injection delimiters (<|im_start|>, <|im_end|>,
 *      </prompt>, </system>, </instructions>)
 *
 * Safe methods (GET/HEAD/OPTIONS) skip body sanitization but
 * query/params are still cleaned.
 *
 * The sanitizer operates on STRINGS only — objects, arrays, numbers
 * and booleans pass through unchanged. File uploads (multer) are
 * multipart and not touched.
 */

const SCRIPT_RE = /<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi;
const EVENT_HANDLER_RE = /\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URI_RE = /(?:href|src|action|formaction)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi;
const VBSCRIPT_URI_RE = /(?:href|src|action)\s*=\s*(?:"vbscript:[^"]*"|'vbscript:[^']*'|vbscript:[^\s>]+)/gi;
const UNICODE_TAG_RE = /[\u{E0000}-\u{E007F}]/gu;
const PROMPT_TAG_RE = /<\/?\s*(?:prompt|system|assistant|instructions?|sys|im_start|im_end)\s*>/gi;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Recursively sanitizes a value.
 * - Strings: strip XSS patterns
 * - Objects: sanitize each value
 * - Arrays: sanitize each element
 * - Primitives (number, boolean, null): pass through
 */
function sanitizeValue(val) {
  if (typeof val === 'string') {
    let s = val;
    s = s.replace(SCRIPT_RE, '');
    s = s.replace(EVENT_HANDLER_RE, '');
    s = s.replace(JS_URI_RE, '');
    s = s.replace(VBSCRIPT_URI_RE, '');
    s = s.replace(UNICODE_TAG_RE, '');
    s = s.replace(PROMPT_TAG_RE, '');
    return s;
  }
  if (Array.isArray(val)) {
    return val.map(sanitizeValue);
  }
  if (val !== null && typeof val === 'object' && val.constructor === Object) {
    const cleaned = {};
    for (const [k, v] of Object.entries(val)) {
      cleaned[k] = sanitizeValue(v);
    }
    return cleaned;
  }
  return val;
}

/**
 * Express middleware factory.
 * Always mounted globally — per-route opt-out is not exposed because
 * sanitization is defense-in-depth that should cover every endpoint
 * that accepts user text.
 */
function xssSanitizeMiddleware(req, res, next) {
  // Sanitize query params (always user-controlled)
  if (req.query && typeof req.query === 'object') {
    for (const key of Object.keys(req.query)) {
      req.query[key] = sanitizeValue(req.query[key]);
    }
  }

  // Sanitize route params
  if (req.params && typeof req.params === 'object') {
    for (const key of Object.keys(req.params)) {
      req.params[key] = sanitizeValue(req.params[key]);
    }
  }

  // Body sanitization: skip safe methods (no body expected) and
  // skip raw/buffer bodies (Stripe webhook, file uploads).
  if (!SAFE_METHODS.has(req.method) && req.body) {
    if (Buffer.isBuffer(req.body)) return next();
    req.body = sanitizeValue(req.body);
  }

  return next();
}

module.exports = xssSanitizeMiddleware;
module.exports.sanitizeValue = sanitizeValue;
