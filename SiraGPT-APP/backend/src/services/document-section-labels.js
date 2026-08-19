'use strict';

/**
 * document-section-labels.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects numbered section labels used in legal, regulatory, technical, and
 * academic documents:
 *
 *   - "Section 1.2.3", "Sec. 4.1", "§A", "§1.2", "§§ 3-7"
 *   - "Chapter 4", "Cap. 5", "Capítulo II"
 *   - "Article 12", "Artículo 5"
 *   - "Part III", "Annex B", "Appendix A"
 *   - Spanish equivalents (Sección, Capítulo, Artículo, Anexo)
 *
 * Different from document-outline (heading hierarchy) and
 * document-cross-reference (figure/table refs). Routes "what does
 * Section X say?", "what's Article 5?" to a citeable inventory.
 *
 * Public API:
 *   extractSectionLabels(text)         → SectionLabelReport
 *   buildSectionLabelsForFiles(files)  → { perFile, aggregate, byKind }
 *   renderSectionLabelsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;
const MAX_LABEL_LEN = 80;

const SECTION_PATTERNS = [
  { kind: 'section',    re: /\b(?:Section|Sec\.?|Secci[óo]n)\s+([\dA-Z][\d.\-]*\.?[a-z]?)/gi },
  { kind: 'paragraph',  re: /§§?\s*([\dA-Z][\d.\-]*)/g },
  { kind: 'chapter',    re: /\b(?:Chapter|Cap\.?|Cap[íi]tulo)\s+([IVXLCDM]{2,}|[\dA-Z][\d.\-]*)/gi },
  { kind: 'article',    re: /\b(?:Article|Art\.?|Art[íi]culo)\s+([\dA-Z][\d.\-]*)/gi },
  { kind: 'part',       re: /\bPart\s+([IVXLCDM]+|[\dA-Z][\d.\-]*)/gi },
  { kind: 'annex',      re: /\b(?:Annex|Anexo)\s+([A-Z]|[\dA-Z][\d.\-]*)/gi },
  { kind: 'appendix',   re: /\b(?:Appendix|Ap[ée]ndice)\s+([A-Z]|[\dA-Z][\d.\-]*)/gi },
  { kind: 'clause',     re: /\b(?:Clause|Cl[áa]usula)\s+([\dA-Z][\d.\-]*)/gi },
  { kind: 'paragraphTxt', re: /\b(?:Paragraph|Par[áa]grafo|P[áa]rrafo)\s+([\dA-Z][\d.\-]*)/gi },
];

const KINDS = ['section', 'paragraph', 'chapter', 'article', 'part', 'annex', 'appendix', 'clause', 'paragraphTxt'];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipLabel(s) {
  const t = String(s || '').trim();
  if (t.length <= MAX_LABEL_LEN) return t;
  return `${t.slice(0, MAX_LABEL_LEN - 1)}…`;
}

function emptyByKind() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractSectionLabels(input) {
  const text = safeText(input);
  if (!text) return { labels: [], total: 0, byKind: emptyByKind(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const labels = [];
  const seen = new Set();
  const byKind = emptyByKind();

  for (const { kind, re } of SECTION_PATTERNS) {
    re.lastIndex = 0;
    for (const m of head.matchAll(re)) {
      if (labels.length >= MAX_PER_FILE) break;
      const number = clipLabel(m[1]);
      if (!number) continue;
      const key = `${kind}|${number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      labels.push({ kind, number });
      byKind[kind] += 1;
    }
  }

  return { labels, total: labels.length, byKind, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildSectionLabelsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const byKind = emptyByKind();
  for (const f of list) {
    const r = extractSectionLabels(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, labels: r.labels, byKind: r.byKind });
    aggregate = aggregate.concat(r.labels.map((l) => ({ ...l, file: name })));
    for (const k of KINDS) byKind[k] += r.byKind[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, byKind };
}

function renderLabel(l, opts = {}) {
  const file = opts.includeFile && l.file ? ` _(${l.file})_` : '';
  return `- [${l.kind}] **${l.number}**${file}`;
}

function renderSectionLabelsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const byKind = report.byKind || emptyByKind();
  const breakdown = KINDS
    .filter((k) => byKind[k] > 0)
    .map((k) => `${k}=${byKind[k]}`)
    .join('  ');
  const heading = `## SECTION / ARTICLE LABELS
Numbered section references detected in the document(s): Section (Sección), § (paragraph mark), Chapter (Capítulo), Article (Artículo), Part, Annex (Anexo), Appendix (Apéndice), Clause (Cláusula), Paragraph (Párrafo). Different from document outline (heading hierarchy) and cross-references (figure/table refs). Routes "what does Section X say?" / "what's Article 5?" to a citeable inventory.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const l of only.labels) sections.push(renderLabel(l));
  } else {
    sections.push('### Aggregate labels across all files');
    for (const l of report.aggregate) sections.push(renderLabel(l, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const l of p.labels) sections.push(renderLabel(l));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...section labels block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractSectionLabels,
  buildSectionLabelsForFiles,
  renderSectionLabelsBlock,
  _internal: {
    SECTION_PATTERNS,
    KINDS,
  },
};
