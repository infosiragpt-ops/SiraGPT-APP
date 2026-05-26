'use strict';

/**
 * document-figure-refs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects FIGURE / TABLE / CHART / DIAGRAM / EQUATION references with
 * their numeric label and (when present) a nearby caption sentence.
 * Routes "what does Figure 3 show?" / "where is Table 5?" to a
 * citeable list. Bilingual: Figure / Figura, Table / Tabla / Cuadro,
 * Chart / Gráfico, Equation / Ecuación, Diagram / Diagrama.
 *
 * Different from document-cross-reference (Section / Article / Clause
 * pointers) and document-tables (extracts table BODY): this surfaces
 * REFERENCES to visual artefacts + their captions.
 *
 * Public API:
 *   extractFigureRefs(text)              → FigureRefReport
 *   buildFigureRefsForFiles(files)       → { perFile, aggregate }
 *   renderFigureRefsBlock(report)        → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4000;
const MIN_CAPTION_LEN = 12;
const MAX_CAPTION_LEN = 240;

const KIND_PATTERNS = [
  { kind: 'figure',   re: /\b(?:Figure|Figura|Fig\.?)\s+([A-Z0-9]+(?:[.\-][A-Z0-9]+)?)/g },
  { kind: 'table',    re: /\b(?:Table|Tabla|Cuadro)\s+([A-Z0-9]+(?:[.\-][A-Z0-9]+)?)/g },
  { kind: 'chart',    re: /\b(?:Chart|Gr[áa]fico|Gr[áa]fica)\s+([A-Z0-9]+(?:[.\-][A-Z0-9]+)?)/g },
  { kind: 'equation', re: /\b(?:Equation|Ecuaci[oó]n|Eq\.?)\s+([A-Z0-9]+(?:[.\-][A-Z0-9]+)?)/g },
  { kind: 'diagram',  re: /\b(?:Diagram|Diagrama)\s+([A-Z0-9]+(?:[.\-][A-Z0-9]+)?)/g },
  { kind: 'appendix', re: /\b(?:Appendix|Anexo|Ap[eé]ndice)\s+([A-Z0-9]+(?:[.\-][A-Z0-9]+)?)/g },
];

const CAPTION_RE = /^\s*(Figure|Figura|Fig|Table|Tabla|Cuadro|Chart|Gr[áa]fico|Gr[áa]fica|Equation|Ecuaci[oó]n|Eq|Diagram|Diagrama|Appendix|Anexo|Ap[eé]ndice)\s+([A-Z0-9]+(?:[.\-][A-Z0-9]+)?)\s*[:.\-]\s*(.{8,400})$/i;

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

function findCaption(text, kind, label) {
  // Walk through line-by-line, looking for a "Figure 3: caption" line.
  // Captions can appear before or after the reference; we look at the
  // entire scanned head with a permissive regex.
  const lines = text.split(/\n/);
  for (const line of lines) {
    const m = line.match(CAPTION_RE);
    if (!m) continue;
    const matchedLabel = (m[2] || '').trim();
    if (matchedLabel.toUpperCase() !== label.toUpperCase()) continue;
    return clip((m[3] || '').trim(), MAX_CAPTION_LEN);
  }
  return null;
}

function extractFigureRefs(input) {
  const text = safeText(input);
  if (!text) return { references: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const references = [];
  const seen = new Set();
  for (const { kind, re } of KIND_PATTERNS) {
    if (references.length >= MAX_PER_FILE) break;
    const cloned = new RegExp(re.source, re.flags);
    for (const m of head.matchAll(cloned)) {
      if (references.length >= MAX_PER_FILE) break;
      const label = (m[1] || '').trim();
      if (!label) continue;
      const key = `${kind}|${label.toUpperCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const caption = findCaption(head, kind, label);
      references.push({ kind, label, caption });
    }
  }
  return { references, total: references.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildFigureRefsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractFigureRefs(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, references: r.references });
    aggregate = aggregate.concat(r.references.map((x) => ({ ...x, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderRef(r, opts = {}) {
  const file = opts.includeFile && r.file ? ` _(${r.file})_` : '';
  const caption = r.caption && r.caption.length >= MIN_CAPTION_LEN ? ` — ${r.caption}` : '';
  return `- **${r.kind.charAt(0).toUpperCase() + r.kind.slice(1)} ${r.label}**${file}${caption}`;
}

function renderFigureRefsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## FIGURE / TABLE REFERENCES
Visual-artefact references surfaced from the attached document(s) — Figure / Table / Chart / Equation / Diagram / Appendix labels with their caption when stated. Routes "what does Figure N show?" / "where is Table M?" to a citeable list.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const r of only.references) sections.push(renderRef(r));
  } else {
    sections.push('### Aggregate references across all files');
    for (const r of report.aggregate) sections.push(renderRef(r, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const r of p.references) sections.push(renderRef(r));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...figure refs block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractFigureRefs,
  buildFigureRefsForFiles,
  renderFigureRefsBlock,
  _internal: {
    findCaption,
    KIND_PATTERNS,
    CAPTION_RE,
  },
};
