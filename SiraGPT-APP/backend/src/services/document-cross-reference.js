'use strict';

/**
 * document-cross-reference.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects internal cross-references inside an attached document so
 * the chat can answer "what does Section 4.2 cover?" / "which clauses
 * reference X?" without re-scanning raw text.
 *
 * A cross-reference is a phrase that points to another part of the
 * SAME document, e.g.:
 *
 *   - "See Section 4.2 for further details."
 *   - "As stated in Article 7.1, the parties …"
 *   - "Refer to Annex A …"
 *   - "Véase la Cláusula 3.1"
 *   - "Conforme al apartado 5"
 *
 * The module emits one entry per pointer with the target token
 * (Section 4.2, Anexo A, etc.), the source sentence and an outbound-
 * count per pointer so the chat can rank popular targets.
 *
 * Bilingual. Deterministic. < 15 ms on 1 MB.
 *
 * Public API:
 *   extractReferences(text)               → ReferenceReport
 *   buildReferencesForFiles(files)        → { perFile, aggregate }
 *   renderReferencesBlock(report)         → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_REFS_PER_FILE = 18;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4200;
const MIN_SENTENCE_LEN = 12;
const MAX_SENTENCE_LEN = 260;

// Each pattern captures the target token in capture group 1.
const REF_PATTERNS_EN = [
  /\b(?:see|refer\s+to|pursuant\s+to|as\s+(?:set\s+forth|stated|provided|described)\s+in|in\s+accordance\s+with|under)\s+(Section|Article|Clause|Annex(?:ure)?|Schedule|Exhibit|Appendix|Part|Chapter|Paragraph)\s+([A-Z0-9]+(?:\.[A-Z0-9]+){0,3})/i,
  /\b(Section|Article|Clause|Annex(?:ure)?|Schedule|Exhibit|Appendix|Part|Chapter|Paragraph)\s+([A-Z0-9]+(?:\.[A-Z0-9]+){0,3})\s+(?:above|below|herein|hereof|hereto)/i,
];

const REF_PATTERNS_ES = [
  /(?:^|[^\p{L}])(?:v[eé]ase|seg[uú]n|conforme\s+al?|de\s+conformidad\s+con|en\s+los\s+t[eé]rminos\s+de|en\s+virtud\s+de|en\s+el\s+marco\s+de)\s+(?:la\s+|el\s+|los\s+|las\s+)?(Secci[oó]n|Art[ií]culo|Cl[áa]usula|Anexo|Ap[eé]ndice|Cap[ií]tulo|Apartado|P[áa]rrafo|Inciso|Acuerdo)\s+([A-Z0-9]+(?:\.[A-Z0-9]+){0,3})/iu,
];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clip(text, max = MAX_SENTENCE_LEN) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function sentenceAround(text, idx, len) {
  const punct = ['.', '!', '?', '。', '！', '？', '\n'];
  let from = idx;
  while (from > 0 && !punct.includes(text[from - 1])) from--;
  let to = idx + len;
  while (to < text.length && !punct.includes(text[to])) to++;
  return text.slice(from, Math.min(to + 1, text.length)).trim();
}

function extractReferences(input) {
  const text = safeText(input);
  if (!text) return { references: [], targetCounts: {}, total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const references = [];
  const seen = new Set();
  const targetCounts = new Map();
  const allPatterns = [...REF_PATTERNS_EN, ...REF_PATTERNS_ES];
  for (const re of allPatterns) {
    if (references.length >= MAX_REFS_PER_FILE) break;
    const cloned = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of head.matchAll(cloned)) {
      if (references.length >= MAX_REFS_PER_FILE) break;
      const kind = (m[1] || '').trim();
      const id = (m[2] || '').trim();
      if (!kind || !id) continue;
      const target = `${kind} ${id}`;
      const sentence = clip(sentenceAround(head, m.index || 0, m[0].length));
      if (sentence.length < MIN_SENTENCE_LEN) continue;
      const key = `${target.toLowerCase()}|${sentence.toLowerCase().slice(0, 60)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push({ target, sentence });
      targetCounts.set(target, (targetCounts.get(target) || 0) + 1);
    }
  }
  return {
    references,
    targetCounts: Object.fromEntries(targetCounts),
    total: references.length,
    truncated: text.length > SCAN_HEAD_BYTES,
  };
}

function buildReferencesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractReferences(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, report: r });
    aggregate = aggregate.concat(r.references.map((ref) => ({ ...ref, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderReferenceLine(r, opts = {}) {
  const file = opts.includeFile && r.file ? ` _(${r.file})_` : '';
  return `- **→ ${r.target}**${file}: "${r.sentence}"`;
}

function renderReferencesBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) return '';
  const heading = `## INTERNAL CROSS-REFERENCES
Pointers to other sections within the same document — "see Section 4.2", "véase la Cláusula 3.1", "as set forth in Article 7". Use this block when the user asks "what does Section X say?" or when chained clauses need to be followed; quote the source sentence verbatim before claiming the target's contents.`;
  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const r of only.report.references) sections.push(renderReferenceLine(r));
    const targets = Object.entries(only.report.targetCounts).sort((a, b) => b[1] - a[1]);
    if (targets.length > 0) {
      sections.push('\n**Most-referenced targets:**');
      for (const [target, count] of targets.slice(0, 6)) sections.push(`- ${target}: ${count} mention${count === 1 ? '' : 's'}`);
    }
  } else {
    sections.push('### Aggregate cross-references');
    for (const r of batchReport.aggregate) sections.push(renderReferenceLine(r, { includeFile: true }));
    for (const p of batchReport.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const r of p.report.references) sections.push(renderReferenceLine(r));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...cross-reference block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractReferences,
  buildReferencesForFiles,
  renderReferencesBlock,
  _internal: {
    sentenceAround,
    REF_PATTERNS_EN,
    REF_PATTERNS_ES,
    MAX_REFS_PER_FILE,
  },
};
