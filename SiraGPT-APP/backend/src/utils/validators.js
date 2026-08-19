'use strict';

/**
 * validators — small bundle of predicate-style validators. Pairs
 * with the mini-schema (#60) and tool-args validator (#27): when
 * a schema field needs "must be email / URL / UUID", these are the
 * canonical checks reused everywhere.
 *
 * All validators return boolean; never throw on bad input. They are
 * deliberately simple (RFC-strict only where the looseness matters):
 * use them for input gating and surface anything richer through the
 * relevant parser.
 *
 * Public API:
 *   isEmail(s)           — RFC 5321 simplified
 *   isUrl(s, { protocols, requireProtocol })  — http(s) by default
 *   isUuid(s, { version })   — v1-v8; version=null accepts any
 *   isIso8601(s)         — date-time per ECMAScript Date.parse + shape check
 *   isDate(s)            — yyyy-mm-dd
 *   isE164(s)            — +12025550100 phone
 */

const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

function isEmail(s) {
  if (typeof s !== 'string' || !s) return false;
  if (s.length > 254) return false;
  if (!EMAIL_RE.test(s)) return false;
  // Reject consecutive dots in local part.
  const at = s.indexOf('@');
  const local = s.slice(0, at);
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  return true;
}

function isUrl(s, { protocols = ['http:', 'https:'], requireProtocol = true } = {}) {
  if (typeof s !== 'string' || !s) return false;
  let u;
  try {
    u = new URL(s, requireProtocol ? undefined : 'http://placeholder');
  } catch { return false; }
  if (requireProtocol) {
    return Array.isArray(protocols) ? protocols.includes(u.protocol) : true;
  }
  // Accept relative paths only when requireProtocol is false.
  return true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-([1-8])[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

function isUuid(s, { version } = {}) {
  if (typeof s !== 'string' || !s) return false;
  if (s.toLowerCase() === NIL_UUID) return version == null; // nil only when no specific version requested
  const m = UUID_RE.exec(s);
  if (!m) return false;
  if (version == null) return true;
  return Number(m[1]) === Number(version);
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;
function isIso8601(s) {
  if (typeof s !== 'string' || !s) return false;
  if (!ISO_RE.test(s)) return false;
  return Number.isFinite(Date.parse(s));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // Reject Feb 30, etc., via Date's own normalization.
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const E164_RE = /^\+[1-9]\d{1,14}$/;
function isE164(s) {
  return typeof s === 'string' && E164_RE.test(s);
}

module.exports = {
  isEmail,
  isUrl,
  isUuid,
  isIso8601,
  isDate,
  isE164,
};
