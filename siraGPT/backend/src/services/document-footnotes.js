'use strict';

/**
 * document-footnotes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Captures FOOTNOTE / ENDNOTE markers + their definition text from
 * attached documents. Routes "what does footnote N say?" / "where
 * are the references?" to a paired list (marker → definition).
 *
 * Different from document-quote-extractor (verbatim quotes +
 * citation markers): this module SPECIFICALLY pairs markers with
 * their corresponding note bodies — e.g. [^1] inline → [^1]: text.
 *
 * Public API:
 *   extractFootnotes(text)             → FootnoteReport
 *   buildFootnotesForFiles(files)      → { perFile, aggregate }
 *   renderFootnotesBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4000;
const MAX_MARKER_LEN = 24;
const MAX_BODY_LEN = 280;

// Markdown footnote: [^id]: body
const MD_DEFINITION_RE = /^\[\^([A-Za-z0-9_-]{1,24})\]\s*:\s*(.{4,400})$/gm;
// Markdown footnote inline marker (just collected to know which were used)
const MD_INLINE_RE = /\[\^([A-Za-z0-9_-]{1,24})\]/g;
// Numbered note: 1. body (when present at start of line in references section)
const NUMBERED_NOTE_RE = /^\s*(\d{1,3})[.)]\s+(.{8,400})$/gm;
// Superscript footnote markers (¹²³). Optional second pass for richer docs.
const SUPERSCRIPT_RE = /(?<=\w)([¹²³⁴⁵⁶⁷⁸⁹⁰]+)/g;

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

function extractFootnotes(input) {
  const text = safeText(input);
  if (!text) return { footnotes: [], inlineMarkers: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const footnotes = [];
  const seen = new Set();

  for (const m of head.matchAll(MD_DEFINITION_RE)) {
    if (footnotes.length >= MAX_PER_FILE) break;
    const marker = clip((m[1] || '').trim(), MAX_MARKER_LEN);
    const body = clip((m[2] || '').trim(), MAX_BODY_LEN);
    if (!marker || !body) continue;
    const key = `md|${marker}`;
    if (seen.has(key)) continue;
    seen.add(key);
    footnotes.push({ kind: 'markdown', marker, body });
  }

  // Numbered definitions are only safe to extract from a "References"
  // / "Notes" / "Endnotes" tail section to avoid grabbing numbered
  // bullet lists from the body.
  const refIdx = head.search(/\n\s*(?:References|Notes|Endnotes|Referencias|Notas)\s*\n/i);
  if (refIdx >= 0) {
    const refSection = head.slice(refIdx);
    for (const m of refSection.matchAll(NUMBERED_NOTE_RE)) {
      if (footnotes.length >= MAX_PER_FILE) break;
      const marker = (m[1] || '').trim();
      const body = clip((m[2] || '').trim(), MAX_BODY_LEN);
      if (!marker || !body) continue;
      const key = `num|${marker}`;
      if (seen.has(key)) continue;
      seen.add(key);
      footnotes.push({ kind: 'numbered', marker, body });
    }
  }

  // Inline markers — for stats only, not paired here.
  const inlineMarkers = [];
  for (const m of head.matchAll(MD_INLINE_RE)) {
    inlineMarkers.push((m[1] || '').trim());
  }
  for (const m of head.matchAll(SUPERSCRIPT_RE)) {
    inlineMarkers.push(m[1]);
  }

  return {
    footnotes,
    inlineMarkers: Array.from(new Set(inlineMarkers)).slice(0, 30),
    total: footnotes.length,
    truncated: text.length > SCAN_HEAD_BYTES,
  };
}

function buildFootnotesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractFootnotes(safeText(f.extractedText));
    if (r.total === 0 && r.inlineMarkers.length === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, report: r });
    aggregate = aggregate.concat(r.footnotes.map((fn) => ({ ...fn, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderFootnote(fn, opts = {}) {
  const file = opts.includeFile && fn.file ? ` _(${fn.file})_` : '';
  return `- [**${fn.kind === 'markdown' ? '[^' + fn.marker + ']' : '[' + fn.marker + ']'}**]${file} ${fn.body}`;
}

function renderFootnotesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## FOOTNOTES & NOTES
Footnote / endnote definitions paired with their markers across the attached document(s). Use this block when the user asks "what does footnote N say?" or to follow chained references — quote the body verbatim before claiming attribution.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const fn of only.report.footnotes) sections.push(renderFootnote(fn));
    if (only.report.inlineMarkers.length) {
      sections.push(`\n_Inline markers detected: ${only.report.inlineMarkers.slice(0, 10).join(', ')}_`);
    }
  } else {
    sections.push('### Aggregate footnotes across all files');
    for (const fn of report.aggregate) sections.push(renderFootnote(fn, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const fn of p.report.footnotes) sections.push(renderFootnote(fn));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...footnotes block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractFootnotes,
  buildFootnotesForFiles,
  renderFootnotesBlock,
  _internal: {
    MD_DEFINITION_RE,
    MD_INLINE_RE,
    NUMBERED_NOTE_RE,
    SUPERSCRIPT_RE,
    MAX_PER_FILE,
  },
};
