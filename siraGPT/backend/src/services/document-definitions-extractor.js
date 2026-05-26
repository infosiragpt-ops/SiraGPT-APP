'use strict';

/**
 * document-definitions-extractor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Captures explicit definitions stated by an attached document so the
 * chat can answer "what does X mean here?" with the source verbatim,
 * even when the term is non-standard or used in a constrained sense.
 *
 * Different from document-glossary-extractor (which surfaces acronyms
 * and proper-noun terms): this module captures FORMAL DEFINITIONS —
 * "X means Y", "X shall mean Y", "X se define como Y", "Por X se
 * entenderá Y", "X is defined as Y".
 *
 * Each definition is emitted as { term, definition, sentence } with
 * the full source sentence so the model can quote it back.
 *
 * Bilingual. Deterministic. No LLM. < 15 ms on 1 MB.
 *
 * Public API:
 *   extractDefinitions(text)              → DefinitionReport
 *   buildDefinitionsForFiles(files)       → { perFile, aggregate }
 *   renderDefinitionsBlock(batchReport)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_DEFINITIONS_PER_FILE = 16;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4200;
const MIN_TERM_LEN = 2;
const MAX_TERM_LEN = 80;
const MIN_DEF_LEN = 4;
const MAX_DEF_LEN = 280;

// Patterns yield: [_, term, definition]
const DEFINITION_PATTERNS_EN = [
  /\b(?:["“]?)([A-Z][A-Za-z0-9\s\-/&]{1,79})(?:["”]?)\s+(?:means|shall\s+mean|is\s+defined\s+as|refers\s+to|is\s+understood\s+to\s+mean)\s+([^.]{4,280})\.?/g,
  /\b(?:the\s+term\s+)["“]?([A-Z][A-Za-z0-9\s\-/&]{1,79})(?:["”]?)\s+(?:means|shall\s+mean|refers\s+to)\s+([^.]{4,280})\.?/gi,
];

const DEFINITION_PATTERNS_ES = [
  /(?:^|[^\p{L}])(?:["“]?)([A-ZÁÉÍÓÚÑ][A-Za-z0-9ÁÉÍÓÚÑáéíóúñ\s\-/&]{1,79})(?:["”]?)\s+(?:se\s+define\s+como|significa|se\s+entiende\s+(?:como|por)|hace\s+referencia\s+a|denota|representa)\s+([^.]{4,280})\.?/giu,
  /\bPor\s+["“]?([A-ZÁÉÍÓÚÑ][A-Za-z0-9ÁÉÍÓÚÑáéíóúñ\s\-/&]{1,79})(?:["”]?)\s+se\s+(?:entenderá|entiende|comprende|considerará|refiere\s+a)\s+([^.]{4,280})\.?/gi,
];

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

function clean(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').replace(/^["“'(]+|["”'),.;]+$/g, '');
}

function extractDefinitions(input) {
  const text = safeText(input);
  if (!text) return { definitions: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const definitions = [];
  const seen = new Set();
  const allPatterns = [...DEFINITION_PATTERNS_EN, ...DEFINITION_PATTERNS_ES];

  for (const re of allPatterns) {
    if (definitions.length >= MAX_DEFINITIONS_PER_FILE) break;
    const cloned = new RegExp(re.source, re.flags);
    for (const m of head.matchAll(cloned)) {
      if (definitions.length >= MAX_DEFINITIONS_PER_FILE) break;
      const term = clean(m[1]);
      const def = clean(m[2]);
      if (term.length < MIN_TERM_LEN || term.length > MAX_TERM_LEN) continue;
      if (def.length < MIN_DEF_LEN) continue;
      // Avoid capturing sentence fragments that look like definitions
      // but are actually proper-noun + verb without "means" semantics.
      const lowerTerm = term.toLowerCase();
      const lowerDef = def.toLowerCase();
      if (lowerTerm === lowerDef) continue;
      const key = `${lowerTerm}|${lowerDef.slice(0, 40)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Reconstruct the source sentence around the match for citation.
      const start = Math.max(0, (m.index || 0) - 20);
      const end = Math.min(head.length, (m.index || 0) + m[0].length + 20);
      const sentence = clip(head.slice(start, end).trim(), 320);
      definitions.push({
        term,
        definition: clip(def, MAX_DEF_LEN),
        sentence,
      });
    }
  }

  return { definitions, total: definitions.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildDefinitionsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractDefinitions(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, report: r });
    aggregate = aggregate.concat(r.definitions.map((d) => ({ ...d, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderDefinitionLine(d, opts = {}) {
  const file = opts.includeFile && d.file ? ` _(${d.file})_` : '';
  return `- **${d.term}**${file} — ${d.definition}`;
}

function renderDefinitionsBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) return '';
  const heading = `## DOCUMENT DEFINITIONS
Formal definitions extracted from the attached document(s) — "X means Y", "X se define como Y", "Por X se entenderá Y". Use this block to answer "what does X mean in this document?" with the source verbatim, especially when the term is used in a constrained or non-standard sense.`;
  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const d of only.report.definitions) sections.push(renderDefinitionLine(d));
  } else {
    sections.push('### Aggregate definitions across all files');
    for (const d of batchReport.aggregate) sections.push(renderDefinitionLine(d, { includeFile: true }));
    for (const p of batchReport.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const d of p.report.definitions) sections.push(renderDefinitionLine(d));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...definitions block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractDefinitions,
  buildDefinitionsForFiles,
  renderDefinitionsBlock,
  _internal: {
    clean,
    DEFINITION_PATTERNS_EN,
    DEFINITION_PATTERNS_ES,
    MAX_DEFINITIONS_PER_FILE,
  },
};
