'use strict';

/**
 * document-otel-trace.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects OpenTelemetry / W3C Trace Context identifiers. Useful for routing
 * "what trace is X linked to?" / "show me the span IDs in this log" without
 * leaking the raw IDs in full.
 *
 * Targets:
 *   - traceparent: 00-<32-hex>-<16-hex>-<2-hex>          (W3C spec)
 *   - tracestate: <vendor=value, …>                      (W3C spec)
 *   - trace_id=<32-hex> / trace-id: <32-hex>
 *   - span_id=<16-hex> / span-id: <16-hex>
 *   - X-Cloud-Trace-Context: <hex>/<spanid>;o=1          (GCP)
 *   - X-Amzn-Trace-Id: Root=1-…;Parent=…;Sampled=1       (AWS X-Ray)
 *   - X-B3-TraceId / X-B3-SpanId (Zipkin B3 headers)
 *
 * IDs are masked: first-4…last-4 only, never the full hex string.
 *
 * Public API:
 *   extractOtelTrace(text)             → { entries, totals, total }
 *   buildOtelTraceForFiles(files)      → { perFile, aggregate, totals }
 *   renderOtelTraceBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 18;
const MAX_BLOCK_CHARS = 4500;

const TRACEPARENT_RE = /\btraceparent\s*[:=]\s*"?\s*(00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2})/gi;
const TRACEID_LABEL_RE = /\btrace[-_]?id\s*[:=]\s*"?([a-f0-9]{16,32})\b/gi;
const SPANID_LABEL_RE = /\bspan[-_]?id\s*[:=]\s*"?([a-f0-9]{8,16})\b/gi;
const GCP_TRACE_RE = /X-Cloud-Trace-Context\s*:\s*([a-f0-9]{16,32})(?:\/(\d+))?/gi;
const AWS_XRAY_RE = /X-Amzn-Trace-Id\s*:\s*Root\s*=\s*(1-[a-f0-9]{8}-[a-f0-9]{24})/gi;
const B3_TRACEID_RE = /X-B3-TraceId\s*:\s*([a-f0-9]{16,32})/gi;
const B3_SPANID_RE = /X-B3-SpanId\s*:\s*([a-f0-9]{8,16})/gi;

function maskId(id) {
  if (typeof id !== 'string' || id.length < 8) return '****';
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function extractOtelTrace(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { w3c: 0, label: 0, gcp: 0, aws: 0, b3: 0 };

  function push(kind, raw, source) {
    const masked = maskId(raw);
    const key = `${kind}:${raw}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, masked, source });
    if (totals[source] != null) totals[source] += 1;
  }

  // W3C traceparent
  TRACEPARENT_RE.lastIndex = 0;
  let m;
  while ((m = TRACEPARENT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const parts = m[1].split('-');
    push('traceparent', parts[1], 'w3c');
  }

  // Generic trace_id label
  if (entries.length < MAX_PER_FILE) {
    TRACEID_LABEL_RE.lastIndex = 0;
    while ((m = TRACEID_LABEL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('trace_id', m[1], 'label');
    }
  }

  // Generic span_id label
  if (entries.length < MAX_PER_FILE) {
    SPANID_LABEL_RE.lastIndex = 0;
    while ((m = SPANID_LABEL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('span_id', m[1], 'label');
    }
  }

  // GCP X-Cloud-Trace-Context
  if (entries.length < MAX_PER_FILE) {
    GCP_TRACE_RE.lastIndex = 0;
    while ((m = GCP_TRACE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('gcp-trace', m[1], 'gcp');
    }
  }

  // AWS X-Ray
  if (entries.length < MAX_PER_FILE) {
    AWS_XRAY_RE.lastIndex = 0;
    while ((m = AWS_XRAY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('aws-xray', m[1], 'aws');
    }
  }

  // B3 Trace
  if (entries.length < MAX_PER_FILE) {
    B3_TRACEID_RE.lastIndex = 0;
    while ((m = B3_TRACEID_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('b3-trace', m[1], 'b3');
    }
    B3_SPANID_RE.lastIndex = 0;
    while ((m = B3_SPANID_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('b3-span', m[1], 'b3');
    }
  }

  return { entries, totals, total: entries.length };
}

function buildOtelTraceForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { w3c: 0, label: 0, gcp: 0, aws: 0, b3: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractOtelTrace(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.masked}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.source] != null) totals[e.source] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderOtelTraceBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## OPENTELEMETRY TRACE IDs', '- IDs masked first-4…last-4 — never echo full values'];
  const t = report.totals || {};
  const parts = [];
  if (t.w3c) parts.push(`W3C: ${t.w3c}`);
  if (t.label) parts.push(`labeled: ${t.label}`);
  if (t.gcp) parts.push(`GCP: ${t.gcp}`);
  if (t.aws) parts.push(`AWS X-Ray: ${t.aws}`);
  if (t.b3) parts.push(`B3: ${t.b3}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- ${e.kind}: \`${e.masked}\` (${e.source})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractOtelTrace,
  buildOtelTraceForFiles,
  renderOtelTraceBlock,
  _internal: { maskId },
};
