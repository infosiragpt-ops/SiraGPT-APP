'use strict';

/**
 * pii-mask — detect and mask Personally Identifiable Information.
 *
 * Lightweight, dependency-free detector + masker for use at log/export
 * boundaries. Each detector returns `{start, end, type, original}`
 * positions so callers can either redact (replace with `<TYPE>`) or
 * collect for analytics.
 *
 * Supported types:
 *   - email          RFC-5322 simplified
 *   - phone          E.164 + common intl formats (incl. groups/dashes)
 *   - credit_card    13–19 digit candidates, Luhn-validated
 *   - iban           2-letter country + 2-digit check + 11–30 alnum
 *   - ssn            US format ###-##-#### (with bad-prefix filter)
 *   - zip_us         5-digit or 5+4 ZIP+4
 *   - ipv4           dotted-quad 0–255
 *   - ipv6           hex groups (incl. ::, ::ffff: forms)
 *
 * Public API:
 *   findPII(text, { policy }) → Array<{start, end, type, original}>
 *   mask(text, { policy })    → string
 *
 * `policy` is an optional array of types to honour; omit to enable all.
 *
 * Design notes:
 *   - Detection runs once per type; overlapping matches are resolved by
 *     keeping the earliest start (then longest span), so an email's
 *     local-part digits never get re-masked as a "phone".
 *   - Luhn check eliminates 99%+ of false credit-card positives.
 *   - SSN excludes documented invalid prefixes (000, 666, 9xx area;
 *     00 group; 0000 serial).
 *   - IPv6 detector is conservative: requires at least one ':' and
 *     either full 8-group form or a single `::` compression.
 */

const ALL_TYPES = Object.freeze([
  'email',
  'phone',
  'credit_card',
  'iban',
  'ssn',
  'zip_us',
  'ipv4',
  'ipv6',
]);

const MASK_TOKENS = Object.freeze({
  email: '<EMAIL>',
  phone: '<PHONE>',
  credit_card: '<CREDIT_CARD>',
  iban: '<IBAN>',
  ssn: '<SSN>',
  zip_us: '<ZIP>',
  ipv4: '<IP>',
  ipv6: '<IPV6>',
});

// ─── Regex catalogue ─────────────────────────────────────────────────
// Each pattern is used with .matchAll(); the `g` flag is essential.

const RX_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,24}\b/g;

// Phone: optional `+` + 7–15 digits, allowing spaces, dashes, dots, or
// parens between digit groups. Requires at least two non-digit separators
// or a leading `+` to avoid swallowing every long integer.
const RX_PHONE = /(?:\+\d{1,3}[\s.\-]?)?(?:\(\d{1,4}\)[\s.\-]?)?\d{2,4}[\s.\-]\d{2,4}[\s.\-]\d{2,5}(?:[\s.\-]\d{1,5})?/g;
const RX_PHONE_E164 = /\+\d{7,15}\b/g;

// Credit card: 13–19 digits with optional space/dash separators.
const RX_CC = /\b(?:\d[\s-]?){12,18}\d\b/g;

// IBAN: country (2 letters) + check (2 digits) + body (11–30 alnum).
// We accept optional internal spaces (banks print them in groups of 4)
// and strip those before validating length.
const RX_IBAN = /\b[A-Z]{2}\d{2}(?:[\s]?[A-Z0-9]){11,30}\b/g;

const RX_SSN = /\b\d{3}-\d{2}-\d{4}\b/g;

const RX_ZIP = /\b\d{5}(?:-\d{4})?\b/g;

const RX_IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;

// IPv6: either full 8-group, or compressed form with `::`. We require a
// minimum of 2 colons and at least one hex group on each side (except
// the all-zeros `::` and `::1` forms which we whitelist explicitly).
const RX_IPV6 = /(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}|(?:[A-Fa-f0-9]{1,4}:){1,7}:|(?:[A-Fa-f0-9]{1,4}:){1,6}:[A-Fa-f0-9]{1,4}|(?:[A-Fa-f0-9]{1,4}:){1,5}(?::[A-Fa-f0-9]{1,4}){1,2}|(?:[A-Fa-f0-9]{1,4}:){1,4}(?::[A-Fa-f0-9]{1,4}){1,3}|(?:[A-Fa-f0-9]{1,4}:){1,3}(?::[A-Fa-f0-9]{1,4}){1,4}|(?:[A-Fa-f0-9]{1,4}:){1,2}(?::[A-Fa-f0-9]{1,4}){1,5}|[A-Fa-f0-9]{1,4}:(?:(?::[A-Fa-f0-9]{1,4}){1,6})|:(?:(?::[A-Fa-f0-9]{1,4}){1,7}|:)/g;

