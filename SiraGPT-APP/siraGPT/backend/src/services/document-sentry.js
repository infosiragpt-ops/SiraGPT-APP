'use strict';

/**
 * document-sentry.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Sentry SDK error/event tracking API calls:
 *
 *   - Setup:        Sentry.init({...}) / Sentry.configureScope / Sentry.flush
 *   - Capture:      captureException / captureMessage / captureEvent
 *   - Breadcrumbs:  addBreadcrumb({ category, level, message, data })
 *   - Context:      setTag / setTags / setUser / setContext / setExtra / setExtras
 *   - Scope:        withScope / configureScope / pushScope / popScope
 *   - Performance:  startTransaction / Sentry.startSpan / addPerformanceEntry
 *   - DSN URLs:     https://X@Y.ingest.sentry.io/Z  (masked)
 *   - Integrations: BrowserTracing / Replay / Profiling / HttpClient
 *   - Levels:       fatal / error / warning / info / debug
 *
 * Public API:
 *   extractSentry(text)             → { entries, totals, total }
 *   buildSentryForFiles(files)      → { perFile, aggregate, totals }
 *   renderSentryBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const API_RE = /\bSentry\.(init|captureException|captureMessage|captureEvent|addBreadcrumb|setTag|setTags|setUser|setContext|setExtra|setExtras|setLevel|withScope|configureScope|pushScope|popScope|startTransaction|startSpan|startInactiveSpan|getCurrentScope|getCurrentHub|getClient|flush|close|lastEventId)\b/g;
const LEVEL_RE = /\blevel\s*:\s*["']?(fatal|error|warning|warn|info|debug|log)["']?/g;
const CATEGORY_RE = /\bcategory\s*:\s*["']([a-z][a-zA-Z0-9._-]{1,60})["']/g;
const DSN_RE = /https:\/\/([a-zA-Z0-9]{16,40})@([a-zA-Z0-9._-]+\.ingest\.sentry\.io)\/(\d+)/g;
const INTEGRATION_RE = /\bnew\s+(BrowserTracing|Replay|ProfilingIntegration|HttpClient|CaptureConsole|GlobalHandlers|Dedupe|FunctionToString|TryCatch|LinkedErrors|RequestData|Modules|ContextLines|HttpContext|ExtraErrorData)\s*\(/g;
const TAG_RE = /\bsetTag\s*\(\s*["']([a-zA-Z][a-zA-Z0-9._-]{0,60})["']\s*,/g;

function isSentryLike(body) {
  return /\bSentry\.[a-zA-Z]+\s*\(|@sentry\/(?:browser|node|react|nextjs|vue|svelte|angular|electron|aws|gcp|deno|bun)|ingest\.sentry\.io/.test(body);
}

function maskDsn(publicKey, host, projectId) {
  const maskedKey = publicKey.length > 8 ? `${publicKey.slice(0, 4)}…${publicKey.slice(-4)}` : publicKey;
  return `${maskedKey}@${host}/${projectId}`;
}

function extractSentry(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isSentryLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    api: 0, level: 0, category: 0, dsn: 0,
    integration: 0, tag: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  API_RE.lastIndex = 0;
  let m;
  while ((m = API_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('api', `Sentry.${m[1]}`, null);
  }
  if (entries.length < MAX_PER_FILE) {
    LEVEL_RE.lastIndex = 0;
    while ((m = LEVEL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('level', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    CATEGORY_RE.lastIndex = 0;
    while ((m = CATEGORY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('category', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    DSN_RE.lastIndex = 0;
    while ((m = DSN_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('dsn', maskDsn(m[1], m[2], m[3]), null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    INTEGRATION_RE.lastIndex = 0;
    while ((m = INTEGRATION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('integration', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('tag', m[1], null);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildSentryForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    api: 0, level: 0, category: 0, dsn: 0,
    integration: 0, tag: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractSentry(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}`;
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

function renderSentryBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## SENTRY ERROR TRACKING'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      lines.push(`- [${e.kind}] \`${e.name}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractSentry,
  buildSentryForFiles,
  renderSentryBlock,
  _internal: { isSentryLike, maskDsn },
};
