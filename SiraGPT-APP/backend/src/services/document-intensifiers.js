'use strict';

/**
 * document-intensifiers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects adverbial intensifiers in argumentative prose:
 *
 *   - very, extremely, highly, deeply, truly, profoundly, immensely,
 *     incredibly, tremendously, exceedingly, utterly, absolutely
 *   - Spanish: muy, extremadamente, sumamente, altamente, demasiado,
 *     totalmente, completamente, profundamente, increíblemente
 *
 * Routes "how intense?" / "is this overstated?" to a citeable summary.
 *
 * Public API:
 *   extractIntensifiers(text)         → IntensifierReport
 *   buildIntensifiersForFiles(files)  → { perFile }
 *   renderIntensifiersBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;
const MAX_CONTEXT_LEN = 180;

const INTENSIFIERS = [
  'very', 'extremely', 'highly', 'deeply', 'truly', 'profoundly',
  'immensely', 'incredibly', 'tremendously', 'exceedingly', 'utterly',
  'absolutely', 'totally', 'completely', 'thoroughly', 'remarkably',
  'particularly', 'especially', 'notably', 'significantly',
  'muy', 'extremadamente', 'sumamente', 'altamente', 'demasiado',
  'totalmente', 'completamente', 'profundamente', 'incre[íi]blemente',
  'enormemente', 'tremendamente', 'absolutamente', 'realmente',
  'particularmente', 'especialmente',
];

const INTENSIFIER_RE = new RegExp(`(?<![A-Za-zÀ-ÿ0-9_])(${INTENSIFIERS.join('|')})(?![A-Za-zÀ-ÿ0-9_])`, 'giu');

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipContext(text, idx, len) {
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + len + 80);
  const ctx = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (ctx.length <= MAX_CONTEXT_LEN) return ctx;
  return `${ctx.slice(0, MAX_CONTEXT_LEN - 1)}…`;
}

function extractIntensifiers(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, density: 0, words: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();

  for (const m of head.matchAll(INTENSIFIER_RE)) {
    if (entries.length >= MAX_PER_FILE) break;
    const word = m[1].toLowerCase();
    const ctx = clipContext(head, m.index, m[0].length);
    const key = `${word}|${ctx.slice(0, 60).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ word, context: ctx });
  }

  const words = (head.match(/\w+/g) || []).length;
  const density = words > 0 ? Math.round((entries.length / words) * 1000 * 100) / 100 : 0;
  return { entries, total: entries.length, density, words, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildIntensifiersForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractIntensifiers(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, density: r.density, words: r.words });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- **${e.word}**${file} — ${e.context}`;
}

function renderIntensifiersBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## INTENSIFIERS
Adverbial intensifiers (very, extremely, highly, profoundly, incredibly, absolutely, totally, completely, …) including Spanish equivalents (muy, extremadamente, sumamente, altamente, totalmente, completamente, profundamente, increíblemente, …). High density may indicate emphasis bias or overstatement. Routes "how intense?" / "is this overstated?".`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file} (density ${only.density}/1k, ${only.words} words)`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate intensifiers across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file} (density ${p.density}/1k)`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...intensifiers block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractIntensifiers,
  buildIntensifiersForFiles,
  renderIntensifiersBlock,
  _internal: {
    INTENSIFIERS,
    INTENSIFIER_RE,
  },
};
