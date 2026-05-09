'use strict';

/**
 * data-uri — RFC 2397 data: URI parser + builder. Pairs with the
 * MIME sniffer (#91), Content-Type parser (#92), and the agent
 * pipeline that occasionally inlines images / PDFs in responses.
 *
 * Format:
 *   data:[<mediatype>][;base64],<data>
 *   mediatype = type/subtype[;parameter=value]…
 *
 * Public API:
 *   parseDataUri(uri)
 *     → { mime, parameters, data: Buffer, base64 } | null
 *   buildDataUri({ mime = 'application/octet-stream', parameters,
 *                  data, base64 = true }) → string
 *   isDataUri(s) → boolean
 */

function parseDataUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('data:')) return null;
  const comma = uri.indexOf(',');
  if (comma === -1) return null;
  const meta = uri.slice('data:'.length, comma);
  const body = uri.slice(comma + 1);
  const parts = meta.split(';');
  let mime = 'text/plain';
  const parameters = {};
  let isBase64 = false;
  if (parts[0] && parts[0].includes('/')) {
    mime = parts[0].toLowerCase();
    parts.shift();
  }
  for (const p of parts) {
    if (p === 'base64') { isBase64 = true; continue; }
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    parameters[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1);
  }
  let data;
  try {
    data = isBase64 ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8');
  } catch {
    return null;
  }
  return { mime, parameters, data, base64: isBase64 };
}

function buildDataUri({ mime = 'application/octet-stream', parameters = null, data, base64 = true } = {}) {
  let buf;
  if (Buffer.isBuffer(data)) buf = data;
  else if (data instanceof Uint8Array) buf = Buffer.from(data);
  else if (typeof data === 'string') buf = Buffer.from(data, 'utf8');
  else throw new TypeError('buildDataUri: data must be Buffer | Uint8Array | string');

  let meta = String(mime).toLowerCase();
  if (parameters && typeof parameters === 'object') {
    for (const [k, v] of Object.entries(parameters)) {
      if (v == null) continue;
      meta += `;${String(k).toLowerCase()}=${v}`;
    }
  }
  if (base64) return `data:${meta};base64,${buf.toString('base64')}`;
  return `data:${meta},${encodeURIComponent(buf.toString('utf8'))}`;
}

function isDataUri(s) {
  return typeof s === 'string' && /^data:[^,]*,/.test(s);
}

module.exports = {
  parseDataUri,
  buildDataUri,
  isDataUri,
};
