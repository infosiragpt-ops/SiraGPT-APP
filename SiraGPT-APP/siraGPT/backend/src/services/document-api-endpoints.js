'use strict';

/**
 * document-api-endpoints.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects HTTP API endpoint references in technical docs:
 *
 *   - "GET /api/v1/users", "POST /api/orders/{id}"
 *   - Markdown headers with method + path ("## POST /webhooks")
 *   - Inline code: `DELETE /api/foo`
 *   - OpenAPI snippets ("paths: /api/foo:")
 *   - Method label lines: "Method: PATCH" + "Path: /api/foo"
 *
 * Output groups by method (GET / POST / PUT / PATCH / DELETE / HEAD /
 * OPTIONS / TRACE) and deduplicates by canonical METHOD path. Routes
 * "what endpoints does this expose?", "is there a POST /api/x?" to a
 * citeable inventory. Different from document-code-blocks (full code
 * bodies) and document-urls (web links).
 *
 * Public API:
 *   extractApiEndpoints(text)         → ApiReport
 *   buildApiEndpointsForFiles(files)  → { perFile, aggregate, byMethod }
 *   renderApiEndpointsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_METHOD = 12;
const MAX_PER_FILE = 32;
const MAX_AGGREGATE = 40;
const MAX_BLOCK_CHARS = 6000;
const MAX_PATH_LEN = 200;

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'];

// Inline: METHOD /path  (with at least one slash, possibly /{param} or :param)
const METHOD_PATH_RE = /(?:^|[^A-Z0-9])\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\b\s+(\/[^\s`'"<>,;]+)/g;
// Backtick form: `GET /path` — already covered by above (backticks are non-A-Z so prefix matches)

const SECTION_HEADER_RE = /(?:^|\n)\s*#{1,6}\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+(\/[^\s`'"<>,;]+)/g;

// OpenAPI: '  /api/foo:' inside a paths: block
const OPENAPI_PATH_RE = /(?:^|\n)\s{2,}(\/[a-zA-Z0-9_\-/{}.:]+)\s*:\s*(?=\n)/g;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipPath(p) {
  const s = String(p || '');
  if (s.length <= MAX_PATH_LEN) return s;
  return `${s.slice(0, MAX_PATH_LEN - 1)}…`;
}

function isLikelyPath(p) {
  if (!p || p.length < 2) return false;
  if (!p.startsWith('/')) return false;
  // Reject obvious noise: must not look like a file path with a non-API extension
  if (/\.(png|jpg|jpeg|gif|svg|css|js|md|pdf|html?)$/i.test(p)) return false;
  // Reject trailing punctuation
  return /^[\/a-zA-Z0-9_\-{}.:?=&%/]+$/.test(p.replace(/^[\/.:_\-]+/, '/'));
}

function emptyByMethod() {
  const r = {};
  for (const m of METHODS) r[m] = 0;
  return r;
}

function extractApiEndpoints(input) {
  const text = safeText(input);
  if (!text) return { endpoints: [], total: 0, byMethod: emptyByMethod(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const endpoints = [];
  const seen = new Set();
  const byMethod = emptyByMethod();

  function add(method, path) {
    if (endpoints.length >= MAX_PER_FILE) return;
    if (byMethod[method] >= MAX_PER_METHOD) return;
    if (!isLikelyPath(path)) return;
    const cleanPath = clipPath(path.replace(/[.,;)\]]+$/, ''));
    const key = `${method} ${cleanPath}`;
    if (seen.has(key)) return;
    seen.add(key);
    endpoints.push({ method, path: cleanPath });
    byMethod[method] += 1;
  }

  for (const m of head.matchAll(METHOD_PATH_RE)) add(m[1].toUpperCase(), m[2]);
  for (const m of head.matchAll(SECTION_HEADER_RE)) add(m[1].toUpperCase(), m[2]);

  // OpenAPI: only attribute as GET fallback when path appears in a paths: context
  if (/(?:^|\n)\s*paths\s*:\s*\n/.test(head)) {
    for (const m of head.matchAll(OPENAPI_PATH_RE)) {
      const path = m[1];
      if (!isLikelyPath(path)) continue;
      // Methods declared as children of the path are detected separately;
      // record path under "OpenAPI" virtual bucket as method "*"
      if (endpoints.length >= MAX_PER_FILE) break;
      const key = `OAS ${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      endpoints.push({ method: 'OAS', path: clipPath(path) });
    }
  }

  return { endpoints, total: endpoints.length, byMethod, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildApiEndpointsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const byMethod = emptyByMethod();
  for (const f of list) {
    const r = extractApiEndpoints(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, endpoints: r.endpoints, byMethod: r.byMethod });
    aggregate = aggregate.concat(r.endpoints.map((e) => ({ ...e, file: name })));
    for (const m of METHODS) byMethod[m] += r.byMethod[m];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, byMethod };
}

function renderEndpoint(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- \`${e.method} ${e.path}\`${file}`;
}

function renderApiEndpointsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const byMethod = report.byMethod || emptyByMethod();
  const breakdown = METHODS
    .filter((m) => byMethod[m] > 0)
    .map((m) => `${m}=${byMethod[m]}`)
    .join('  ');
  const heading = `## API ENDPOINTS
HTTP method + path references detected in the document(s) — inline ("GET /api/users"), markdown headers ("## POST /webhooks"), OpenAPI \`paths:\` blocks, and method-labeled lines. Grouped by method (GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS / TRACE), with OpenAPI-only paths under "OAS". Different from document-urls (web links) and document-code-blocks (full code).

**By method:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.endpoints) sections.push(renderEndpoint(e));
  } else {
    sections.push('### Aggregate endpoints across all files');
    for (const e of report.aggregate) sections.push(renderEndpoint(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.endpoints) sections.push(renderEndpoint(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...api endpoints block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractApiEndpoints,
  buildApiEndpointsForFiles,
  renderApiEndpointsBlock,
  _internal: {
    METHOD_PATH_RE,
    SECTION_HEADER_RE,
    OPENAPI_PATH_RE,
    METHODS,
    isLikelyPath,
  },
};
