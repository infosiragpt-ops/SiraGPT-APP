'use strict';

/**
 * csv — RFC 4180 parser + serializer. No deps. Pairs with the NDJSON
 * parser (#62) for streaming row-oriented data and the document
 * pipeline already in the repo for spreadsheet ingest. Sufficient for
 * uploads/exports without pulling in a 200KB CSV library.
 *
 * Conformance points:
 *   - Quoted fields ("…") allow embedded `"` (escaped as `""`),
 *     commas, and newlines.
 *   - CRLF and LF row terminators both accepted; serializer emits
 *     CRLF per spec but the configurable.
 *   - Optional header row → array of objects keyed by header.
 *   - Custom delimiter (',' default; '\t' for TSV).
 *
 * Public API:
 *   parseCsv(text, { delimiter, headers, trim })
 *     headers: 'auto' (use first row), array (caller-provided), false
 *     → { headers, rows }   when headers in use, rows = array of objects
 *                            otherwise rows = array of string[]
 *
 *   serializeCsv(rows, { headers, delimiter, eol })
 *     rows can be array of objects or array of arrays.
 */

const DEFAULT_DELIM = ',';
const DEFAULT_EOL = '\r\n';

function parseCsv(text, opts = {}) {
  if (typeof text !== 'string') return { headers: null, rows: [] };
  const delim = typeof opts.delimiter === 'string' && opts.delimiter ? opts.delimiter : DEFAULT_DELIM;
  const trim = Boolean(opts.trim);
  const wantHeaders = opts.headers !== false; // default: auto-headers from first row
  const givenHeaders = Array.isArray(opts.headers) ? opts.headers.slice() : null;

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"' && field.length === 0) { inQuotes = true; i += 1; continue; }
    if (ch === delim) { row.push(trim ? field.trim() : field); field = ''; i += 1; continue; }
    if (ch === '\r' && text[i + 1] === '\n') {
      row.push(trim ? field.trim() : field); field = '';
      rows.push(row); row = [];
      i += 2; continue;
    }
    if (ch === '\n') {
      row.push(trim ? field.trim() : field); field = '';
      rows.push(row); row = [];
      i += 1; continue;
    }
    field += ch; i += 1;
  }
  // Tail
  if (field.length > 0 || row.length > 0) {
    row.push(trim ? field.trim() : field);
    rows.push(row);
  }
  // Drop a final empty row that sometimes follows a trailing newline.
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
    rows.pop();
  }

  let headers = null;
  let dataRows = rows;
  if (givenHeaders) {
    headers = givenHeaders;
  } else if (wantHeaders && rows.length > 0) {
    headers = rows[0];
    dataRows = rows.slice(1);
  }
  if (headers) {
    const objects = dataRows.map((r) => {
      const out = {};
      for (let j = 0; j < headers.length; j++) out[headers[j]] = r[j] != null ? r[j] : '';
      return out;
    });
    return { headers, rows: objects };
  }
  return { headers: null, rows };
}

function escapeField(value, delim) {
  const s = value == null ? '' : String(value);
  if (s.includes('"') || s.includes(delim) || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function serializeCsv(rows, opts = {}) {
  const delim = typeof opts.delimiter === 'string' && opts.delimiter ? opts.delimiter : DEFAULT_DELIM;
  const eol = typeof opts.eol === 'string' && opts.eol ? opts.eol : DEFAULT_EOL;
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const headers = Array.isArray(opts.headers)
    ? opts.headers.slice()
    : (rows[0] && typeof rows[0] === 'object' && !Array.isArray(rows[0]))
      ? Object.keys(rows[0])
      : null;
  const lines = [];
  if (headers) {
    lines.push(headers.map((h) => escapeField(h, delim)).join(delim));
    for (const r of rows) {
      const cells = headers.map((h) => escapeField((r && typeof r === 'object') ? r[h] : '', delim));
      lines.push(cells.join(delim));
    }
  } else {
    for (const r of rows) {
      const cells = (Array.isArray(r) ? r : [r]).map((v) => escapeField(v, delim));
      lines.push(cells.join(delim));
    }
  }
  return lines.join(eol) + eol;
}

module.exports = {
  parseCsv,
  serializeCsv,
  escapeField,
};
