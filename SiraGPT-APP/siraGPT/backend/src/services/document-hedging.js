'use strict';

/**
 * document-hedging.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects epistemic hedging language — words that soften claims:
 *
 *   - "perhaps", "possibly", "seemingly", "apparently", "presumably",
 *     "arguably", "supposedly", "allegedly"
 *   - "appears to", "seems to", "tends to", "is likely to"
 *   - Spanish: "quizás", "posiblemente", "aparentemente",
 *     "al parecer", "tal vez", "supuestamente"
 *
 * High hedging density indicates uncertain claims. Routes "how certain?"
 * / "are these hedged?" to a citeable summary.
 *
 * Public API:
 *   extractHedging(text)         → HedgingReport
 *   buildHedgingForFiles(files)  → { perFile, aggregate, totals }
 *   renderHedgingBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 26;
const MAX_BLOCK_CHARS = 5000;
const MAX_CONTEXT_LEN = 200;

const PATTERNS = [
  /\bperhaps\b/gi,
  /\bpossibly\b/gi,
  /\bseemingly\b/gi,
  /\bapparently\b/gi,
  /\bpresumably\b/gi,
  /\barguably\b/gi,
  /\bsupposedly\b/gi,
  /\ballegedly\b/gi,
  /\bappears\s+to\b/gi,
  /\bseems?\s+to\b/gi,
  /\btends\s+to\b/gi,
  /\bis\s+likely\s+to\b/gi,
  /\bmight\s+be\b/gi,
  /\bcould\s+be\b/gi,
  /\bquiz[áa]s?\b/giu,
  /\bposiblemente\b/gi,
  /\baparentemente\b/gi,
  /\bal\s+parecer\b/gi,
  /\btal\s+vez\b/gi,
  /\bsupuestamente\b/gi,
  /\bparece\s+(?:que|ser)\b/gi,
];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipContext(text, idx, len) {
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + len + 100);
  const ctx = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (ctx.length <= MAX_CONTEXT_LEN) return ctx;
  return `${ctx.slice(0, MAX_CONTEXT_LEN - 1)}…`;
}

function extractHedging(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, density: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();

  for (const re of PATTERNS) {
    re.lastIndex = 0;
    for (const m of head.matchAll(re)) {
      if (entries.length >= MAX_PER_FILE) break;
      const ctx = clipContext(head, m.index, m[0].length);
      const phrase = m[0].toLowerCase().trim();
      const key = `${phrase}|${ctx.slice(0, 60).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ phrase, context: ctx });
    }
  }

  const words = (head.match(/\w+/g) || []).length;
  const density = words > 0 ? Math.round((entries.length / words) * 1000 * 100) / 100 : 0;
  return { entries, total: entries.length, density, words, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildHedgingForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractHedging(safeText(f.extractedText));
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
  return `- **${e.phrase}**${file} — ${e.context}`;
}

function renderHedgingBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## HEDGING LANGUAGE
Epistemic hedge words that soften claims: perhaps, possibly, seemingly, apparently, presumably, arguably, supposedly, allegedly, appears to, seems to, tends to, might be, could be (English) and quizás, posiblemente, aparentemente, al parecer, tal vez, supuestamente, parece que (Spanish). High density indicates uncertain claims. Routes "how certain?" / "are these hedged?" to a citeable summary.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file} (density ${only.density}/1k words, ${only.words} words)`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate hedging across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file} (density ${p.density}/1k)`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...hedging block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractHedging,
  buildHedgingForFiles,
  renderHedgingBlock,
  _internal: {
    PATTERNS,
  },
};
