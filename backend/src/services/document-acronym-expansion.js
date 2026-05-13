'use strict';

/**
 * document-acronym-expansion.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects acronym ↔ expanded-form pairings in attached documents so
 * the chat answers "what does X stand for?" with the source's own
 * expansion rather than a generic dictionary guess. Different from
 * document-glossary-extractor (which lists terms encountered): this
 * module captures the actual MAPPING the document declares.
 *
 * Recognised patterns (deterministic, bilingual, < 10 ms on 1 MB):
 *
 *   - "Acme Business Corp (ABC)"
 *   - "ABC (Acme Business Corp)"
 *   - "Acme Business Corp, hereinafter ABC,"
 *   - "Acme Business Corp, en adelante ABC,"
 *
 * Bilingual. Deterministic. Stateless.
 *
 * Public API:
 *   extractAcronymPairs(text)             → AcronymReport
 *   buildAcronymsForFiles(files)          → { perFile, aggregate }
 *   renderAcronymsBlock(report)           → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PAIRS_PER_FILE = 22;
const MAX_AGGREGATE = 32;
const MAX_BLOCK_CHARS = 3800;
const MIN_ACRONYM_LEN = 2;
const MAX_ACRONYM_LEN = 10;
const MIN_EXPANSION_LEN = 4;
const MAX_EXPANSION_LEN = 120;

// "Expanded Form (ACR)" — multiple capitalised words then an acronym in parens.
const EXPANSION_THEN_ACR_RE = /\b((?:[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.\-']{1,30}\s+){1,8}[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.\-']{1,30})\s*\(([A-Z][A-Z0-9]{1,9})\)/g;

// "ACR (Expanded Form)" — acronym in caps, then full form in parens.
const ACR_THEN_EXPANSION_RE = /\b([A-Z][A-Z0-9]{1,9})\s*\(((?:[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.\-']{1,30}\s+){1,8}[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.\-']{1,30})\)/g;

// "Expanded Form, hereinafter X," / "Expanded Form, en adelante X,"
const HEREINAFTER_RE = /\b((?:[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.\-']{1,30}\s+){1,8}[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.\-']{1,30}),?\s+(?:hereinafter|hereafter|in\s+adelante|en\s+adelante|conocido\s+como)\s+("?[A-Z][A-Z0-9]{1,9}"?)\s*[,.]?/i;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clean(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').replace(/^["']+|["']+$/g, '');
}

function clip(text, max) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function validPair(acronym, expansion) {
  if (!acronym || !expansion) return false;
  if (acronym.length < MIN_ACRONYM_LEN || acronym.length > MAX_ACRONYM_LEN) return false;
  if (expansion.length < MIN_EXPANSION_LEN || expansion.length > MAX_EXPANSION_LEN) return false;
  if (acronym.toLowerCase() === expansion.toLowerCase()) return false;
  // Soft acronym-letter match: at least HALF of the acronym's letters appear
  // in the expansion (case-insensitive, in any order). Filters out random
  // proper-noun-paren collisions like "John Smith (Director)".
  const expLower = expansion.toLowerCase();
  let hits = 0;
  for (const ch of acronym.toLowerCase()) {
    if (/[a-z0-9]/.test(ch) && expLower.includes(ch)) hits++;
  }
  return hits >= Math.ceil(acronym.length / 2);
}

function extractAcronymPairs(input) {
  const text = safeText(input);
  if (!text) return { pairs: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const pairs = [];

  for (const m of head.matchAll(EXPANSION_THEN_ACR_RE)) {
    if (pairs.length >= MAX_PAIRS_PER_FILE) break;
    const expansion = clean(m[1]);
    const acronym = clean(m[2]);
    if (!validPair(acronym, expansion)) continue;
    const key = acronym.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ acronym: key, expansion: clip(expansion, MAX_EXPANSION_LEN), form: 'expansion-first' });
  }

  for (const m of head.matchAll(ACR_THEN_EXPANSION_RE)) {
    if (pairs.length >= MAX_PAIRS_PER_FILE) break;
    const acronym = clean(m[1]);
    const expansion = clean(m[2]);
    if (!validPair(acronym, expansion)) continue;
    const key = acronym.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ acronym: key, expansion: clip(expansion, MAX_EXPANSION_LEN), form: 'acronym-first' });
  }

  // "hereinafter" / "en adelante" form. Single match per regex pass; iterate
  // by re-scanning windows when many appear.
  const hereinafterAll = new RegExp(HEREINAFTER_RE.source, HEREINAFTER_RE.flags.includes('g') ? HEREINAFTER_RE.flags : `${HEREINAFTER_RE.flags}g`);
  for (const m of head.matchAll(hereinafterAll)) {
    if (pairs.length >= MAX_PAIRS_PER_FILE) break;
    const expansion = clean(m[1]);
    const acronym = clean(m[2]);
    if (!validPair(acronym, expansion)) continue;
    const key = acronym.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ acronym: key, expansion: clip(expansion, MAX_EXPANSION_LEN), form: 'hereinafter' });
  }

  return { pairs, total: pairs.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildAcronymsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractAcronymPairs(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, pairs: r.pairs });
    aggregate = aggregate.concat(r.pairs.map((p) => ({ ...p, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderPair(p, opts = {}) {
  const file = opts.includeFile && p.file ? ` _(${p.file})_` : '';
  return `- **${p.acronym}**${file} → ${p.expansion}`;
}

function renderAcronymsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## ACRONYM EXPANSIONS
Acronyms paired with their expanded form as stated by the attached document(s). Use these mappings when the user asks "what does X stand for?" — the document's own expansion overrides any external dictionary.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const p of only.pairs) sections.push(renderPair(p));
  } else {
    sections.push('### Aggregate acronyms across all files');
    for (const p of report.aggregate) sections.push(renderPair(p, { includeFile: true }));
    for (const file of report.perFile) {
      sections.push(`\n### File: ${file.file}`);
      for (const p of file.pairs) sections.push(renderPair(p));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...acronym block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractAcronymPairs,
  buildAcronymsForFiles,
  renderAcronymsBlock,
  _internal: {
    validPair,
    clean,
    EXPANSION_THEN_ACR_RE,
    ACR_THEN_EXPANSION_RE,
    HEREINAFTER_RE,
    MAX_PAIRS_PER_FILE,
  },
};
