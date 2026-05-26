'use strict';

/**
 * slugify — Unicode-aware URL-safe slug generator. Pairs with the
 * URL canonicalizer (#81) and case-convert (#101): when a piece of
 * arbitrary text needs to become a URL segment, file name, or stable
 * ID, this is the safe transformation.
 *
 * Pipeline:
 *   1. Unicode NFD decompose ('niño' → 'n', 'i', 'ñ' → 'n', 'i', 'n', '◌̃')
 *   2. Drop combining marks (\\p{M})
 *   3. Apply optional transliteration table for non-decomposable chars
 *      (ß → ss, æ → ae, ø → o, …)
 *   4. Lowercase, replace runs of non-[a-z0-9] with separator
 *   5. Trim leading/trailing separators, collapse runs
 *
 * Public API:
 *   slugify(text, { separator='-', maxLength?, custom })
 *     custom: Map<string, string> overlay (applied AFTER decompose)
 *   isSlug(s, { separator='-' }) → boolean
 *   defaultMap export
 */

// Letter-like ligatures: replace inline (straße → strasse).
const INLINE_MAP = new Map([
  ['ß', 'ss'], ['æ', 'ae'], ['Æ', 'AE'],
  ['œ', 'oe'], ['Œ', 'OE'],
  ['ø', 'o'], ['Ø', 'O'],
  ['ð', 'd'], ['Ð', 'D'],
  ['þ', 'th'], ['Þ', 'TH'],
  ['ł', 'l'], ['Ł', 'L'],
  ['ı', 'i'],
]);

// Symbol-like: replace with spaces around so they become word boundaries
// (R&B → 'R and B' → 'r-and-b').
const PADDED_MAP = new Map([
  ['€', 'eur'], ['£', 'gbp'], ['$', 'usd'], ['¥', 'jpy'],
  ['&', 'and'], ['+', 'plus'], ['@', 'at'],
]);

// Backwards-compatible alias for callers that imported defaultMap.
const DEFAULT_MAP = new Map([...INLINE_MAP, ...PADDED_MAP]);

function applyMap(text, map, padded) {
  let out = '';
  for (const ch of text) {
    if (map.has(ch)) {
      out += padded ? ` ${map.get(ch)} ` : map.get(ch);
    } else {
      out += ch;
    }
  }
  return out;
}

function slugify(text, { separator = '-', maxLength, custom } = {}) {
  if (typeof text !== 'string' || !text) return '';
  if (typeof separator !== 'string' || !separator) separator = '-';

  // 1. NFD decompose, drop combining marks.
  let decomposed = text.normalize('NFD').replace(/\p{M}+/gu, '');
  // 2. Apply maps: inline ligatures first, then padded symbols, then
  //    caller's custom overlay (padded so user-supplied entries become
  //    their own word).
  decomposed = applyMap(decomposed, INLINE_MAP, false);
  decomposed = applyMap(decomposed, PADDED_MAP, true);
  if (custom instanceof Map) decomposed = applyMap(decomposed, custom, true);
  // 3. Lowercase and replace non-alphanumeric runs.
  let slug = decomposed.toLowerCase().replace(/[^a-z0-9]+/g, separator);
  // 4. Trim leading/trailing separator.
  const sepRe = new RegExp(`^${separator.replace(/[.+^$|()*?[\\]{}\\\\]/g, '\\$&')}+|${separator.replace(/[.+^$|()*?[\\]{}\\\\]/g, '\\$&')}+$`, 'g');
  slug = slug.replace(sepRe, '');
  // 5. Truncate without splitting a separator boundary.
  if (Number.isInteger(maxLength) && maxLength > 0 && slug.length > maxLength) {
    slug = slug.slice(0, maxLength);
    // Don't end on a trailing separator after truncation.
    while (slug.endsWith(separator)) slug = slug.slice(0, -separator.length);
  }
  return slug;
}

function isSlug(s, { separator = '-' } = {}) {
  if (typeof s !== 'string' || !s) return false;
  const escSep = separator.replace(/[.+^$|()*?[\]{}\\]/g, '\\$&');
  const re = new RegExp(`^[a-z0-9]+(?:${escSep}[a-z0-9]+)*$`);
  return re.test(s);
}

module.exports = {
  slugify,
  isSlug,
  defaultMap: DEFAULT_MAP,
};
