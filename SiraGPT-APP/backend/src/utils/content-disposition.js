'use strict';

/**
 * content-disposition — RFC 6266 / RFC 5987 builder + parser.
 *
 * Used by file-download endpoints. Building "Content-Disposition:
 * attachment; filename=\"x.pdf\"" by hand goes wrong fast for non-
 * ASCII names because RFC 6266 requires both the legacy `filename=`
 * form (for compatibility) and the `filename*=UTF-8''...` form (for
 * UTF-8). This helper does both, plus a parser that handles either.
 *
 * Public API:
 *   build({ type='attachment', filename })  → header value string
 *   parse(headerValue)                       → { type, parameters }
 *   encodeRFC5987(value)                     — UTF-8 percent encoding
 *
 * The legacy filename param is ASCII-fallback (non-ASCII chars
 * replaced with '_'). Quotes inside the filename are escaped.
 */

const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const QUOTE_RE = /["\\]/g;

function asciiFallback(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += (c >= 0x20 && c < 0x7f) ? s[i] : '_';
  }
  return out;
}

function encodeRFC5987(s) {
  return encodeURIComponent(s)
    // Restore characters that encodeURIComponent leaves alone but
    // RFC 5987 still considers attribute-character-safe.
    .replace(/['()]/g, escape)
    .replace(/\*/g, '%2A')
    // Re-pct-encode reserved punctuation to be conservative.
    .replace(/%(7C|60|5E)/g, (_, hex) => '%' + hex);
}

function build(opts = {}) {
  const type = (opts.type || 'attachment').toLowerCase();
  if (!TOKEN_RE.test(type)) throw new TypeError('content-disposition: invalid type');
  if (opts.filename === undefined) return type;
  if (typeof opts.filename !== 'string' || opts.filename.length === 0) {
    throw new TypeError('content-disposition: filename must be non-empty string');
  }

  const ascii = asciiFallback(opts.filename).replace(QUOTE_RE, '\\$&');
  let header = `${type}; filename="${ascii}"`;
  // Emit RFC 5987 form when filename has non-ASCII.
  if (/[^\x20-\x7e]/.test(opts.filename) || /["\\]/.test(opts.filename)) {
    header += `; filename*=UTF-8''${encodeRFC5987(opts.filename)}`;
  }
  return header;
}

function decodeQuoted(s) {
  return s.replace(/\\(.)/g, '$1');
}

function decodeRFC5987(s) {
  // Format: charset'lang'value
  const m = /^([^']+)'([^']*)'(.*)$/.exec(s);
  if (!m) return s;
  const charset = m[1].toLowerCase();
  const value = m[3];
  if (charset !== 'utf-8' && charset !== 'iso-8859-1') return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parse(header) {
  if (typeof header !== 'string' || header.length === 0) {
    throw new TypeError('content-disposition: header must be non-empty string');
  }
  // Split on ';' but respect quoted strings.
  const tokens = [];
  let buf = '';
  let inQ = false;
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (inQ) {
      if (c === '\\' && i + 1 < header.length) { buf += c + header[++i]; continue; }
      if (c === '"') inQ = false;
      buf += c;
    } else {
      if (c === '"') { inQ = true; buf += c; continue; }
      if (c === ';') { tokens.push(buf); buf = ''; continue; }
      buf += c;
    }
  }
  if (buf.length > 0) tokens.push(buf);

  if (tokens.length === 0 || tokens[0].trim() === '') {
    throw new TypeError('content-disposition: empty type');
  }
  const type = tokens[0].trim().toLowerCase();
  if (!TOKEN_RE.test(type)) throw new TypeError('content-disposition: invalid type');

  const parameters = {};
  for (let i = 1; i < tokens.length; i++) {
    const eq = tokens[i].indexOf('=');
    if (eq === -1) continue;
    const rawKey = tokens[i].slice(0, eq).trim().toLowerCase();
    let rawVal = tokens[i].slice(eq + 1).trim();
    if (rawVal.startsWith('"') && rawVal.endsWith('"')) {
      rawVal = decodeQuoted(rawVal.slice(1, -1));
    }
    if (rawKey.endsWith('*')) {
      const baseKey = rawKey.slice(0, -1);
      parameters[baseKey] = decodeRFC5987(rawVal);
    } else if (!Object.prototype.hasOwnProperty.call(parameters, rawKey)) {
      // Don't overwrite an already-set extended param with the legacy fallback.
      parameters[rawKey] = rawVal;
    }
  }

  return { type, parameters };
}

module.exports = {
  build,
  parse,
  encodeRFC5987,
};
