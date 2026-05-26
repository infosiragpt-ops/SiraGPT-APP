'use strict';

/**
 * document-bullet-lists.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects markdown bullet / numbered lists and groups them under
 * their nearest preceding heading. Routes "what are the X options?"
 * / "list the steps" to the source's actual lists instead of having
 * the model regenerate them.
 *
 * Different from document-checklists (markdown checkbox items) and
 * the deep-analyzer's action bucket (assertive sentences): this
 * surfaces NEUTRAL bullet / numbered lists — descriptive items the
 * source already structured.
 *
 * Public API:
 *   extractBulletLists(text)              → ListReport
 *   buildBulletListsForFiles(files)       → { perFile, aggregate }
 *   renderBulletListsBlock(report)        → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_LISTS_PER_FILE = 8;
const MAX_ITEMS_PER_LIST = 12;
const MAX_AGGREGATE_LISTS = 14;
const MAX_BLOCK_CHARS = 4200;
const MAX_ITEM_LEN = 180;

// Markdown bullets: -, *, + at start of line (with optional indent)
const BULLET_RE = /^(\s*)([-*+])\s+(.+)$/;
const NUMBERED_RE = /^(\s*)(\d+)[.)]\s+(.+)$/;
const CHECKBOX_RE = /^(\s*)([-*+])\s+\[[\sxX\-/?]\]\s+/;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clip(text, max) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function isHeading(line) {
  if (!line) return false;
  if (/^\s*#{1,6}\s+/.test(line)) return true;
  if (/^[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9\s,.:;()/-]{4,80}$/.test(line.trim())) return true;
  if (/^\*\*[^*]+\*\*\s*$/.test(line.trim())) return true;
  return false;
}

function stripHeading(line) {
  return String(line || '').trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\*\*|\*\*$/g, '')
    .trim();
}

function classifyLine(line) {
  if (CHECKBOX_RE.test(line)) return null; // checkboxes handled by document-checklists
  const b = line.match(BULLET_RE);
  if (b) return { kind: 'bullet', body: b[3] };
  const n = line.match(NUMBERED_RE);
  if (n) return { kind: 'numbered', body: n[3] };
  return null;
}

function extractBulletLists(input) {
  const text = safeText(input);
  if (!text) return { lists: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const lines = head.split('\n');
  const lists = [];
  let currentList = null;
  let lastHeading = null;
  for (const raw of lines) {
    if (isHeading(raw)) {
      lastHeading = stripHeading(raw);
      // Close any active list when we encounter a heading
      if (currentList && currentList.items.length === 0) lists.pop();
      currentList = null;
      continue;
    }
    const cls = classifyLine(raw);
    if (!cls) {
      // Blank line OR prose: close the current list
      if (raw.trim().length === 0 && currentList) currentList = null;
      continue;
    }
    if (!currentList) {
      if (lists.length >= MAX_LISTS_PER_FILE) break;
      currentList = { heading: lastHeading || 'Untitled list', kind: cls.kind, items: [] };
      lists.push(currentList);
    }
    if (currentList.items.length < MAX_ITEMS_PER_LIST) {
      currentList.items.push(clip(cls.body.trim(), MAX_ITEM_LEN));
    }
  }
  // Remove lists with fewer than 2 items (single bullet ≈ noise).
  const filtered = lists.filter((l) => l.items.length >= 2);
  return { lists: filtered, total: filtered.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildBulletListsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractBulletLists(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, lists: r.lists });
    aggregate = aggregate.concat(r.lists.map((l) => ({ ...l, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE_LISTS);
  return { perFile, aggregate };
}

function renderList(l, opts = {}) {
  const file = opts.includeFile && l.file ? ` _(${l.file})_` : '';
  const lines = [`**${l.heading}**${file} _(${l.kind}, ${l.items.length} items)_`];
  const prefix = l.kind === 'numbered' ? (i) => `${i + 1}. ` : () => '- ';
  for (let i = 0; i < l.items.length; i++) lines.push(`${prefix(i)}${l.items[i]}`);
  return lines.join('\n');
}

function renderBulletListsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## STRUCTURED LISTS
Bullet and numbered lists found in the attached document(s), grouped under their nearest preceding heading. Use this block to surface the source's actual list structure verbatim — checklist-style items are surfaced separately (see CHECKLISTS block).`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const l of only.lists) sections.push(renderList(l));
  } else {
    sections.push('### Aggregate lists across all files');
    for (const l of report.aggregate) sections.push(renderList(l, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const l of p.lists) sections.push(renderList(l));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...lists block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractBulletLists,
  buildBulletListsForFiles,
  renderBulletListsBlock,
  _internal: {
    classifyLine,
    isHeading,
    stripHeading,
    BULLET_RE,
    NUMBERED_RE,
    CHECKBOX_RE,
  },
};
