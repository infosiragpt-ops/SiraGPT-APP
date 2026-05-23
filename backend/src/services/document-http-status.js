'use strict';

/**
 * document-http-status.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects HTTP status codes referenced in tech docs, API specs,
 * postmortems, runbooks:
 *
 *   - "HTTP 200", "Status: 404", "503 Service Unavailable"
 *   - Inline: "returns a 401" / "a 503 will retry"
 *   - Classified by semantic class: 1xx informational, 2xx success,
 *     3xx redirect, 4xx client error, 5xx server error
 *
 * Different from document-priority (P0/P1) and document-network (ports).
 * Routes "what status?" / "is it a 4xx error?" to a citeable list.
 *
 * Public API:
 *   extractHttpStatus(text)         → HttpStatusReport
 *   buildHttpStatusForFiles(files)  → { perFile, aggregate, byClass }
 *   renderHttpStatusBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4500;
const MAX_VALUE_LEN = 80;

// Common HTTP codes for validation
const KNOWN_CODES = new Set([
  100, 101, 102, 103,
  200, 201, 202, 203, 204, 205, 206, 207, 208, 226,
  300, 301, 302, 303, 304, 305, 306, 307, 308,
  400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418, 421, 422, 423, 424, 425, 426, 428, 429, 431, 451,
  500, 501, 502, 503, 504, 505, 506, 507, 508, 510, 511,
]);

const REASON_PHRASES = new Set([
  'continue', 'switching protocols', 'processing', 'early hints',
  'ok', 'created', 'accepted', 'non-authoritative information', 'no content', 'reset content', 'partial content', 'multi-status', 'already reported', 'im used',
  'multiple choices', 'moved permanently', 'found', 'see other', 'not modified', 'use proxy', 'temporary redirect', 'permanent redirect',
  'bad request', 'unauthorized', 'payment required', 'forbidden', 'not found', 'method not allowed', 'not acceptable', 'proxy authentication required', 'request timeout', 'conflict', 'gone', 'length required', 'precondition failed', 'payload too large', 'uri too long', 'unsupported media type', 'range not satisfiable', 'expectation failed', 'im a teapot', 'misdirected request', 'unprocessable entity', 'locked', 'failed dependency', 'too early', 'upgrade required', 'precondition required', 'too many requests', 'request header fields too large', 'unavailable for legal reasons',
  'internal server error', 'not implemented', 'bad gateway', 'service unavailable', 'gateway timeout', 'http version not supported', 'variant also negotiates', 'insufficient storage', 'loop detected', 'not extended', 'network authentication required',
]);

// "HTTP 200", "HTTP/1.1 200", "Status: 404", "responds with 500", "returned a 503"
const PRIMARY_RE = /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s+|Status\s*[:=]?\s*|status\s*code\s*[:=]?\s*|response\s*[:=]?\s*|responds?\s+with\s+(?:an?\s+|a\s+)?|returned?\s+(?:an?\s+|a\s+)?|returns?\s+(?:an?\s+|a\s+)?|got\s+(?:an?\s+|a\s+)?|received\s+(?:an?\s+|a\s+)?)([1-5]\d{2})\b/gi;
// Standalone: "404 Not Found" / "503 Service Unavailable"
const PHRASED_RE = /\b([1-5]\d{2})\s+([A-Z][A-Za-z\- ]{1,40})/g;
// Common bare HTTP codes (well-known so false-positive risk is acceptable in HTTP contexts)
const COMMON_BARE_RE = /\b(200|201|204|301|302|304|400|401|403|404|405|409|410|418|422|429|500|501|502|503|504)\b/g;
const COMMON_BARE_SET = new Set([200, 201, 204, 301, 302, 304, 400, 401, 403, 404, 405, 409, 410, 418, 422, 429, 500, 501, 502, 503, 504]);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipValue(s) {
  const t = String(s || '').trim();
  if (t.length <= MAX_VALUE_LEN) return t;
  return `${t.slice(0, MAX_VALUE_LEN - 1)}…`;
}

function classify(code) {
  const n = Number(code);
  if (n >= 100 && n < 200) return '1xx';
  if (n >= 200 && n < 300) return '2xx';
  if (n >= 300 && n < 400) return '3xx';
  if (n >= 400 && n < 500) return '4xx';
  if (n >= 500 && n < 600) return '5xx';
  return 'other';
}

function emptyByClass() {
  return { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
}

function extractHttpStatus(input) {
  const text = safeText(input);
  if (!text) return { codes: [], total: 0, byClass: emptyByClass(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const codes = [];
  const seen = new Set();
  const byClass = emptyByClass();

  function add(code, phrase, source) {
    if (codes.length >= MAX_PER_FILE) return;
    const n = Number(code);
    if (!KNOWN_CODES.has(n)) return;
    const cls = classify(n);
    const key = `${n}|${(phrase || '').toLowerCase().slice(0, 40)}`;
    if (seen.has(key)) return;
    seen.add(key);
    codes.push({ code: n, class: cls, phrase: clipValue(phrase || ''), source });
    byClass[cls] += 1;
  }

  for (const m of head.matchAll(PRIMARY_RE)) {
    add(m[1], '', 'prefixed');
  }
  for (const m of head.matchAll(COMMON_BARE_RE)) {
    const n = Number(m[1]);
    if (COMMON_BARE_SET.has(n)) add(m[1], '', 'common');
  }
  for (const m of head.matchAll(PHRASED_RE)) {
    const rawPhrase = (m[2] || '').trim();
    const phrase = rawPhrase.toLowerCase();
    // Check if any known reason phrase is a prefix of the captured phrase
    let matched = null;
    for (const r of REASON_PHRASES) {
      if (phrase.startsWith(r) || phrase.replace(/[-_]/g, ' ').startsWith(r)) {
        matched = r;
        break;
      }
    }
    if (matched) {
      // Truncate the captured phrase to the matched length (preserve case)
      const cleanPhrase = rawPhrase.slice(0, matched.length).split(/\s+/).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
      add(m[1], cleanPhrase, 'phrased');
    }
  }

  return { codes, total: codes.length, byClass, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildHttpStatusForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const byClass = emptyByClass();
  for (const f of list) {
    const r = extractHttpStatus(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, codes: r.codes, byClass: r.byClass });
    aggregate = aggregate.concat(r.codes.map((c) => ({ ...c, file: name })));
    for (const k of Object.keys(byClass)) byClass[k] += r.byClass[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, byClass };
}

function renderCode(c, opts = {}) {
  const file = opts.includeFile && c.file ? ` _(${c.file})_` : '';
  const phrase = c.phrase ? ` ${c.phrase}` : '';
  return `- [${c.class}] **${c.code}**${phrase}${file}`;
}

function renderHttpStatusBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const byClass = report.byClass || emptyByClass();
  const breakdown = Object.keys(byClass)
    .filter((k) => byClass[k] > 0)
    .map((k) => `${k}=${byClass[k]}`)
    .join('  ');
  const heading = `## HTTP STATUS CODES
HTTP status codes referenced in the document(s): prefixed forms ("HTTP 200", "Status: 404", "returns a 503") and phrased forms ("404 Not Found", "503 Service Unavailable"). Validated against the IANA registry of known codes. Classified by semantic class — 1xx informational, 2xx success, 3xx redirect, 4xx client error, 5xx server error. Routes "what status?" / "is it a 4xx error?" to a citeable list.

**By class:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const c of only.codes) sections.push(renderCode(c));
  } else {
    sections.push('### Aggregate HTTP codes across all files');
    for (const c of report.aggregate) sections.push(renderCode(c, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const c of p.codes) sections.push(renderCode(c));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...HTTP status block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractHttpStatus,
  buildHttpStatusForFiles,
  renderHttpStatusBlock,
  _internal: {
    PRIMARY_RE,
    PHRASED_RE,
    KNOWN_CODES,
    REASON_PHRASES,
    classify,
  },
};
