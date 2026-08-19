'use strict';

/**
 * document-tables.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects markdown-style tables in attached documents and emits a
 * compact structured representation: header row + N body rows.
 * Different from the existing evidence-map (which extracts table
 * previews from spreadsheet attachments via DB hydration): this
 * module finds tables EMBEDDED in markdown / mixed text.
 *
 * Each table is emitted as { caption, header, rows, source } where
 * `caption` is the nearest preceding bold / heading line (best
 * effort) so the chat can answer "what does table 3 say?" with the
 * caption + a few rows verbatim.
 *
 * Public API:
 *   extractTables(text)             → TableReport
 *   buildTablesForFiles(files)      → { perFile, aggregate }
 *   renderTablesBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_TABLES_PER_FILE = 6;
const MAX_AGGREGATE = 10;
const MAX_ROWS_PREVIEW = 5;
const MAX_BLOCK_CHARS = 4200;
const MAX_CELL_LEN = 80;

// A markdown table header followed by a separator row (---|---) and ≥ 1 body row.
const TABLE_RE = /(^|\n)(\|.+\|)\n(\|[-:|\s]+\|)\n((?:\|.+\|(?:\n|$))+)/g;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipCell(text) {
  const s = String(text || '').trim();
  if (s.length <= MAX_CELL_LEN) return s;
  return `${s.slice(0, MAX_CELL_LEN - 1).trimEnd()}…`;
}

function parseRow(line) {
  if (!line) return [];
  // Strip the leading + trailing pipes so split doesn't yield empties.
  const inner = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
  return inner.split(/\|/).map(clipCell);
}

function findCaption(textBefore) {
  if (!textBefore) return null;
  // Look at the last 200 chars for a bold caption or heading line.
  const window = textBefore.slice(-200).split(/\n/).reverse();
  for (const line of window) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(?:#{1,6}\s+|\*\*.+\*\*$|__.+__$)/.test(trimmed)) {
      return trimmed.replace(/^#{1,6}\s+/, '').replace(/^\*\*|\*\*$|^__|__$/g, '').trim();
    }
    // Capt. / Tabla N: / Table N: lines
    if (/^(?:Tabla|Table|Cuadro|Figura)\s+\d+[:.]/i.test(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

function extractTables(input) {
  const text = safeText(input);
  if (!text) return { tables: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const tables = [];
  for (const m of head.matchAll(TABLE_RE)) {
    if (tables.length >= MAX_TABLES_PER_FILE) break;
    const lead = m[1] || '';
    const headerLine = m[2] || '';
    const bodyBlock = m[4] || '';
    const beforeIdx = m.index || 0;
    const caption = findCaption(head.slice(0, beforeIdx + lead.length));
    const header = parseRow(headerLine);
    const bodyRows = bodyBlock
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, MAX_ROWS_PREVIEW)
      .map(parseRow);
    if (header.length === 0 || bodyRows.length === 0) continue;
    tables.push({
      caption: caption ? clipCell(caption) : null,
      header,
      rows: bodyRows,
      rowCount: bodyBlock.split('\n').filter((l) => /\|/.test(l)).length,
    });
  }
  return { tables, total: tables.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildTablesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractTables(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, tables: r.tables });
    aggregate = aggregate.concat(r.tables.map((t) => ({ ...t, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderRow(cells) {
  return `| ${cells.join(' | ')} |`;
}

function renderTable(t, opts = {}) {
  const lines = [];
  const file = opts.includeFile && t.file ? ` _(${t.file})_` : '';
  const caption = t.caption ? `**${t.caption}**${file}` : `_(unlabelled table${file})_`;
  lines.push(caption);
  lines.push(renderRow(t.header));
  lines.push(`| ${t.header.map(() => '---').join(' | ')} |`);
  for (const row of t.rows) lines.push(renderRow(row));
  if (t.rowCount > t.rows.length) {
    lines.push(`_(${t.rowCount - t.rows.length} more row${t.rowCount - t.rows.length === 1 ? '' : 's'} not shown)_`);
  }
  return lines.join('\n');
}

function renderTablesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## EMBEDDED TABLES
Markdown tables found inside the attached document(s) with the nearest preceding caption + the first ${MAX_ROWS_PREVIEW} rows preserved verbatim. Routes "what does table N say?" to a structured preview the chat can cite directly.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const t of only.tables) sections.push(renderTable(t));
  } else {
    sections.push('### Aggregate tables across all files');
    for (const t of report.aggregate) sections.push(renderTable(t, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const t of p.tables) sections.push(renderTable(t));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...tables block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractTables,
  buildTablesForFiles,
  renderTablesBlock,
  _internal: {
    parseRow,
    findCaption,
    TABLE_RE,
    MAX_ROWS_PREVIEW,
  },
};
