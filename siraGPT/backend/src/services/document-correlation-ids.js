'use strict';

/**
 * document-correlation-ids.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects HTTP request correlation IDs used for distributed tracing /
 * support-ticket triage. Different from OpenTelemetry trace headers (covered
 * in document-otel-trace.js) — these are application-level correlation IDs.
 *
 * Targets (header name + value):
 *   - X-Request-Id: <uuid|ulid|hex>
 *   - X-Correlation-Id / X-Correlation-ID
 *   - X-Trace-Id (non-OTel)
 *   - X-Amzn-RequestId (AWS API Gateway)
 *   - CF-Ray (Cloudflare)
 *   - X-GitHub-Request-Id
 *   - Request-Id / Correlation-Id (no X- prefix)
 *
 * Values are masked first-4…last-4.
 *
 * Public API:
 *   extractCorrelationIds(text)             → { entries, totals, total }
 *   buildCorrelationIdsForFiles(files)      → { perFile, aggregate, totals }
 *   renderCorrelationIdsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4500;

const HEADERS = {
  'x-request-id': 'request-id',
  'x-correlation-id': 'correlation-id',
  'request-id': 'request-id',
  'correlation-id': 'correlation-id',
  'x-trace-id': 'trace-id',
  'x-amzn-requestid': 'aws-request-id',
  'x-amzn-trace-id': 'aws-trace-id',
  'cf-ray': 'cloudflare-ray',
  'x-github-request-id': 'github-request-id',
  'x-vercel-id': 'vercel-id',
  'x-render-trace-id': 'render-trace-id',
  'fly-request-id': 'fly-request-id',
};

const HEADER_NAMES = Object.keys(HEADERS).sort((a, b) => b.length - a.length);
const HEADER_ALT = HEADER_NAMES.map((n) => n.replace(/-/g, '[-]')).join('|');
const HEADER_RE = new RegExp(`(${HEADER_ALT})\\s*[:=]\\s*"?([A-Za-z0-9:_.-]{8,80})(?=\\s|"|$|,)`, 'gi');

function maskId(id) {
  if (typeof id !== 'string' || id.length < 8) return '****';
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function classifyFormat(id) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return 'uuid';
  if (/^[0-9a-z]{26}$/i.test(id)) return 'ulid';
  if (/^[0-9a-f]{32}$/i.test(id)) return 'hex32';
  if (/^[0-9a-f]{16}$/i.test(id)) return 'hex16';
  if (/^[0-9]+$/.test(id)) return 'numeric';
  if (id.startsWith('1-') && /^[0-9a-f-]{30,40}$/.test(id)) return 'aws-xray';
  return 'other';
}

function extractCorrelationIds(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = {};

  HEADER_RE.lastIndex = 0;
  let m;
  while ((m = HEADER_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const headerLower = m[1].toLowerCase();
    const role = HEADERS[headerLower] || 'other';
    const id = m[2];
    const masked = maskId(id);
    const fmt = classifyFormat(id);
    const key = `${headerLower}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ header: m[1], role, masked, format: fmt });
    totals[role] = (totals[role] || 0) + 1;
  }

  return { entries, totals, total: entries.length };
}

function buildCorrelationIdsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {};
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractCorrelationIds(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.role}:${e.masked}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      totals[e.role] = (totals[e.role] || 0) + 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderCorrelationIdsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## REQUEST CORRELATION IDs', '- IDs masked first-4…last-4 — never echo full values'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- ${e.role} (${e.format}): \`${e.masked}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractCorrelationIds,
  buildCorrelationIdsForFiles,
  renderCorrelationIdsBlock,
  _internal: { maskId, classifyFormat },
};
