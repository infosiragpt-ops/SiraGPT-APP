'use strict';

/**
 * document-cron.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects scheduling expressions in runbooks / RFCs / cron job docs:
 *
 *   - 5-field cron (min hour dom month dow): "0 3 * * *"
 *   - 6-field cron with seconds: "0 0 3 * * *"
 *   - 7-field cron with year: "0 0 3 * * * 2024"
 *   - Named expressions: @daily, @hourly, @weekly, @monthly, @yearly, @reboot
 *   - K8s CronJob spec lines: schedule: "0 3 * * *"
 *
 * Output groups by kind, normalises, and dedupes. Routes "when does
 * this run?", "what's the schedule?" to a citeable inventory.
 *
 * Public API:
 *   extractCron(text)             → CronReport
 *   buildCronForFiles(files)      → { perFile, aggregate, totals }
 *   renderCronBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 5000;
const MAX_CONTEXT_LEN = 160;

// Cron field token: digit, *, /, -, ,
// Match a 5/6/7-field expression where each field is `[\d*\/,\-?L]+` (incl. L for "last")
const FIELD = `[\\d*\\/,\\-?LW#]+`;
const CRON_5 = new RegExp(`(?:^|[\\s\\\`'"<>(])((?:${FIELD}\\s+){4}${FIELD})(?=\\s|$)`, 'g');
const CRON_6 = new RegExp(`(?:^|[\\s\\\`'"<>(])((?:${FIELD}\\s+){5}${FIELD})(?=\\s|$)`, 'g');
const CRON_7 = new RegExp(`(?:^|[\\s\\\`'"<>(])((?:${FIELD}\\s+){6}${FIELD})(?=\\s|$)`, 'g');
const NAMED_RE = /(?:^|[\s`'"<>(])(@(?:daily|hourly|weekly|monthly|yearly|annually|reboot|midnight))(?=[\s`'"<>):,;.!?]|$)/g;
// schedule: "0 3 * * *"   (K8s/CRON YAML/JSON)
const SCHEDULE_LINE_RE = /\bschedule\s*[:=]\s*['"]([^'"\n]+)['"]/gi;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipText(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_CONTEXT_LEN) return t;
  return `${t.slice(0, MAX_CONTEXT_LEN - 1)}…`;
}

function isLikelyCron(expr) {
  if (!expr) return false;
  const tokens = expr.trim().split(/\s+/);
  if (tokens.length < 5 || tokens.length > 7) return false;
  // At least one * or digit required in first 5 fields
  for (let i = 0; i < Math.min(5, tokens.length); i++) {
    if (!/[\d*]/.test(tokens[i])) return false;
  }
  // Reject if all fields are pure digits (looks like phone, date, etc.)
  const stars = tokens.filter((t) => t === '*' || t.includes('*')).length;
  const slashes = tokens.filter((t) => t.includes('/')).length;
  if (stars + slashes === 0 && tokens.every((t) => /^\d+$/.test(t))) return false;
  return true;
}

function fieldsToContext(text, idx, len) {
  const start = Math.max(0, idx - 50);
  const end = Math.min(text.length, idx + len + 80);
  return clipText(text.slice(start, end));
}

function extractCron(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: { '5-field': 0, '6-field': 0, '7-field': 0, named: 0, scheduleLine: 0 }, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = { '5-field': 0, '6-field': 0, '7-field': 0, named: 0, scheduleLine: 0 };

  function add(kind, expr, context) {
    if (entries.length >= MAX_PER_FILE) return;
    if (!expr) return;
    const e = expr.trim();
    const key = `${kind}|${e}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, expression: e, context: context || '' });
    totals[kind] += 1;
  }

  // Try 7-field first, then 6, then 5 — to avoid 5-field consuming a 6-field's prefix
  for (const m of head.matchAll(CRON_7)) {
    const expr = m[1];
    if (isLikelyCron(expr)) add('7-field', expr, fieldsToContext(head, m.index, m[0].length));
  }
  for (const m of head.matchAll(CRON_6)) {
    const expr = m[1];
    if (!isLikelyCron(expr)) continue;
    // Skip if already part of a 7-field entry
    if (entries.some((e) => e.kind === '7-field' && e.expression.startsWith(expr))) continue;
    add('6-field', expr, fieldsToContext(head, m.index, m[0].length));
  }
  for (const m of head.matchAll(CRON_5)) {
    const expr = m[1];
    if (!isLikelyCron(expr)) continue;
    if (entries.some((e) => (e.kind === '6-field' || e.kind === '7-field') && e.expression.startsWith(expr))) continue;
    add('5-field', expr, fieldsToContext(head, m.index, m[0].length));
  }

  for (const m of head.matchAll(NAMED_RE)) {
    add('named', m[1], fieldsToContext(head, m.index, m[0].length));
  }

  for (const m of head.matchAll(SCHEDULE_LINE_RE)) {
    // Add the value as scheduleLine (regardless of internal validity — surfaces config intent)
    add('scheduleLine', m[1], fieldsToContext(head, m.index, m[0].length));
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildCronForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = { '5-field': 0, '6-field': 0, '7-field': 0, named: 0, scheduleLine: 0 };
  for (const f of list) {
    const r = extractCron(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, totals: r.totals });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    for (const k of Object.keys(totals)) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- [${e.kind}] \`${e.expression}\`${file} — ${e.context}`;
}

function renderCronBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || { '5-field': 0, '6-field': 0, '7-field': 0, named: 0, scheduleLine: 0 };
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## CRON / SCHEDULING
Cron schedules and named scheduling expressions detected in the document(s) — 5/6/7-field cron, named expressions (@daily / @hourly / @weekly / @monthly / @yearly / @reboot / @midnight), and \`schedule:\` YAML/JSON config lines. Routes "when does this run?" / "what's the schedule?" to a citeable inventory.

**Totals:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate cron across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...cron block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractCron,
  buildCronForFiles,
  renderCronBlock,
  _internal: {
    CRON_5,
    CRON_6,
    CRON_7,
    NAMED_RE,
    SCHEDULE_LINE_RE,
    isLikelyCron,
  },
};
