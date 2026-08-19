'use strict';

/**
 * document-attributions.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects source attribution phrases:
 *
 *   - "According to X" / "As X argues" / "X reports that"
 *   - "Per X" / "Per the X" / "As per X"
 *   - "Cited in X" / "Per their reporting"
 *   - Spanish: "Según X" / "De acuerdo con X" / "Conforme a X"
 *
 * Captures the attributed source name. Different from citations
 * (academic refs) by focusing on inline attribution prose. Routes
 * "who's the source?" / "according to whom?" to a citeable list.
 *
 * Public API:
 *   extractAttributions(text)         → AttributionReport
 *   buildAttributionsForFiles(files)  → { perFile, aggregate }
 *   renderAttributionsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;
const MAX_SOURCE_LEN = 100;

const PHRASES = [
  /\bAccording\s+to\s+(?:the\s+)?([A-Z][^.,;\n]{2,80})/g,
  /\bAs\s+(?:per|stated\s+by|reported\s+by|noted\s+by)\s+(?:the\s+)?([A-Z][^.,;\n]{2,80})/g,
  /\bPer\s+(?:the\s+)?([A-Z][^.,;\n]{2,80})/g,
  /\bCited\s+(?:in|by)\s+(?:the\s+)?([A-Z][^.,;\n]{2,80})/g,
  /\bSeg[úu]n\s+([A-Z][^.,;\n]{2,80})/giu,
  /\bDe\s+acuerdo\s+con\s+([A-Z][^.,;\n]{2,80})/giu,
  /\bConforme\s+a\s+([A-Z][^.,;\n]{2,80})/giu,
];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipSource(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  // Cut at first comma / period / conjunction
  const truncated = t.split(/,|;|\.|\sand\sthe\s|\sin\sthe\s/)[0].trim();
  if (truncated.length <= MAX_SOURCE_LEN) return truncated;
  return `${truncated.slice(0, MAX_SOURCE_LEN - 1)}…`;
}

function extractAttributions(input) {
  const text = safeText(input);
  if (!text) return { attributions: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const attributions = [];
  const seen = new Set();

  for (const re of PHRASES) {
    re.lastIndex = 0;
    for (const m of head.matchAll(re)) {
      if (attributions.length >= MAX_PER_FILE) break;
      const source = clipSource(m[1]);
      if (!source) continue;
      const key = source.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      attributions.push({ source, phrase: m[0].split(/\s+/).slice(0, 3).join(' ') });
    }
  }

  return { attributions, total: attributions.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildAttributionsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractAttributions(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, attributions: r.attributions });
    aggregate = aggregate.concat(r.attributions.map((a) => ({ ...a, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderAttribution(a, opts = {}) {
  const file = opts.includeFile && a.file ? ` _(${a.file})_` : '';
  return `- _${a.phrase}_ **${a.source}**${file}`;
}

function renderAttributionsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## SOURCE ATTRIBUTIONS
Inline source attribution phrases detected — "According to X", "Per X", "As reported by X", "Cited in X" (English) and "Según X", "De acuerdo con X", "Conforme a X" (Spanish). Captures the attributed source name. Different from academic citations by focusing on inline attribution prose. Routes "who's the source?" / "according to whom?" to a citeable list.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const a of only.attributions) sections.push(renderAttribution(a));
  } else {
    sections.push('### Aggregate attributions across all files');
    for (const a of report.aggregate) sections.push(renderAttribution(a, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const a of p.attributions) sections.push(renderAttribution(a));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...attributions block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractAttributions,
  buildAttributionsForFiles,
  renderAttributionsBlock,
  _internal: {
    PHRASES,
    clipSource,
  },
};
