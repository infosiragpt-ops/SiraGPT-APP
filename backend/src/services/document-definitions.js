'use strict';

/**
 * document-definitions.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects in-text definition patterns "X is Y" / "X means Y" / "X is defined
 * as Y" common in technical writing. Distinct from document-definition-lists
 * (Markdown DL syntax) and document-glossary-extractor (curated glossary
 * sections).
 *
 *   - "X is a Y"
 *   - "X is defined as Y"
 *   - "X refers to Y"
 *   - "X means Y" / "X denotes Y"
 *   - Spanish: "X es un Y", "X se define como Y", "X se refiere a Y",
 *     "X significa Y"
 *
 * Routes "what does X mean?" / "definition of X" to a citeable list.
 *
 * Public API:
 *   extractDefinitions(text)         → DefinitionReport
 *   buildDefinitionsForFiles(files)  → { perFile, aggregate }
 *   renderDefinitionsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 5000;
const MAX_TERM_LEN = 60;
const MAX_DEF_LEN = 200;

// "X is a Y" / "X is the Y" / "X is Y"
const IS_A_RE = /(?:^|[.!?\n])\s*([A-Z][A-Za-zÀ-ÿ0-9 _\-]{1,50})\s+is\s+(?:a|an|the)\s+([^.!?\n]{8,200})/g;
// "X is defined as Y"
const DEFINED_AS_RE = /\b([A-Z][A-Za-zÀ-ÿ0-9 _\-]{1,50})\s+is\s+defined\s+as\s+([^.!?\n]{4,200})/g;
// "X refers to Y" / "X means Y" / "X denotes Y"
const MEANS_RE = /\b([A-Z][A-Za-zÀ-ÿ0-9 _\-]{1,50})\s+(?:means|denotes|refers\s+to|stands\s+for)\s+([^.!?\n]{4,200})/g;
// Spanish: "X es un Y" / "X es una Y"
const ES_RE = /(?:^|[.!?\n])\s*([A-Z][A-Za-zÀ-ÿ0-9 _\-]{1,50})\s+es\s+(?:un|una|el|la)\s+([^.!?\n]{8,200})/giu;
// Spanish: "X se define como Y" / "X se refiere a Y" / "X significa Y"
const ES_DEF_RE = /\b([A-Z][A-Za-zÀ-ÿ0-9 _\-]{1,50})\s+(?:se\s+define\s+como|significa|se\s+refiere\s+a)\s+([^.!?\n]{4,200})/giu;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipTerm(s) {
  const t = String(s || '').trim();
  if (t.length <= MAX_TERM_LEN) return t;
  return `${t.slice(0, MAX_TERM_LEN - 1)}…`;
}

function clipDef(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_DEF_LEN) return t;
  return `${t.slice(0, MAX_DEF_LEN - 1)}…`;
}

function isLikelyTerm(s) {
  if (!s) return false;
  const t = s.trim();
  // Reject if too short
  if (t.length < 2) return false;
  // Reject sentence-like (contains common verbs)
  if (/\b(the|a|an|is|was|were|will|shall|might|may|can|but|and|or|of|to|in|on|at|for|with|by)\b/i.test(t)) {
    // Allow only if first word is capitalized and singular
    const firstWord = t.split(/\s+/)[0];
    if (firstWord.length < 3) return false;
  }
  return true;
}

function extractDefinitions(input) {
  const text = safeText(input);
  if (!text) return { definitions: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const definitions = [];
  const seen = new Set();

  function add(term, definition, kind) {
    if (definitions.length >= MAX_PER_FILE) return;
    const t = clipTerm(term);
    const d = clipDef(definition);
    if (!t || !d) return;
    if (!isLikelyTerm(t)) return;
    const key = `${t.toLowerCase()}|${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    definitions.push({ term: t, definition: d, kind });
  }

  for (const m of head.matchAll(DEFINED_AS_RE)) add(m[1], m[2], 'defined-as');
  for (const m of head.matchAll(MEANS_RE)) add(m[1], m[2], 'means');
  for (const m of head.matchAll(ES_DEF_RE)) add(m[1], m[2], 'es-def');
  for (const m of head.matchAll(IS_A_RE)) add(m[1], m[2], 'is-a');
  for (const m of head.matchAll(ES_RE)) add(m[1], m[2], 'es-is-a');

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
    perFile.push({ file: name, definitions: r.definitions });
    aggregate = aggregate.concat(r.definitions.map((d) => ({ ...d, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderDef(d, opts = {}) {
  const file = opts.includeFile && d.file ? ` _(${d.file})_` : '';
  return `- [${d.kind}]${file} **${d.term}**: ${d.definition}`;
}

function renderDefinitionsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## IN-TEXT DEFINITIONS
Inline definition patterns detected: "X is a Y" / "X is the Y" (is-a), "X is defined as Y" (defined-as), "X means Y" / "X refers to Y" / "X denotes Y" / "X stands for Y" (means), Spanish "X es un Y" (es-is-a), "X se define como" / "X significa" / "X se refiere a" (es-def). Different from definition-lists (Markdown DL syntax) and glossary-extractor (curated sections). Routes "what does X mean?" / "definition of X" to a citeable list.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const d of only.definitions) sections.push(renderDef(d));
  } else {
    sections.push('### Aggregate definitions across all files');
    for (const d of report.aggregate) sections.push(renderDef(d, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const d of p.definitions) sections.push(renderDef(d));
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
    IS_A_RE,
    DEFINED_AS_RE,
    MEANS_RE,
    ES_RE,
    ES_DEF_RE,
    isLikelyTerm,
  },
};