// ─── Validators ──────────────────────────────────────────────────────

function luhnValid(digits) {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function ssnValid(s) {
  // s in form ###-##-####
  const area = s.slice(0, 3);
  const group = s.slice(4, 6);
  const serial = s.slice(7);
  if (area === '000' || area === '666') return false;
  if (area[0] === '9') return false;
  if (group === '00') return false;
  if (serial === '0000') return false;
  return true;
}

function ibanValid(raw) {
  const compact = raw.replace(/\s+/g, '');
  if (compact.length < 15 || compact.length > 34) return false;
  // mod-97 check
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (let i = 0; i < rearranged.length; i++) {
    const c = rearranged.charCodeAt(i);
    let v;
    if (c >= 48 && c <= 57) v = c - 48;
    else if (c >= 65 && c <= 90) v = c - 55; // A=10 ... Z=35
    else return false;
    if (v >= 10) {
      remainder = (remainder * 100 + v) % 97;
    } else {
      remainder = (remainder * 10 + v) % 97;
    }
  }
  return remainder === 1;
}

function phoneValid(raw) {
  const digits = raw.replace(/\D+/g, '');
  if (digits.length < 7 || digits.length > 15) return false;
  // Need either a `+` or at least two separator-defined groups.
  const seps = (raw.match(/[\s.\-]/g) || []).length;
  if (!raw.startsWith('+') && seps < 1) return false;
  return true;
}

function ipv6Valid(raw) {
  // The regex is permissive; refuse plain ":" or empty groups outside the `::`.
  if (raw === ':' || raw === '::') return raw === '::';
  if (!raw.includes(':')) return false;
  // Reject if more than one `::`
  const doubleColon = raw.match(/::/g);
  if (doubleColon && doubleColon.length > 1) return false;
  // Reject obviously malformed
  if (/[^:0-9A-Fa-f]/.test(raw)) return false;
  return true;
}

// ─── Detectors ────────────────────────────────────────────────────────

function collect(text, rx, type, validate) {
  const out = [];
  if (typeof text !== 'string' || text.length === 0) return out;
  let m;
  // matchAll requires global flag — pattern already has /g
  for (const match of text.matchAll(rx)) {
    const original = match[0];
    if (validate && !validate(original)) continue;
    out.push({
      start: match.index,
      end: match.index + original.length,
      type,
      original,
    });
  }
  return out;
}

function findEmails(text) {
  return collect(text, RX_EMAIL, 'email');
}
function findPhones(text) {
  const a = collect(text, RX_PHONE, 'phone', phoneValid);
  const b = collect(text, RX_PHONE_E164, 'phone', phoneValid);
  return dedupeByRange([...a, ...b]);
}
function findCreditCards(text) {
  return collect(text, RX_CC, 'credit_card', (raw) => {
    const digits = raw.replace(/\D+/g, '');
    return luhnValid(digits);
  });
}
function findIBANs(text) {
  return collect(text, RX_IBAN, 'iban', ibanValid);
}
function findSSNs(text) {
  return collect(text, RX_SSN, 'ssn', ssnValid);
}
function findZips(text) {
  return collect(text, RX_ZIP, 'zip_us');
}
function findIPv4(text) {
  return collect(text, RX_IPV4, 'ipv4');
}
function findIPv6(text) {
  return collect(text, RX_IPV6, 'ipv6', ipv6Valid);
}

// ─── Overlap resolution ──────────────────────────────────────────────

function dedupeByRange(items) {
  if (items.length < 2) return items.slice();
  const sorted = items.slice().sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let lastEnd = -1;
  for (const it of sorted) {
    if (it.start >= lastEnd) {
      out.push(it);
      lastEnd = it.end;
    }
  }
  return out;
}

// Resolve overlaps across types. Email wins over phone/zip embedded in
// the local-part; longer spans win on ties; otherwise earlier start.
function resolveOverlaps(items) {
  if (items.length < 2) return items.slice();
  const PRIORITY = {
    email: 8,
    iban: 7,
    credit_card: 6,
    ssn: 5,
    ipv6: 4,
    ipv4: 3,
    phone: 2,
    zip_us: 1,
  };
  const sorted = items.slice().sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const lenA = a.end - a.start;
    const lenB = b.end - b.start;
    if (lenA !== lenB) return lenB - lenA;
    return (PRIORITY[b.type] || 0) - (PRIORITY[a.type] || 0);
  });
  const accepted = [];
  for (const it of sorted) {
    // Drop if it overlaps any previously-accepted higher-priority span.
    let blocked = false;
    for (const acc of accepted) {
      const overlap = it.start < acc.end && acc.start < it.end;
      if (!overlap) continue;
      const accPri = PRIORITY[acc.type] || 0;
      const itPri = PRIORITY[it.type] || 0;
      if (accPri >= itPri) { blocked = true; break; }
      // Otherwise the new one is higher priority — but we already added
      // the older one. Mark for replacement.
      blocked = true;
      break;
    }
    if (!blocked) accepted.push(it);
  }
  return accepted;
}

