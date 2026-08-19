'use strict';

/**
 * document-natural-schedules.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects human-readable schedule expressions in prose / runbooks:
 *
 *   - "every Monday at 9am" / "every Friday"
 *   - "daily at 3pm" / "weekly on Tuesday"
 *   - "every 15 minutes" / "every 2 hours"
 *   - "on the first/last day of the month"
 *   - "twice a week" / "biweekly" / "monthly" / "quarterly"
 *
 * Distinct from document-cron.js (which detects cron syntax). This one is
 * for the prose around the cron expression.
 *
 * Public API:
 *   extractNaturalSchedules(text)            → { entries, totals, total }
 *   buildNaturalSchedulesForFiles(files)     → { perFile, aggregate, totals }
 *   renderNaturalSchedulesBlock(report)      → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 20;
const MAX_BLOCK_CHARS = 4500;

const EVERY_DAY_RE = /\bevery\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekday|day|night)(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM|h)?))?/gi;
const EVERY_INTERVAL_RE = /\bevery\s+(\d{1,3})\s+(minute|min|hour|hr|day|week|month|year)s?\b/gi;
const RECURRENCE_RE = /\b(daily|weekly|biweekly|monthly|quarterly|yearly|hourly|nightly)(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM|h)?))?/gi;
const TWICE_RE = /\b(twice|thrice|three times|four times)\s+(?:a|per)\s+(day|week|month|year)\b/gi;
const SPECIFIC_DAY_RE = /\bon\s+(?:the\s+)?(first|last|\d{1,2}(?:st|nd|rd|th)?)\s+(?:day\s+of\s+the\s+)?(week|month|year)\b/gi;

function normalizeTime(t) {
  if (!t) return null;
  const trimmed = t.trim().toLowerCase();
  return trimmed;
}

function extractNaturalSchedules(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { everyDay: 0, everyInterval: 0, recurrence: 0, multiplicity: 0, specificDay: 0 };

  function push(kind, expr, normalised) {
    const key = `${kind}:${normalised}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, expression: expr, normalised });
    if (totals[kind] != null) totals[kind] += 1;
  }

  EVERY_DAY_RE.lastIndex = 0;
  let m;
  while ((m = EVERY_DAY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const day = m[1].toLowerCase();
    const time = normalizeTime(m[2]);
    push('everyDay', m[0], `${day}${time ? `@${time}` : ''}`);
  }

  if (entries.length < MAX_PER_FILE) {
    EVERY_INTERVAL_RE.lastIndex = 0;
    while ((m = EVERY_INTERVAL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const n = m[1];
      const unit = m[2].toLowerCase();
      push('everyInterval', m[0], `${n}-${unit}`);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    RECURRENCE_RE.lastIndex = 0;
    while ((m = RECURRENCE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const r = m[1].toLowerCase();
      const time = normalizeTime(m[2]);
      push('recurrence', m[0], `${r}${time ? `@${time}` : ''}`);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    TWICE_RE.lastIndex = 0;
    while ((m = TWICE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('multiplicity', m[0], `${m[1].toLowerCase()}-per-${m[2].toLowerCase()}`);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    SPECIFIC_DAY_RE.lastIndex = 0;
    while ((m = SPECIFIC_DAY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('specificDay', m[0], `${m[1].toLowerCase()}-of-${m[2].toLowerCase()}`);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildNaturalSchedulesForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { everyDay: 0, everyInterval: 0, recurrence: 0, multiplicity: 0, specificDay: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractNaturalSchedules(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.normalised}`;
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

function renderNaturalSchedulesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## NATURAL-LANGUAGE SCHEDULES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- [${e.kind}] "${e.expression}" → \`${e.normalised}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractNaturalSchedules,
  buildNaturalSchedulesForFiles,
  renderNaturalSchedulesBlock,
};
