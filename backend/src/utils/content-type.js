'use strict';

/**
 * content-type — RFC 7231 §3.1.1.5 parser + builder. Pairs with the
 * Accept negotiator (#88), MIME sniffer (#91), and the SSE family
 * (#17/#25/#38): when an endpoint reads or writes a Content-Type
 * header, this is the safe way to extract charset / boundary or
 * to build the canonical string back out.
 *
 * Quote handling is RFC-strict: parameter values containing token-
 * unsafe characters (whitespace, separators, …) round-trip through
 * a quoted-string with backslash-escaped " and \\ inside.
 *
 * Public API:
 *   parseContentType(header)    → { type, subtype, parameters } | null
 *   formatContentType(parts)    → string
 *   charsetOf(header, default?) → string | default
 *   isType(header, candidate)   → boolean (pattern: 'application/json',
 *                                  'text/*', '*\/json')
 */

const TOKEN_UNSAFE = /[^!#$%&'*+\-.^_`|~0-9A-Za-z]/;

function unquoteParam(s) {
  if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return s;
  let out = '';
  for (let i = 1; i < s.length - 1; i++) {
    if (s[i] === '\\' && i + 1 < s.length - 1) { out += s[i + 1]; i += 1; continue; }
    out += s[i];
  }
  return out;
}

function parseContentType(header) {
  if (typeof header !== 'string' || !header.trim()) return null;
  const parts = header.split(';').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const head = parts[0];
  const slash = head.indexOf('/');
  if (slash === -1) return null;
  const type = head.slice(0, slash).toLowerCase();
  const subtype = head.slice(slash + 1).toLowerCase();
  if (!type || !subtype) return null;
  const parameters = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    const k = p.slice(0, eq).trim().toLowerCase();
    const v = unquoteParam(p.slice(eq + 1).trim());
    if (k) parameters[k] = v;
  }
  return { type, subtype, parameters };
}

function formatContentType(parts) {
  if (!parts || typeof parts !== 'object') throw new TypeError('formatContentType: parts required');
  const { type, subtype, parameters } = parts;
  if (typeof type !== 'string' || typeof subtype !== 'string' || !type || !subtype) {
    throw new TypeError('formatContentType: type/subtype required');
  }
  let out = `${type.toLowerCase()}/${subtype.toLowerCase()}`;
  if (parameters && typeof parameters === 'object') {
    const keys = Object.keys(parameters).sort();
    for (const k of keys) {
      const v = parameters[k];
      if (v == null || v === '') continue;
      const s = String(v);
      const needsQuote = TOKEN_UNSAFE.test(s);
      const value = needsQuote ? `"${s.replace(/[\\"]/g, '\\$&')}"` : s;
      out += `; ${k.toLowerCase()}=${value}`;
    }
  }
  return out;
}

function charsetOf(header, fallback = null) {
  const p = parseContentType(header);
  return (p && p.parameters && p.parameters.charset) || fallback;
}

function isType(header, candidate) {
  if (typeof candidate !== 'string' || !candidate.includes('/')) return false;
  const got = parseContentType(header);
  if (!got) return false;
  const [t, s] = candidate.toLowerCase().split('/');
  return (t === '*' || t === got.type) && (s === '*' || s === got.subtype);
}

module.exports = {
  parseContentType,
  formatContentType,
  charsetOf,
  isType,
};
