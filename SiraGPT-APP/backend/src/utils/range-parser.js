'use strict';

/**
 * range-parser — RFC 7233 Range header parser. Pairs with the audit
 * log (#14, downloads), ETag (#87, conditional GET), and the
 * resilient fetch (#61): when an endpoint serves a large file (PDF
 * upload, generated artifact, exported CSV), Range support lets
 * clients resume interrupted downloads.
 *
 * Supports byte-range only (the common case). Returns either a list
 * of normalized { start, end } byte offsets, the literal string
 * 'unsatisfiable' when the request is malformed in a way that calls
 * for HTTP 416, or null when no Range header was present.
 *
 * Public API:
 *   parseRange(header, totalSize)         → null | [{start,end}] | 'unsatisfiable'
 *   formatContentRange(range, totalSize)  → 'bytes <start>-<end>/<total>' string
 *   suffixToAbsolute(suffix, total)       → { start, end }
 */

// Strict RFC 7233 integer: ASCII digits only. Plain Number() would accept
// hex (0x10), exponent (1e2), binary (0b1), signs and surrounding whitespace,
// causing a malformed Range to resolve to the WRONG byte offsets instead of
// 416. Returns NaN for anything that isn't a run of decimal digits.
function decInt(s) {
  return /^\d+$/.test(s) ? Number(s) : NaN;
}

function suffixToAbsolute(suffix, total) {
  // 'bytes=-N' → last N bytes
  if (!Number.isInteger(suffix) || suffix <= 0 || total <= 0) return null;
  const start = Math.max(0, total - suffix);
  return { start, end: total - 1 };
}

function parseRange(header, totalSize) {
  if (header == null) return null;
  if (typeof header !== 'string') return 'unsatisfiable';
  const trimmed = header.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('bytes=')) return 'unsatisfiable';
  if (!Number.isInteger(totalSize) || totalSize < 0) return 'unsatisfiable';
  const body = trimmed.slice('bytes='.length);
  if (!body) return 'unsatisfiable';

  const ranges = [];
  for (const raw of body.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const dash = part.indexOf('-');
    if (dash === -1) return 'unsatisfiable';
    const startStr = part.slice(0, dash);
    const endStr = part.slice(dash + 1);
    let start, end;
    if (startStr === '' && endStr !== '') {
      const suffix = decInt(endStr);
      const abs = suffixToAbsolute(suffix, totalSize);
      if (!abs) return 'unsatisfiable';
      start = abs.start; end = abs.end;
    } else if (startStr !== '' && endStr === '') {
      start = decInt(startStr);
      end = totalSize - 1;
    } else if (startStr !== '' && endStr !== '') {
      start = decInt(startStr);
      end = decInt(endStr);
    } else {
      return 'unsatisfiable';
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) return 'unsatisfiable';
    if (start > end) return 'unsatisfiable';
    if (start >= totalSize) return 'unsatisfiable';
    if (end >= totalSize) end = totalSize - 1;
    ranges.push({ start, end });
  }
  if (ranges.length === 0) return 'unsatisfiable';
  return ranges;
}

function formatContentRange(range, totalSize) {
  if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end)) {
    throw new TypeError('formatContentRange: range with start/end required');
  }
  return `bytes ${range.start}-${range.end}/${totalSize}`;
}

module.exports = {
  parseRange,
  formatContentRange,
  suffixToAbsolute,
};