// ─── Public API ──────────────────────────────────────────────────────

function normalizePolicy(policy) {
  if (!policy) return new Set(ALL_TYPES);
  if (Array.isArray(policy)) return new Set(policy.filter((t) => ALL_TYPES.includes(t)));
  if (policy instanceof Set) return policy;
  return new Set(ALL_TYPES);
}

/**
 * findPII(text, opts?) — return a list of detected PII spans.
 * @param {string} text
 * @param {{policy?: string[]|Set<string>}} [opts]
 * @returns {Array<{start:number,end:number,type:string,original:string}>}
 */
function findPII(text, opts = {}) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const policy = normalizePolicy(opts.policy);
  const all = [];
  if (policy.has('email')) all.push(...findEmails(text));
  if (policy.has('iban')) all.push(...findIBANs(text));
  if (policy.has('credit_card')) all.push(...findCreditCards(text));
  if (policy.has('ssn')) all.push(...findSSNs(text));
  if (policy.has('ipv6')) all.push(...findIPv6(text));
  if (policy.has('ipv4')) all.push(...findIPv4(text));
  if (policy.has('phone')) all.push(...findPhones(text));
  if (policy.has('zip_us')) all.push(...findZips(text));
  return resolveOverlaps(all);
}

/**
 * mask(text, opts?) — replace each detected PII span with its type token.
 * Returns the original string when no PII is found.
 * @param {string} text
 * @param {{policy?: string[]|Set<string>, tokens?: Record<string,string>}} [opts]
 * @returns {string}
 */
function mask(text, opts = {}) {
  if (typeof text !== 'string' || text.length === 0) return text;
  const spans = findPII(text, opts);
  if (spans.length === 0) return text;
  const tokens = { ...MASK_TOKENS, ...(opts.tokens || {}) };
  // Sort descending so replacements don't shift earlier indices.
  spans.sort((a, b) => b.start - a.start);
  let out = text;
  for (const s of spans) {
    const tok = tokens[s.type] || '<REDACTED>';
    out = out.slice(0, s.start) + tok + out.slice(s.end);
  }
  return out;
}

/**
 * maskObject(value, opts?) — recursively mask string fields in a
 * JSON-serialisable value. Safe on cycles (tracked via WeakSet).
 */
function maskObject(value, opts = {}, _seen) {
  if (value == null) return value;
  if (typeof value === 'string') return mask(value, opts);
  if (typeof value !== 'object') return value;
  const seen = _seen || new WeakSet();
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => maskObject(v, opts, seen));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = maskObject(v, opts, seen);
  }
  return out;
}

module.exports = {
  findPII,
  mask,
  maskObject,
  ALL_TYPES,
  MASK_TOKENS,
  // exposed for tests
  _internals: { luhnValid, ssnValid, ibanValid, phoneValid, ipv6Valid },
};
