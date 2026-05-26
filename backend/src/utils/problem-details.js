'use strict';

/**
 * problem-details — RFC 7807 application/problem+json builder + parser.
 * Closes the HTTP toolkit (#87 ETag + #88 Accept + #89 Range +
 * #90 Cache-Control + #91 MIME + #92 Content-Type) with the
 * standard error envelope: every HTTP error response we emit looks
 * the same shape, every external API we consume parses cleanly.
 *
 * Spec: https://www.rfc-editor.org/rfc/rfc7807
 *
 * Standard members:
 *   type     — URI reference identifying the problem class (default
 *              'about:blank')
 *   title    — short human-readable summary
 *   status   — HTTP status code (integer)
 *   detail   — human-readable explanation specific to this occurrence
 *   instance — URI reference identifying the specific occurrence
 *
 * Extensions (any other own-key) are preserved through the round-trip.
 *
 * Public API:
 *   problem({ type, title, status, detail, instance, ...extensions })
 *     → frozen object
 *   isProblem(o) → boolean
 *   parseProblem(text)              → object | null
 *   contentType                     → 'application/problem+json'
 */

const CONTENT_TYPE = 'application/problem+json';
const DEFAULT_TYPE = 'about:blank';

const STANDARD_KEYS = new Set(['type', 'title', 'status', 'detail', 'instance']);

function problem(input = {}) {
  if (input && typeof input !== 'object') throw new TypeError('problem-details: object input required');
  const out = {
    type: typeof input.type === 'string' && input.type ? input.type : DEFAULT_TYPE,
  };
  if (typeof input.title === 'string') out.title = input.title;
  if (Number.isInteger(input.status)) out.status = input.status;
  if (typeof input.detail === 'string') out.detail = input.detail;
  if (typeof input.instance === 'string') out.instance = input.instance;
  // Extensions: copy any own-key not in STANDARD_KEYS verbatim.
  for (const [k, v] of Object.entries(input)) {
    if (STANDARD_KEYS.has(k)) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return Object.freeze(out);
}

function isProblem(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  // RFC 7807: type is the only field that MUST be present (default
  // 'about:blank' when problem is generic). We accept any object with
  // at least one of type / title / status / detail / instance set
  // because the wire is rarely strict about a stand-alone 'about:blank'.
  for (const k of STANDARD_KEYS) if (k in o) return true;
  return false;
}

function parseProblem(text) {
  if (typeof text !== 'string' || !text) return null;
  let obj;
  try { obj = JSON.parse(text); }
  catch { return null; }
  if (!isProblem(obj)) return null;
  return problem(obj);
}

module.exports = {
  problem,
  isProblem,
  parseProblem,
  contentType: CONTENT_TYPE,
  STANDARD_KEYS,
  DEFAULT_TYPE,
};
