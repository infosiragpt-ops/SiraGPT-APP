'use strict';

/**
 * document-utm-params.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects UTM (Urchin Tracking Module) parameters in URLs commonly seen
 * in marketing docs, attribution reports, campaign analytics:
 *
 *   - utm_source=newsletter
 *   - utm_medium=email
 *   - utm_campaign=launch_q4
 *   - utm_term=ai+platform
 *   - utm_content=cta_top
 *   - utm_id=12345
 *
 * Routes "what campaign?" / "what UTM source?" to a citeable list.
 *
 * Public API:
 *   extractUtmParams(text)         → UtmReport
 *   buildUtmParamsForFiles(files)  → { perFile, aggregate, totals }
 *   renderUtmParamsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;
const MAX_VALUE_LEN = 80;

const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content', 'id'];

const UTM_RE = /\butm_(source|medium|campaign|term|content|id)=([^&\s"'<>]+)/gi;

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

function emptyTotals() {
  const r = {};
  for (const k of UTM_KEYS) r[k] = 0;
  return r;
}

function extractUtmParams(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  for (const m of head.matchAll(UTM_RE)) {
    if (entries.length >= MAX_PER_FILE) break;
    const key = m[1].toLowerCase();
    const value = clipValue(decodeURIComponent(m[2].replace(/\+/g, ' ')));
    const dkey = `${key}|${value.toLowerCase()}`;
    if (seen.has(dkey)) continue;
    seen.add(dkey);
    entries.push({ key, value });
    totals[key] = (totals[key] || 0) + 1;
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildUtmParamsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractUtmParams(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, totals: r.totals });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    for (const k of UTM_KEYS) totals[k] += (r.totals[k] || 0);
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- [utm_${e.key}] \`${e.value}\`${file}`;
}

function renderUtmParamsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = UTM_KEYS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## UTM TRACKING PARAMETERS
UTM (Urchin Tracking Module) parameters detected in URLs: utm_source, utm_medium, utm_campaign, utm_term, utm_content, utm_id. Values URL-decoded. Routes "what campaign?" / "what UTM source?" to a citeable list useful for marketing attribution analysis.

**By key:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate UTM params across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...UTM params block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractUtmParams,
  buildUtmParamsForFiles,
  renderUtmParamsBlock,
  _internal: {
    UTM_RE,
    UTM_KEYS,
  },
};
