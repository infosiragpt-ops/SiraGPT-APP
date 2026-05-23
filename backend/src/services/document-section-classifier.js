'use strict';

/**
 * document-section-classifier.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Classifies the body of a document into rhetorical sections by HEADING
 * text + opening-paragraph lexical cues. Two routing-friendly schemas
 * are recognized:
 *
 *   academic   intro · method · results · discussion · conclusion
 *              · related-work · abstract · references
 *   legal      preamble · definitions · parties · obligations · payment
 *              · termination · liability · law-and-jurisdiction · annex
 *
 * Distinct from document-outline-generator: the outline is a literal
 * table of contents (heading text + numbering). This module assigns a
 * *role* to each section so the model can answer "what does the results
 * section say" without re-scanning the whole document.
 *
 * Bilingual (Spanish / English). Deterministic. < 10 ms on 1 MB.
 *
 * Public API:
 *   classifySections(text, opts)         → SectionReport
 *   buildSectionsForFiles(files)         → { perFile, aggregate }
 *   renderSectionsBlock(batchReport)     → markdown string ('' when empty)
 */

const MAX_SECTIONS_PER_FILE = 20;
const MAX_BLOCK_CHARS = 3500;
const MAX_SECTION_PREVIEW = 160;

const HEADING_RE = /^\s{0,3}(?:#{1,6}\s+|(?:\d+(?:\.\d+)*\.?\s+))(.+?)\s*$/gm;
// Bare-line heading: short line in Title Case or ALL CAPS, surrounded by blank lines.
const BARE_HEADING_RE = /(^|\n)\n([A-ZÁÉÍÓÚÑ][^\n]{2,60})\n+/g;

// Heading-text patterns mapped to (schema, role). Order matters within
// each list: longer / more specific phrases come FIRST.
const ROLE_PATTERNS = [
  // ── Academic ───────────────────────────────────────────────────
  { schema: 'academic', role: 'abstract',     re: /^(abstract|resumen|síntesis)\b/i },
  { schema: 'academic', role: 'intro',        re: /^(introduction|introducción|presentación|antecedentes)\b/i },
  { schema: 'academic', role: 'related-work', re: /^(related work|estado del arte|trabajos? relacionados?|marco te[óo]rico|literature review)\b/i },
  { schema: 'academic', role: 'method',       re: /^(method(?:s|olog(?:y|ía))?|metodolog[íi]a|materials and methods|materiales y m[ée]todos|enfoque|approach)\b/i },
  { schema: 'academic', role: 'results',      re: /^(results?|resultados?|findings?|hallazgos?)\b/i },
  { schema: 'academic', role: 'discussion',   re: /^(discussion|discusi[óo]n|interpretation|interpretaci[óo]n)\b/i },
  { schema: 'academic', role: 'conclusion',   re: /^(conclusions?|conclusiones?|cierre|s[íi]ntesis final)\b/i },
  { schema: 'academic', role: 'references',   re: /^(references?|bibliography|bibliograf[íi]a|referencias?)\b/i },

  // ── Legal ──────────────────────────────────────────────────────
  { schema: 'legal', role: 'preamble',              re: /^(preamble|preámbulo|considerando|whereas)\b/i },
  { schema: 'legal', role: 'definitions',           re: /^(definitions?|definici[óo]nes?|glossary|glosario)\b/i },
  { schema: 'legal', role: 'parties',               re: /^(parties|partes|de las partes|the parties)\b/i },
  { schema: 'legal', role: 'obligations',           re: /^(obligations?|obligaciones?|duties|deberes|responsibilities|responsabilidades)\b/i },
  { schema: 'legal', role: 'payment',               re: /^(payment( terms)?|condiciones de pago|honorarios|precio|fees?|compensation|remuneraci[óo]n)\b/i },
  { schema: 'legal', role: 'termination',           re: /^(termination|terminaci[óo]n|rescisi[óo]n|cancellation|cancelaci[óo]n)\b/i },
  { schema: 'legal', role: 'liability',             re: /^(liabilit(?:y|ies)|responsabilidad|warrant(?:y|ies)|garant[íi]as?|indemnity|indemnizaci[óo]n)\b/i },
  { schema: 'legal', role: 'law-and-jurisdiction',  re: /^(governing law|ley aplicable|jurisdiction|jurisdicci[óo]n|fuero)\b/i },
  { schema: 'legal', role: 'annex',                 re: /^(annex(?:es)?|anexos?|appendix|ap[ée]ndice|exhibits?|adjuntos?)\b/i },
];

const SCHEMA_LABEL = {
  academic: 'Académico',
  legal: 'Legal',
};
const ROLE_LABEL = {
  abstract: 'Resumen', intro: 'Introducción', 'related-work': 'Trabajos relacionados',
  method: 'Método', results: 'Resultados', discussion: 'Discusión',
  conclusion: 'Conclusión', references: 'Referencias',
  preamble: 'Preámbulo', definitions: 'Definiciones', parties: 'Partes',
  obligations: 'Obligaciones', payment: 'Pagos', termination: 'Terminación',
  liability: 'Responsabilidad', 'law-and-jurisdiction': 'Ley y jurisdicción',
  annex: 'Anexos',
};

function safeStr(v) {
  return typeof v === 'string' ? v : '';
}

function classifyHeading(heading) {
  const trimmed = heading.replace(/^[\d.\s]+/, '').trim();
  for (const { schema, role, re } of ROLE_PATTERNS) {
    if (re.test(trimmed)) return { schema, role };
  }
  return null;
}

/**
 * Extract headings + their position. Combines markdown/numbered patterns
 * with bare-line heading detection. Returns sorted by position.
 */
function extractHeadings(text) {
  const out = [];
  for (const m of text.matchAll(HEADING_RE)) {
    out.push({ heading: m[1].trim(), index: m.index ?? 0 });
  }
  for (const m of text.matchAll(BARE_HEADING_RE)) {
    const candidate = m[2].trim();
    // Skip if already captured (avoid double-matching).
    if (out.some((h) => Math.abs(h.index - (m.index ?? 0)) < 10)) continue;
    // Bare-line headings: at most 8 words and no terminal punctuation.
    const words = candidate.split(/\s+/);
    if (words.length > 8) continue;
    if (/[.!?;,]$/.test(candidate)) continue;
    out.push({ heading: candidate, index: m.index ?? 0 });
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

/**
 * @param {string} text
 * @param {{ maxSections?: number }} [opts]
 */
function classifySections(text, opts = {}) {
  const empty = {
    sections: [],
    schema: null,
    counts: {},
    sectionCount: 0,
  };
  const raw = safeStr(text);
  if (!raw) return empty;

  const headings = extractHeadings(raw);
  if (headings.length === 0) return empty;

  const classified = [];
  for (let i = 0; i < headings.length; i += 1) {
    const h = headings[i];
    const role = classifyHeading(h.heading);
    if (!role) continue;
    // Preview = first non-empty line under the heading.
    const nextIdx = i + 1 < headings.length ? headings[i + 1].index : raw.length;
    const body = raw.slice(h.index + h.heading.length, nextIdx)
      .split('\n').map((l) => l.trim()).filter(Boolean)
      .join(' ').trim();
    const preview = body.length > MAX_SECTION_PREVIEW
      ? `${body.slice(0, MAX_SECTION_PREVIEW - 1)}…`
      : body;
    classified.push({
      heading: h.heading,
      schema: role.schema,
      role: role.role,
      index: h.index,
      preview,
    });
  }

  // Determine dominant schema by majority.
  const counts = {};
  const schemaVotes = { academic: 0, legal: 0 };
  for (const c of classified) {
    counts[c.role] = (counts[c.role] || 0) + 1;
    schemaVotes[c.schema] += 1;
  }
  const schema = schemaVotes.academic === 0 && schemaVotes.legal === 0
    ? null
    : (schemaVotes.academic >= schemaVotes.legal ? 'academic' : 'legal');

  const max = Math.max(4, opts.maxSections || MAX_SECTIONS_PER_FILE);
  return {
    sections: classified.slice(0, max),
    schema,
    counts,
    sectionCount: classified.length,
  };
}

/**
 * @param {Array<{ originalName?: string, filename?: string, name?: string, extractedText?: string, text?: string }>} files
 */
function buildSectionsForFiles(files) {
  const list = Array.isArray(files) ? files.filter((f) => f && typeof f === 'object') : [];
  const perFile = [];
  const aggregate = { sections: [], counts: {}, schemas: { academic: 0, legal: 0 }, sectionCount: 0 };
  for (const f of list) {
    const text = safeStr(f.extractedText || f.text);
    if (!text) continue;
    const report = classifySections(text);
    if (report.sectionCount === 0) continue;
    const label = f.originalName || f.filename || f.name || 'archivo';
    perFile.push({ file: label, report });
    for (const [k, v] of Object.entries(report.counts)) {
      aggregate.counts[k] = (aggregate.counts[k] || 0) + v;
    }
    if (report.schema) aggregate.schemas[report.schema] += 1;
    aggregate.sectionCount += report.sectionCount;
  }
  return { perFile, aggregate };
}

function renderSection(s) {
  const label = ROLE_LABEL[s.role] || s.role;
  const preview = s.preview ? ` — ${s.preview}` : '';
  return `- _${label}_ · **${s.heading}**${preview}`;
}

/**
 * @param {ReturnType<typeof buildSectionsForFiles>} batchReport
 */
function renderSectionsBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) {
    return '';
  }
  const heading = `## DOCUMENT SECTION ROLES
Each heading mapped to a rhetorical role. Schemas: \`academic\` (intro/method/results/discussion/conclusion/related-work/abstract/references) and \`legal\` (preamble/definitions/parties/obligations/payment/termination/liability/law-and-jurisdiction/annex). Use this block to route "what does the results section say" / "where are the obligations" / "show me the conclusion" questions directly to the relevant span.`;

  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    const schemaLabel = only.report.schema ? SCHEMA_LABEL[only.report.schema] : 'mixto';
    sections.push(`### File: ${only.file} _(schema: ${schemaLabel})_`);
    for (const s of only.report.sections) sections.push(renderSection(s));
  } else {
    const aggLines = [];
    for (const [role, n] of Object.entries(batchReport.aggregate.counts)) {
      aggLines.push(`- ${ROLE_LABEL[role] || role}: ${n}`);
    }
    if (aggLines.length > 0) {
      sections.push('### Aggregate across all files');
      sections.push(aggLines.join('\n'));
    }
    for (const p of batchReport.perFile) {
      const schemaLabel = p.report.schema ? SCHEMA_LABEL[p.report.schema] : 'mixto';
      sections.push(`### File: ${p.file} _(schema: ${schemaLabel})_`);
      for (const s of p.report.sections) sections.push(renderSection(s));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...section roles truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  classifySections,
  buildSectionsForFiles,
  renderSectionsBlock,
  _internal: {
    ROLE_PATTERNS,
    ROLE_LABEL,
    SCHEMA_LABEL,
    MAX_SECTIONS_PER_FILE,
    MAX_BLOCK_CHARS,
    classifyHeading,
    extractHeadings,
  },
};
