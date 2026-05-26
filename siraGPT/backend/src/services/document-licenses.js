'use strict';

/**
 * document-licenses.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects software license markers in READMEs / LICENSE / source headers:
 *
 *   - SPDX license identifiers (MIT, Apache-2.0, GPL-3.0-or-later,
 *     BSD-2-Clause, MPL-2.0, AGPL-3.0, ISC, etc.)
 *   - "Licensed under …" attribution lines
 *   - SPDX-License-Identifier: comment header
 *   - Copyright © YYYY Name (Spanish "Copyright" + "Todos los derechos
 *     reservados")
 *   - All Rights Reserved declarations
 *
 * Output groups SPDX identifiers and copyright lines. Routes
 * "what license is this under?", "who holds the copyright?" to a
 * citeable inventory.
 *
 * Public API:
 *   extractLicenses(text)          → LicenseReport
 *   buildLicensesForFiles(files)   → { perFile, aggregate, totals }
 *   renderLicensesBlock(report)    → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 20;
const MAX_BLOCK_CHARS = 4500;
const MAX_TEXT_LEN = 180;

// Common SPDX license identifiers
const SPDX_IDS = [
  'MIT', 'Apache-2.0', 'Apache 2.0',
  'GPL-2.0', 'GPL-3.0', 'LGPL-2.1', 'LGPL-3.0', 'AGPL-3.0',
  'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later',
  'BSD-2-Clause', 'BSD-3-Clause', 'BSD-4-Clause', 'BSD-0', '0BSD',
  'MPL-2.0', 'MPL-1.1',
  'ISC',
  'CC-BY-4.0', 'CC-BY-SA-4.0', 'CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', 'CC0-1.0',
  'Unlicense', 'WTFPL',
  'Zlib', 'EPL-2.0', 'EUPL-1.2',
  'Artistic-2.0', 'BSL-1.0',
  'CDDL-1.0',
];

const SPDX_RE = new RegExp(`\\b(${SPDX_IDS.map((s) => s.replace(/[.+\-]/g, '\\$&')).join('|')})\\b`, 'gi');

// SPDX-License-Identifier header
const SPDX_HEADER_RE = /SPDX-License-Identifier\s*:\s*([A-Za-z0-9.\-+ ]+)/gi;

// "Licensed under …"
const LICENSED_UNDER_RE = /\bLicensed\s+(?:under|to use under)\s+(?:the\s+)?([^.\n]{2,80})/gi;

// Copyright © YYYY Name
const COPYRIGHT_RE = /(?:^|\s)(?:Copyright|Copyright\s*©|\(c\)|©|Derecho\s+de\s+autor)\s*(?:©\s*)?(\d{4}(?:[\s-]+\d{4})?)\s+([^\n,.]{2,80})/gi;

// All Rights Reserved
const ALL_RIGHTS_RE = /\b(All\s+Rights?\s+Reserved|Todos?\s+los?\s+derechos?\s+reservados?)\b/gi;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipText(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_TEXT_LEN) return t;
  return `${t.slice(0, MAX_TEXT_LEN - 1)}…`;
}

function normaliseSpdx(id) {
  const s = (id || '').trim();
  // Normalise "Apache 2.0" → "Apache-2.0"
  if (/^Apache\s+2\.0$/i.test(s)) return 'Apache-2.0';
  if (/^Apache\s+1\.\d+$/i.test(s)) return s.replace(/\s+/g, '-');
  return s;
}

function emptyTotals() {
  return { spdx: 0, header: 0, licensedUnder: 0, copyright: 0, allRightsReserved: 0 };
}

function extractLicenses(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  function add(kind, value, context) {
    if (entries.length >= MAX_PER_FILE) return;
    const v = clipText(value);
    if (!v) return;
    const ctx = clipText(context || '');
    const key = `${kind}|${v.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, value: v, context: ctx });
    totals[kind] += 1;
  }

  // SPDX-License-Identifier header first (highest confidence)
  for (const m of head.matchAll(SPDX_HEADER_RE)) {
    add('header', normaliseSpdx(m[1]), m[0]);
  }
  // SPDX IDs anywhere
  for (const m of head.matchAll(SPDX_RE)) {
    const v = normaliseSpdx(m[1]);
    // Skip if same SPDX already added via header
    const dupKey = `header|${v.toLowerCase()}`;
    if (seen.has(dupKey)) continue;
    add('spdx', v, m[0]);
  }
  // "Licensed under …"
  for (const m of head.matchAll(LICENSED_UNDER_RE)) {
    add('licensedUnder', m[1], m[0]);
  }
  // Copyright lines
  for (const m of head.matchAll(COPYRIGHT_RE)) {
    add('copyright', `${m[1].trim()} ${m[2].trim()}`, m[0]);
  }
  // All Rights Reserved
  for (const m of head.matchAll(ALL_RIGHTS_RE)) {
    add('allRightsReserved', m[1], '');
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildLicensesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractLicenses(safeText(f.extractedText));
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
  return `- [${e.kind}]${file} **${e.value}**${e.context ? ` — ${e.context}` : ''}`;
}

function renderLicensesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## LICENSES / COPYRIGHT
License markers detected in the document(s): SPDX identifiers (MIT, Apache-2.0, GPL-3.0, BSD-3-Clause, MPL-2.0, AGPL-3.0, ISC, CC-BY-*, etc.), \`SPDX-License-Identifier:\` headers, "Licensed under …" attributions, Copyright © YYYY Name lines (with Spanish "Derecho de autor"), and "All Rights Reserved" / "Todos los derechos reservados" declarations. Routes "what license is this under?", "who holds the copyright?" to a citeable inventory.

**Totals:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate licenses across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...licenses block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractLicenses,
  buildLicensesForFiles,
  renderLicensesBlock,
  _internal: {
    SPDX_IDS,
    SPDX_RE,
    SPDX_HEADER_RE,
    LICENSED_UNDER_RE,
    COPYRIGHT_RE,
    ALL_RIGHTS_RE,
    normaliseSpdx,
  },
};
