'use strict';

/**
 * document-sql-windows.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects SQL window-function constructs and advanced query features:
 *
 *   - window functions: ROW_NUMBER(), RANK(), DENSE_RANK(), LAG/LEAD,
 *                       NTILE(), FIRST_VALUE, LAST_VALUE, PERCENTILE_CONT
 *   - OVER clauses:     OVER (PARTITION BY x ORDER BY y)
 *   - CTEs:             WITH name AS (SELECT ...)
 *   - aggregates:       SUM/COUNT/AVG/MIN/MAX with OVER()
 *   - frame specs:      ROWS BETWEEN / RANGE BETWEEN
 *
 * Public API:
 *   extractSqlWindows(text)             → { entries, totals, total }
 *   buildSqlWindowsForFiles(files)      → { perFile, aggregate, totals }
 *   renderSqlWindowsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const WINDOW_FN_RE = /\b(ROW_NUMBER|RANK|DENSE_RANK|PERCENT_RANK|CUME_DIST|NTILE|LAG|LEAD|FIRST_VALUE|LAST_VALUE|NTH_VALUE|PERCENTILE_CONT|PERCENTILE_DISC)\s*\(/gi;
const OVER_RE = /\bOVER\s*\(\s*((?:PARTITION\s+BY|ORDER\s+BY|ROWS|RANGE)[^)]{0,200})\)/gi;
const CTE_RE = /\bWITH\s+(?:RECURSIVE\s+)?([A-Za-z_][A-Za-z0-9_]{0,80})\s+AS\s*\(/gi;
const AGGREGATE_RE = /\b(SUM|COUNT|AVG|MIN|MAX|STRING_AGG|ARRAY_AGG|JSONB_AGG|JSON_AGG|STDDEV|VARIANCE)\s*\([^)]{0,80}\)\s*OVER\b/gi;
const FRAME_RE = /\b(?:ROWS|RANGE)\s+BETWEEN\b/gi;

function extractSqlWindows(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { windowFn: 0, over: 0, cte: 0, aggregate: 0, frame: 0 };

  function push(kind, name) {
    const key = `${kind}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, name });
    if (totals[kind] != null) totals[kind] += 1;
  }

  WINDOW_FN_RE.lastIndex = 0;
  let m;
  while ((m = WINDOW_FN_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('windowFn', m[1].toUpperCase());
  }
  if (entries.length < MAX_PER_FILE) {
    OVER_RE.lastIndex = 0;
    while ((m = OVER_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('over', m[1].replace(/\s+/g, ' ').slice(0, 80));
    }
  }
  if (entries.length < MAX_PER_FILE) {
    CTE_RE.lastIndex = 0;
    while ((m = CTE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('cte', m[1]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    AGGREGATE_RE.lastIndex = 0;
    while ((m = AGGREGATE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('aggregate', m[1].toUpperCase());
    }
  }
  if (entries.length < MAX_PER_FILE) {
    FRAME_RE.lastIndex = 0;
    while ((m = FRAME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('frame', m[0]);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildSqlWindowsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { windowFn: 0, over: 0, cte: 0, aggregate: 0, frame: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractSqlWindows(txt);
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

function renderSqlWindowsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## SQL WINDOW FUNCTIONS & CTEs'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- [${e.kind}] \`${e.name}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractSqlWindows,
  buildSqlWindowsForFiles,
  renderSqlWindowsBlock,
};
