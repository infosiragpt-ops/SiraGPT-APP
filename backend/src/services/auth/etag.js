'use strict';

/**
 * etag — RFC 7232 ETag generator + cache-revalidation matchers.
 * Pairs with the audit log (#14, request-id binding) and the
 * resilient fetch (#61, conditional GET): when an endpoint can
 * answer 304 Not Modified instead of re-shipping bytes, this is
 * what its handler reaches for.
 *
 * Strong vs weak: strong is byte-equal; weak ('W/' prefix) is
 * semantic-equal (response payload could differ in compression /
 * whitespace but means the same thing).
 *
 * Public API:
 *   strongEtag(input)             → '"<hex>"'
 *   weakEtag(input)               → 'W/"<hex>"'
 *   parseEtag(s)                  → { tag, weak }
 *   ifNoneMatchSatisfied(header, currentEtag)  → boolean
 *   ifModifiedSinceSatisfied(header, lastModifiedMs, { tolerance? }) → boolean
 *   shouldReturn304({ etag, lastModifiedMs, headers })
 *     → boolean
 */

const { createHash } = require('node:crypto');

function digest(input) {
  const buf = Buffer.isBuffer(input) ? input
    : input instanceof Uint8Array ? Buffer.from(input)
    : typeof input === 'string' ? Buffer.from(input, 'utf8')
    : Buffer.from(JSON.stringify(input || ''), 'utf8');
  // Truncate to 16 bytes (32 hex chars) — enough collision resistance
  // for ETag use, half the wire size of a full sha256.
  return createHash('sha256').update(buf).digest('hex').slice(0, 32);
}

function strongEtag(input) { return `"${digest(input)}"`; }
function weakEtag(input)   { return `W/"${digest(input)}"`; }

function parseEtag(s) {
  if (typeof s !== 'string' || !s) return null;
  const trimmed = s.trim();
  const weak = trimmed.startsWith('W/');
  const body = weak ? trimmed.slice(2) : trimmed;
  if (body.length < 2 || body[0] !== '"' || body[body.length - 1] !== '"') return null;
  return { tag: body.slice(1, -1), weak };
}

function ifNoneMatchSatisfied(header, currentEtag) {
  if (typeof header !== 'string' || !header) return false;
  const cur = parseEtag(currentEtag);
  if (!cur) return false;
  // '*' matches anything per spec.
  if (header.trim() === '*') return true;
  for (const raw of header.split(',')) {
    const e = parseEtag(raw);
    if (!e) continue;
    if (e.tag === cur.tag) return true;
  }
  return false;
}

function ifModifiedSinceSatisfied(header, lastModifiedMs, { tolerance = 0 } = {}) {
  if (typeof header !== 'string' || !header) return false;
  if (!Number.isFinite(lastModifiedMs)) return false;
  const headerMs = Date.parse(header);
  if (!Number.isFinite(headerMs)) return false;
  // "satisfied" = resource has NOT been modified since the header time
  return lastModifiedMs <= headerMs + tolerance;
}

function shouldReturn304({ etag, lastModifiedMs, headers = {} } = {}) {
  // RFC 7232: if both headers are present, If-None-Match takes precedence.
  const inm = headers['if-none-match'] || headers['If-None-Match'];
  if (inm && etag) return ifNoneMatchSatisfied(inm, etag);
  const ims = headers['if-modified-since'] || headers['If-Modified-Since'];
  if (ims && Number.isFinite(lastModifiedMs)) return ifModifiedSinceSatisfied(ims, lastModifiedMs);
  return false;
}

module.exports = {
  strongEtag,
  weakEtag,
  parseEtag,
  ifNoneMatchSatisfied,
  ifModifiedSinceSatisfied,
  shouldReturn304,
};
