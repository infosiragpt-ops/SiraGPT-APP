'use strict';

/**
 * document-boolean.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects labeled boolean / yes-no answers in surveys / QA logs / configs:
 *
 *   - "Question: foo? Answer: Yes"
 *   - "X: true", "Y: false", "Enabled: yes", "Disabled: no"
 *   - Spanish: "Pregunta: ¿Activo? Respuesta: Sí"
 *   - Glyphs: ✓ ✗ ☑ ☐
 *
 * Different from document-checklists (markdown checkboxes) by focusing
 * on labeled FAQ/config Q/A pairs. Routes "what's the answer?" /
 * "is X enabled?" to a citeable list.
 *
 * Public API:
 *   extractBooleans(text)         → BooleanReport
 *   buildBooleansForFiles(files)  → { perFile, aggregate, totals }
 *   renderBooleansBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;
const MAX_KEY_LEN = 60;

// Labeled lines: "<key>: yes/no/true/false/sí/no"
const LABELED_RE = /^[\t ]*([A-Za-zÀ-ÿ][\w\sÀ-ÿ_\-?]{0,60})\s*[:=]\s*(yes|no|true|false|s[íi]|enabled|disabled|on|off|activado|desactivado|habilitado|deshabilitado|activo|inactivo|verdadero|falso)(?![A-Za-zÀ-ÿ0-9_])/gim;
// Glyph at start of line followed by text
const GLYPH_RE = /^[\t ]*([✓✗☑☐✘☒])\s+([^\n]{1,80})/gim;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipKey(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_KEY_LEN) return t;
  return `${t.slice(0, MAX_KEY_LEN - 1)}…`;
}

function normaliseBool(v) {
  const t = (v || '').toLowerCase().trim();
  if (/^(yes|true|s[íi]|enabled|on|activado|habilitado|activo|verdadero)$/.test(t)) return true;
  if (/^(no|false|disabled|off|desactivado|deshabilitado|inactivo|falso)$/.test(t)) return false;
  return null;
}

function glyphToBool(g) {
  if (g === '✓' || g === '☑') return true;
  if (g === '✗' || g === '✘' || g === '☐' || g === '☒') return false;
  return null;
}

function emptyTotals() {
  return { true: 0, false: 0 };
}

function extractBooleans(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  function add(key, value, source) {
    if (entries.length >= MAX_PER_FILE) return;
    if (value === null || value === undefined) return;
    const k = clipKey(key);
    if (!k) return;
    const cacheKey = `${k.toLowerCase()}|${value}`;
    if (seen.has(cacheKey)) return;
    seen.add(cacheKey);
    entries.push({ key: k, value, source });
    totals[String(value)] += 1;
  }

  for (const m of head.matchAll(LABELED_RE)) {
    const key = m[1];
    const valStr = m[2];
    const value = normaliseBool(valStr);
    if (value !== null && !/^\s*(if|when|since|where|because)\b/i.test(key)) {
      add(key, value, 'labeled');
    }
  }
  for (const m of head.matchAll(GLYPH_RE)) {
    const value = glyphToBool(m[1]);
    add(m[2], value, 'glyph');
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildBooleansForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractBooleans(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, totals: r.totals });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    totals.true += r.totals.true;
    totals.false += r.totals.false;
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  const glyph = e.value ? '✓' : '✗';
  return `- ${glyph} **${e.key}** _(${e.source})_${file}`;
}

function renderBooleansBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const heading = `## BOOLEAN ANSWERS / FLAGS
Labeled boolean / yes-no values detected in the document(s): English (Yes/No, True/False, Enabled/Disabled, On/Off), Spanish (Sí/No, Activado/Desactivado, Habilitado/Deshabilitado), and glyph forms (✓ / ✗ / ☑ / ☐). Different from markdown checkbox checklists by focusing on labeled key/value config / FAQ pairs. Routes "what's the answer?" / "is X enabled?" to a citeable list.

**Totals:** true=${totals.true}  false=${totals.false}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate booleans across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...booleans block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractBooleans,
  buildBooleansForFiles,
  renderBooleansBlock,
  _internal: {
    LABELED_RE,
    GLYPH_RE,
    normaliseBool,
    glyphToBool,
  },
};
