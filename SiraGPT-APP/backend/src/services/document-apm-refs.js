'use strict';

/**
 * document-apm-refs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects observability / APM tool references:
 *
 *   - Sentry:     sentry.io/organizations/X/issues/Y, "sentry-id <hash>"
 *   - Datadog:    datadoghq.com URLs, dd_trace_id, dashboards/<id>
 *   - New Relic:  one.newrelic.com URLs, applications/N, transactions
 *   - Honeycomb:  ui.honeycomb.io/<team>/datasets/<dataset>
 *   - Bugsnag:    app.bugsnag.com/<org>/<proj>/errors/<id>
 *   - Rollbar:    rollbar.com/<org>/<proj>/items/<id>
 *   - PagerDuty:  *.pagerduty.com/incidents/<id>
 *
 * Public API:
 *   extractApmRefs(text)             → { entries, totals, total }
 *   buildApmRefsForFiles(files)      → { perFile, aggregate, totals }
 *   renderApmRefsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4500;

const SENTRY_RE = /\bhttps?:\/\/(?:[a-z0-9-]+\.)?sentry\.io\/organizations\/([A-Za-z0-9_-]+)\/issues\/(\d+)/g;
const SENTRY_ID_RE = /\bsentry[_-]?(?:event[_-]?id|issue[_-]?id|id)\s*[:=]\s*([a-f0-9]{8,40})/gi;
const DATADOG_URL_RE = /\bhttps?:\/\/[a-z0-9-]*\.?datadoghq\.com\/[a-z0-9/_-]{2,200}/gi;
const DD_TRACE_RE = /\bdd[._]trace[._]id\s*[:=]\s*(\d{8,20})/gi;
const NEWRELIC_RE = /\bhttps?:\/\/(?:one\.|rpm\.|insights\.)?newrelic\.com\/[a-z0-9/_-]{2,200}/gi;
const HONEYCOMB_RE = /\bhttps?:\/\/ui\.honeycomb\.io\/([A-Za-z0-9-]+)\/datasets\/([A-Za-z0-9_-]+)/g;
const BUGSNAG_RE = /\bhttps?:\/\/app\.bugsnag\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_-]+)\/errors\/([A-Za-z0-9_-]+)/g;
const ROLLBAR_RE = /\bhttps?:\/\/rollbar\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_-]+)\/items\/(\d+)/g;
const PAGERDUTY_RE = /\bhttps?:\/\/[a-z0-9-]+\.pagerduty\.com\/incidents\/([A-Z0-9]{6,15})/gi;

function extractApmRefs(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { sentry: 0, datadog: 0, newrelic: 0, honeycomb: 0, bugsnag: 0, rollbar: 0, pagerduty: 0 };

  function push(tool, ref, label) {
    const key = `${tool}:${ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ tool, ref, label });
    if (totals[tool] != null) totals[tool] += 1;
  }

  SENTRY_RE.lastIndex = 0;
  let m;
  while ((m = SENTRY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('sentry', `org/${m[1]}/issues/${m[2]}`, 'issue-url');
  }
  if (entries.length < MAX_PER_FILE) {
    SENTRY_ID_RE.lastIndex = 0;
    while ((m = SENTRY_ID_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('sentry', m[1], 'id-label');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    DATADOG_URL_RE.lastIndex = 0;
    while ((m = DATADOG_URL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('datadog', m[0].slice(0, 150), 'url');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    DD_TRACE_RE.lastIndex = 0;
    while ((m = DD_TRACE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('datadog', `trace:${m[1]}`, 'trace-id');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    NEWRELIC_RE.lastIndex = 0;
    while ((m = NEWRELIC_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('newrelic', m[0].slice(0, 150), 'url');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    HONEYCOMB_RE.lastIndex = 0;
    while ((m = HONEYCOMB_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('honeycomb', `${m[1]}/datasets/${m[2]}`, 'dataset');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    BUGSNAG_RE.lastIndex = 0;
    while ((m = BUGSNAG_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('bugsnag', `${m[1]}/${m[2]}/errors/${m[3]}`, 'error');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    ROLLBAR_RE.lastIndex = 0;
    while ((m = ROLLBAR_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('rollbar', `${m[1]}/${m[2]}/items/${m[3]}`, 'item');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    PAGERDUTY_RE.lastIndex = 0;
    while ((m = PAGERDUTY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('pagerduty', m[1], 'incident');
    }
  }

  return { entries, totals, total: entries.length };
}

function buildApmRefsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { sentry: 0, datadog: 0, newrelic: 0, honeycomb: 0, bugsnag: 0, rollbar: 0, pagerduty: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractApmRefs(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.tool}:${e.ref}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.tool] != null) totals[e.tool] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderApmRefsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## APM / OBSERVABILITY REFERENCES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- ${e.tool} (${e.label}): \`${e.ref}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractApmRefs,
  buildApmRefsForFiles,
  renderApmRefsBlock,
};
