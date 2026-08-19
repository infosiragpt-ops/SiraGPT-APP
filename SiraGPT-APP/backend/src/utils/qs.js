'use strict';

/**
 * qs — query-string serializer + parser with the four canonical
 * array conventions. Pairs with the URL canonicalizer (#81),
 * resilient fetch (#61), and signed URL (#70). Fills the gap when
 * URLSearchParams isn't expressive enough (e.g., 'tags[]=a' /
 * 'tags=a,b' / 'tags[0]=a&tags[1]=b').
 *
 * arrayFormat:
 *   'repeat'  (default) — tags=a&tags=b
 *   'brackets'          — tags[]=a&tags[]=b
 *   'indices'           — tags[0]=a&tags[1]=b
 *   'comma'              — tags=a,b
 *
 * Public API:
 *   stringify(obj, { arrayFormat = 'repeat', sort = false, encoder })
 *   parse(qs, { arrayFormat = 'auto', decoder })
 *     'auto' detects per-key based on shape it sees (mostly intuitive
 *     for repeated keys + comma; brackets/indices need an explicit
 *     setting to round-trip cleanly).
 */

const enc = encodeURIComponent;
const dec = decodeURIComponent;

function safeDec(d, s) {
  try { return d(s); } catch { return s; }
}

function* serializeKey(key, value, format, encoder) {
  if (value == null) return;
  if (Array.isArray(value)) {
    if (format === 'comma') {
      yield `${encoder(key)}=${value.map((v) => encoder(v == null ? '' : String(v))).join(',')}`;
      return;
    }
    if (format === 'brackets') {
      for (const v of value) {
        if (v == null) continue;
        yield `${encoder(key + '[]')}=${encoder(String(v))}`;
      }
      return;
    }
    if (format === 'indices') {
      for (let i = 0; i < value.length; i++) {
        if (value[i] == null) continue;
        yield `${encoder(`${key}[${i}]`)}=${encoder(String(value[i]))}`;
      }
      return;
    }
    // repeat
    for (const v of value) {
      if (v == null) continue;
      yield `${encoder(key)}=${encoder(String(v))}`;
    }
    return;
  }
  if (typeof value === 'object') {
    // Nested objects are flattened with brackets — common qs-style.
    for (const [k, v] of Object.entries(value)) {
      yield* serializeKey(`${key}[${k}]`, v, format, encoder);
    }
    return;
  }
  yield `${encoder(key)}=${encoder(String(value))}`;
}

function stringify(obj, opts = {}) {
  if (obj == null || typeof obj !== 'object') return '';
  const format = ['repeat', 'brackets', 'indices', 'comma'].includes(opts.arrayFormat) ? opts.arrayFormat : 'repeat';
  const sort = Boolean(opts.sort);
  const encoder = typeof opts.encoder === 'function' ? opts.encoder : enc;

  let entries = Object.entries(obj);
  if (sort) entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out = [];
  for (const [k, v] of entries) {
    for (const part of serializeKey(k, v, format, encoder)) out.push(part);
  }
  return out.join('&');
}

function parse(qs, opts = {}) {
  if (typeof qs !== 'string') return {};
  if (qs.startsWith('?')) qs = qs.slice(1);
  if (!qs) return {};
  const decoder = typeof opts.decoder === 'function' ? opts.decoder : dec;
  const arrayFormat = opts.arrayFormat || 'auto';

  const out = {};
  for (const raw of qs.split('&')) {
    if (!raw) continue;
    const eq = raw.indexOf('=');
    let kRaw = eq === -1 ? raw : raw.slice(0, eq);
    let vRaw = eq === -1 ? '' : raw.slice(eq + 1);
    let key = safeDec(decoder, kRaw.replace(/\+/g, ' '));
    let value = safeDec(decoder, vRaw.replace(/\+/g, ' '));

    let isArrayHint = false;
    let idx = null;
    if (key.endsWith('[]')) { key = key.slice(0, -2); isArrayHint = true; }
    const idxMatch = /^(.+)\[(\d+)\]$/.exec(key);
    if (idxMatch) { key = idxMatch[1]; isArrayHint = true; idx = Number(idxMatch[2]); }

    if (arrayFormat === 'comma' && value.includes(',')) {
      out[key] = value.split(',');
      continue;
    }

    // Explicit array index ("a[2]=x") — honour the position so out-of-order
    // keys land at their declared index instead of arrival order.
    if (idx !== null) {
      if (!Array.isArray(out[key])) out[key] = (out[key] != null) ? [out[key]] : [];
      out[key][idx] = value;
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(out, key)) {
      const cur = out[key];
      out[key] = Array.isArray(cur) ? [...cur, value] : [cur, value];
    } else if (isArrayHint) {
      out[key] = [value];
    } else {
      out[key] = value;
    }
  }
  // Compact any holes left by sparse explicit indices (qs values are strings,
  // never undefined, so this only removes index gaps).
  for (const k of Object.keys(out)) {
    if (Array.isArray(out[k]) && out[k].includes(undefined)) {
      out[k] = out[k].filter((v) => v !== undefined);
    }
  }
  return out;
}

module.exports = {
  stringify,
  parse,
};
