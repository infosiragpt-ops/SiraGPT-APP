'use strict';

/**
 * document-msw-handlers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Mock Service Worker (msw) handler declarations:
 *
 *   - v1 (rest):        rest.get('/api/x', handler) / rest.post / rest.put / rest.delete
 *   - v2 (http):        http.get('/api/x', handler) / http.post / http.put / http.delete
 *   - GraphQL handlers: graphql.query('Q', ...) / graphql.mutation
 *   - Setup:            setupServer(...) / setupWorker(...)
 *   - Responses:        HttpResponse.json({}) / res(ctx.json({}))
 *   - Passthrough:      passthrough() / bypass()
 *
 * Public API:
 *   extractMswHandlers(text)             → { entries, totals, total }
 *   buildMswHandlersForFiles(files)      → { perFile, aggregate, totals }
 *   renderMswHandlersBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const REST_RE = /\brest\.(get|post|put|patch|delete|options|head)\s*\(\s*["'`]([^"'`\n]{1,200})["'`]/g;
const HTTP_RE = /\bhttp\.(get|post|put|patch|delete|options|head|all)\s*\(\s*["'`]([^"'`\n]{1,200})["'`]/g;
const GRAPHQL_RE = /\bgraphql\.(query|mutation|operation|link)\s*\(\s*["'`]?([^"'`,\n)]{1,80})/g;
const SETUP_RE = /\b(setupServer|setupWorker)\s*\(/g;
const RESPONSE_RE = /\b(HttpResponse\.(?:json|text|html|xml|formData|arrayBuffer|error)|res\s*\(\s*ctx\.[a-z]+|ctx\.(?:json|status|set|delay|fetch|cookie|body|text|errors|data))/g;
const PASSTHROUGH_RE = /\b(passthrough|bypass)\s*\(/g;

function classifyVersion(body) {
  if (/\bhttp\.(get|post|put|patch|delete|options|head|all)\s*\(/.test(body) || /HttpResponse\./.test(body)) return 'v2';
  if (/\brest\.(get|post|put|patch|delete|options|head)\s*\(/.test(body) || /\bres\s*\(\s*ctx\./.test(body)) return 'v1';
  return null;
}

function extractMswHandlers(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;

  // Quick reject if no MSW signals
  if (!/\b(rest|http|graphql)\.(get|post|put|patch|delete|query|mutation)\b|setupServer|setupWorker|HttpResponse/.test(body)) {
    return { entries: [], totals: {}, total: 0 };
  }

  const seen = new Set();
  const entries = [];
  const version = classifyVersion(body);
  const totals = {
    version: 0,
    rest: 0, http: 0, graphql: 0, setup: 0, response: 0, passthrough: 0,
  };

  if (version) {
    entries.push({ kind: 'version', method: version, path: null });
    totals.version = 1;
  }

  function push(kind, method, path) {
    const sig = `${kind}:${method}:${path || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, method, path });
    if (totals[kind] != null) totals[kind] += 1;
  }

  REST_RE.lastIndex = 0;
  let m;
  while ((m = REST_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('rest', m[1].toUpperCase(), m[2].slice(0, 80));
  }
  if (entries.length < MAX_PER_FILE) {
    HTTP_RE.lastIndex = 0;
    while ((m = HTTP_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('http', m[1].toUpperCase(), m[2].slice(0, 80));
    }
  }
  if (entries.length < MAX_PER_FILE) {
    GRAPHQL_RE.lastIndex = 0;
    while ((m = GRAPHQL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('graphql', m[1], m[2].trim().slice(0, 60));
    }
  }
  if (entries.length < MAX_PER_FILE) {
    SETUP_RE.lastIndex = 0;
    while ((m = SETUP_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('setup', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    RESPONSE_RE.lastIndex = 0;
    while ((m = RESPONSE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('response', m[1].slice(0, 40), null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    PASSTHROUGH_RE.lastIndex = 0;
    while ((m = PASSTHROUGH_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('passthrough', m[1], null);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildMswHandlersForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    version: 0, rest: 0, http: 0, graphql: 0, setup: 0, response: 0, passthrough: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractMswHandlers(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.method}:${e.path || ''}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderMswHandlersBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## MSW MOCK HANDLERS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      const path = e.path ? ` \`${e.path}\`` : '';
      lines.push(`- [${e.kind}] ${e.method}${path}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractMswHandlers,
  buildMswHandlersForFiles,
  renderMswHandlersBlock,
  _internal: { classifyVersion },
};
