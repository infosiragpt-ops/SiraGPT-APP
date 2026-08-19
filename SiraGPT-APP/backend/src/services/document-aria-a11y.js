'use strict';

/**
 * document-aria-a11y.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects accessibility (a11y) markers in HTML / JSX:
 *
 *   - role="button" / role="navigation"
 *   - aria-label="X" / aria-labelledby="id"
 *   - aria-describedby / aria-hidden / aria-expanded / aria-controls
 *   - alt="…" on <img>
 *   - tabIndex={N} / tabindex="N"
 *
 * Public API:
 *   extractAriaA11y(text)             → { entries, totals, total }
 *   buildAriaA11yForFiles(files)      → { perFile, aggregate, totals }
 *   renderAriaA11yBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const ROLE_RE = /\brole\s*=\s*["']([a-z][a-z-]{1,40})["']/gi;
const ARIA_RE = /\b(aria-[a-z]{2,30})\s*=\s*["']([^"'\n]{1,150})["']/gi;
const ALT_RE = /\balt\s*=\s*["']([^"'\n]{0,200})["']/gi;
const TABINDEX_RE = /\btabindex\s*=\s*["{]?(-?\d{1,3})["}]?/gi;

const VALID_ROLES = new Set([
  'button', 'link', 'navigation', 'banner', 'main', 'contentinfo', 'complementary',
  'region', 'article', 'section', 'list', 'listitem', 'listbox', 'option',
  'menu', 'menubar', 'menuitem', 'tab', 'tablist', 'tabpanel', 'dialog',
  'alertdialog', 'alert', 'status', 'log', 'marquee', 'timer', 'progressbar',
  'slider', 'spinbutton', 'textbox', 'checkbox', 'radio', 'radiogroup',
  'switch', 'tree', 'treeitem', 'grid', 'gridcell', 'row', 'rowgroup',
  'columnheader', 'rowheader', 'cell', 'table', 'heading', 'img', 'presentation',
  'none', 'separator', 'toolbar', 'tooltip', 'search', 'searchbox', 'form',
  'group', 'application', 'document', 'feed', 'figure', 'note', 'definition',
  'directory', 'math', 'scrollbar', 'combobox',
]);

function extractAriaA11y(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { role: 0, aria: 0, alt: 0, tabindex: 0 };

  // Roles
  ROLE_RE.lastIndex = 0;
  let m;
  while ((m = ROLE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const role = m[1].toLowerCase();
    if (!VALID_ROLES.has(role)) continue;
    const key = `role:${role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'role', name: role, value: null });
    totals.role += 1;
  }

  // ARIA attrs
  if (entries.length < MAX_PER_FILE) {
    ARIA_RE.lastIndex = 0;
    while ((m = ARIA_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const attr = m[1].toLowerCase();
      const val = m[2];
      const key = `${attr}:${val}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: 'aria', name: attr, value: val.length > 60 ? `${val.slice(0, 60)}…` : val });
      totals.aria += 1;
    }
  }

  // alt
  if (entries.length < MAX_PER_FILE) {
    ALT_RE.lastIndex = 0;
    while ((m = ALT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const val = m[1];
      const key = `alt:${val}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const isEmpty = val.trim() === '';
      entries.push({ kind: 'alt', name: 'alt', value: isEmpty ? '(empty)' : (val.length > 60 ? `${val.slice(0, 60)}…` : val) });
      totals.alt += 1;
    }
  }

  // tabindex
  if (entries.length < MAX_PER_FILE) {
    TABINDEX_RE.lastIndex = 0;
    while ((m = TABINDEX_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const val = m[1];
      const key = `tabindex:${val}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: 'tabindex', name: 'tabindex', value: val });
      totals.tabindex += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildAriaA11yForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { role: 0, aria: 0, alt: 0, tabindex: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractAriaA11y(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}:${e.value || ''}`;
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

function renderAriaA11yBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## ACCESSIBILITY (ARIA) MARKERS'];
  const t = report.totals || {};
  const parts = [];
  if (t.role) parts.push(`role: ${t.role}`);
  if (t.aria) parts.push(`aria-*: ${t.aria}`);
  if (t.alt) parts.push(`alt: ${t.alt}`);
  if (t.tabindex) parts.push(`tabindex: ${t.tabindex}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      if (e.value != null) {
        lines.push(`- ${e.name}="${e.value}"`);
      } else {
        lines.push(`- ${e.name}`);
      }
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractAriaA11y,
  buildAriaA11yForFiles,
  renderAriaA11yBlock,
  _internal: { VALID_ROLES },
};
