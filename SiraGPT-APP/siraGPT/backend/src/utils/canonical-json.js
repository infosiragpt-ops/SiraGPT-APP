'use strict';

/**
 * canonical-json — RFC 8785-style JSON Canonicalization (JCS):
 * deterministic JSON serialization with sorted object keys, no
 * whitespace, ECMAScript-style number formatting, and proper string
 * escaping. The same input always serializes to the same bytes
 * across processes — exactly what cache keys, signed payloads (#48
 * HMAC), and idempotency keys (#13) need.
 *
 * Supported value types: string, number (finite), boolean, null,
 * Array, plain Object. Throws on undefined, function, BigInt,
 * Symbol, NaN, Infinity, or circular references — encoding any of
 * those non-deterministically would defeat the point.
 *
 * Why not JSON.stringify with a sorting replacer:
 *   - Replacers run AFTER deciding object/array shape, so they
 *     don't actually sort keys; they just transform values.
 *   - JSON.stringify allows NaN/Infinity → "null" silently, which
 *     is the kind of thing that makes a signed payload mismatch
 *     on the wire.
 *
 * Public API:
 *   canonicalize(value)         → string
 *   canonicalizeBuffer(value)   → Buffer (utf8 bytes of canonical form)
 *   sha256Hex(value)            → 64-char hex of sha256(canonical)
 */

const { createHash } = require('node:crypto');

class CanonicalJsonError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CanonicalJsonError';
    this.code = code;
  }
}

const ESCAPE_MAP = {
  '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f',
  '\n': '\\n', '\r': '\\r', '\t': '\\t',
};

function encodeString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const mapped = ESCAPE_MAP[ch];
    if (mapped) { out += mapped; continue; }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      out += ch;
    }
  }
  return out + '"';
}

function encodeNumber(n) {
  if (!Number.isFinite(n)) {
    throw new CanonicalJsonError(`canonical-json: non-finite number ${n}`, 'NON_FINITE_NUMBER');
  }
  // ECMAScript Number-to-String already canonicalizes: shortest
  // round-trippable string. -0 collapses to '0' per JCS.
  if (Object.is(n, -0)) return '0';
  return String(n);
}

function encode(value, seen) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return encodeString(value);
  if (t === 'number') return encodeNumber(value);
  if (t === 'bigint') {
    throw new CanonicalJsonError('canonical-json: BigInt not supported', 'UNSUPPORTED_TYPE');
  }
  if (t === 'function' || t === 'undefined' || t === 'symbol') {
    throw new CanonicalJsonError(`canonical-json: ${t} not allowed`, 'UNSUPPORTED_TYPE');
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new CanonicalJsonError('canonical-json: circular array', 'CIRCULAR');
    seen.add(value);
    const parts = value.map((x) => encode(x, seen));
    seen.delete(value);
    return `[${parts.join(',')}]`;
  }
  // Plain object: sort keys (UTF-16 code-unit order, per JCS).
  if (seen.has(value)) throw new CanonicalJsonError('canonical-json: circular object', 'CIRCULAR');
  seen.add(value);
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    const v = value[k];
    if (v === undefined) continue; // skip undefined-valued keys per JSON convention
    parts.push(`${encodeString(k)}:${encode(v, seen)}`);
  }
  seen.delete(value);
  return `{${parts.join(',')}}`;
}

function canonicalize(value) {
  return encode(value, new Set());
}

function canonicalizeBuffer(value) {
  return Buffer.from(canonicalize(value), 'utf8');
}

function sha256Hex(value) {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

module.exports = {
  canonicalize,
  canonicalizeBuffer,
  sha256Hex,
  CanonicalJsonError,
};
