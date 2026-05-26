'use strict';

/**
 * document-glossary-extractor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Builds a domain glossary from the attached documents so the model encounters
 * the document's vocabulary BEFORE generating an answer. Three sources fuel
 * the glossary:
 *
 *  1. Acronyms with explicit expansions ("CFO (Chief Financial Officer)").
 *  2. Capitalised noun phrases that recur across the corpus (proper terms).
 *  3. High-frequency content words that are NOT generic stopwords —
 *     the "domain jargon" of the document.
 *
 * Why this exists: when the model sees "Adjust the AVR for the EBITDA bridge"
 * out of context it will paraphrase or invent. With an upfront glossary —
 * "AVR = Asset Value Reconciliation (defined p.4); EBITDA = Earnings Before
 * Interest, Taxes, Depreciation, and Amortization" — the answer references
 * the actual concept the document defines.
 *
 * Public API:
 *   extractGlossary(text, opts) → GlossaryReport
 *   buildGlossaryForFiles(files) → GlossaryReport (aggregated)
 *   renderGlossaryBlock(report)  → markdown string
 *
 * Constraints: pure function, sync, no LLM, no network. <20 ms for 1 MB text.
 */

const MAX_ACRONYMS = 30;
const MAX_PROPER_TERMS = 25;
const MAX_JARGON = 25;
const MAX_FREQ_TABLE_TERMS = 40;
const SCAN_HEAD_BYTES = 60_000;

// Stopwords for ES + EN — the union of the most common function words. Kept
// long enough to stop noise from dominating the jargon list, short enough
// to leave domain words untouched. Keys are lowercase.
const STOPWORDS = new Set([
  // Spanish
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'al', 'a', 'que', 'y', 'o', 'u', 'e', 'en', 'por', 'para', 'con', 'sin', 'sobre', 'entre', 'hasta', 'desde', 'es', 'son', 'fue', 'ser', 'esta', 'este', 'estas', 'estos', 'eso', 'esa', 'eso', 'aquel', 'aquella', 'como', 'pero', 'porque', 'cuando', 'donde', 'también', 'mas', 'más', 'muy', 'ya', 'no', 'sí', 'lo', 'le', 'les', 'me', 'te', 'se', 'nos', 'mi', 'tu', 'su', 'sus', 'mis', 'tus', 'cada', 'algún', 'alguna', 'algo', 'todo', 'toda', 'todos', 'todas', 'cual', 'cuales', 'quien', 'quienes', 'sólo', 'solo', 'segun', 'según', 'tras', 'ante', 'fin', 'tan', 'tanto', 'puede', 'pueden', 'puedo', 'tener', 'tiene', 'tienen', 'haber', 'hay', 'sino', 'aún', 'aunque',
  // English
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their', 'we', 'us', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'i', 'me', 'my', 'so', 'if', 'then', 'than', 'when', 'while', 'where', 'who', 'whom', 'which', 'what', 'how', 'why', 'not', 'no', 'all', 'any', 'each', 'some', 'more', 'most', 'other', 'such', 'only', 'also', 'about', 'into', 'over', 'after', 'before', 'between', 'through', 'during', 'against', 'because', 'though', 'although', 'however', 'therefore', 'thus', 'just', 'very', 'much', 'many', 'few', 'one', 'two', 'three', 'four', 'five',
  // Generic verbs that show up everywhere
  'use', 'used', 'using', 'make', 'made', 'making', 'see', 'seen', 'saw', 'get', 'got', 'getting', 'go', 'goes', 'went', 'going', 'know', 'knew', 'known', 'think', 'thought', 'say', 'said',
  // Common doc connectors
  'page', 'section', 'chapter', 'figure', 'table', 'document', 'documento', 'archivo', 'capítulo', 'sección', 'figura', 'tabla', 'apartado',
]);

function safeText(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Find acronym definitions of the form ACRO (Full Name) or "Full Name (ACRO)".
 * Both forms are common in academic / business writing. Acronyms must be 2-8
 * uppercase letters, possibly with digits (e.g. "S3", "ISO27001").
 */
function extractAcronyms(text) {
  const found = new Map(); // acronym -> { acronym, expansion }
  // Pattern A: "Full Capitalised Name (ACRO)"
  const patternA = /\b((?:[A-ZÁÉÍÓÚÑ][\w&-]*\s+){1,6})\(([A-Z]{2,8}\d?)\)/g;
  let m;
  while ((m = patternA.exec(text)) !== null) {
    const expansion = m[1].trim();
    const acro = m[2].trim();
    if (!found.has(acro)) found.set(acro, { acronym: acro, expansion });
  }
  // Pattern B: "ACRO (Full Capitalised Name)"
  const patternB = /\b([A-Z]{2,8}\d?)\s*\(\s*([^)]{4,80})\)/g;
  while ((m = patternB.exec(text)) !== null) {
    const acro = m[1].trim();
    const expansion = m[2].trim();
    // Quick sanity check: expansion's leading word should start uppercase
    if (!/^[A-ZÁÉÍÓÚÑ]/.test(expansion)) continue;
    if (!found.has(acro)) found.set(acro, { acronym: acro, expansion });
  }
  // Pattern C: dictionary-style "ACRO: Full Name" (one per line)
  const patternC = /^\s*([A-Z]{2,8}\d?)\s*[:=]\s*([A-ZÁÉÍÓÚÑ][^\n.;]{4,90})/gm;
  while ((m = patternC.exec(text)) !== null) {
    const acro = m[1].trim();
    const expansion = m[2].trim();
    if (!found.has(acro)) found.set(acro, { acronym: acro, expansion });
  }
  return Array.from(found.values()).slice(0, MAX_ACRONYMS);
}

/**
 * Capitalised noun phrases of 2–4 words (Title Case) that recur ≥2 times.
 * Treats them as proper terminology / named concepts.
 */
function extractProperTerms(text) {
  const counts = new Map();
  const pattern = /\b((?:[A-ZÁÉÍÓÚÑ][\wáéíóúñ-]*)(?:\s+(?:of|de|del|la|el|the|and)\s+|\s+)(?:[A-ZÁÉÍÓÚÑ][\wáéíóúñ-]*)(?:(?:\s+(?:of|de|del|la|el|the|and)\s+|\s+)[A-ZÁÉÍÓÚÑ][\wáéíóúñ-]*){0,2})\b/g;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    const phrase = m[1].trim().replace(/\s+/g, ' ');
    if (phrase.length < 6) continue;
    // Skip if the phrase is entirely uppercase (treat as acronym, handled elsewhere)
    if (phrase === phrase.toUpperCase()) continue;
    counts.set(phrase, (counts.get(phrase) || 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PROPER_TERMS)
    .map(([phrase, count]) => ({ phrase, count }));
}

/**
 * High-frequency lowercase content words (jargon). Excludes stopwords,
 * very short tokens, and pure numbers. Returns words appearing ≥3 times.
 */
function extractJargon(text) {
  const tokens = (text.toLowerCase().match(/[\p{L}][\p{L}\p{N}-]{3,}/gu) || []);
  const counts = new Map();
  for (const t of tokens) {
    if (STOPWORDS.has(t)) continue;
    if (/^\d/.test(t)) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_JARGON)
    .map(([term, count]) => ({ term, count }));
}

function extractGlossary(text) {
  const safe = safeText(text);
  if (!safe.trim()) {
    return { acronyms: [], properTerms: [], jargon: [], frequencyTable: [] };
  }
  const head = safe.slice(0, SCAN_HEAD_BYTES);
  const acronyms = extractAcronyms(head);
  const properTerms = extractProperTerms(head);
  const jargon = extractJargon(safe); // jargon scans full text

  // Build a slim "frequency table" combining proper terms + jargon for
  // downstream consumers (RAG re-ranking, cross-doc comparison).
  const frequencyTable = [
    ...properTerms.map((p) => ({ term: p.phrase, count: p.count, kind: 'proper' })),
    ...jargon.map((j) => ({ term: j.term, count: j.count, kind: 'jargon' })),
  ].sort((a, b) => b.count - a.count).slice(0, MAX_FREQ_TABLE_TERMS);

  return { acronyms, properTerms, jargon, frequencyTable };
}

/**
 * Aggregate glossary across multiple files. Acronyms get deduplicated by
 * acronym (first definition wins). Proper terms / jargon merge by summing
 * frequencies across the corpus.
 */
function buildGlossaryForFiles(files) {
  const list = Array.isArray(files) ? files : [];
  const acroMap = new Map();
  const properCounts = new Map();
  const jargonCounts = new Map();
  let any = false;
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const text = safeText(f.extractedText || f.text || '');
    if (!text.trim()) continue;
    any = true;
    const g = extractGlossary(text);
    for (const a of g.acronyms) {
      if (!acroMap.has(a.acronym)) acroMap.set(a.acronym, a);
    }
    for (const p of g.properTerms) {
      properCounts.set(p.phrase, (properCounts.get(p.phrase) || 0) + p.count);
    }
    for (const j of g.jargon) {
      jargonCounts.set(j.term, (jargonCounts.get(j.term) || 0) + j.count);
    }
  }
  if (!any) {
    return { acronyms: [], properTerms: [], jargon: [], frequencyTable: [] };
  }
  const properTerms = Array.from(properCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PROPER_TERMS)
    .map(([phrase, count]) => ({ phrase, count }));
  const jargon = Array.from(jargonCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_JARGON)
    .map(([term, count]) => ({ term, count }));
  const frequencyTable = [
    ...properTerms.map((p) => ({ term: p.phrase, count: p.count, kind: 'proper' })),
    ...jargon.map((j) => ({ term: j.term, count: j.count, kind: 'jargon' })),
  ].sort((a, b) => b.count - a.count).slice(0, MAX_FREQ_TABLE_TERMS);

  return {
    acronyms: Array.from(acroMap.values()).slice(0, MAX_ACRONYMS),
    properTerms,
    jargon,
    frequencyTable,
  };
}

function renderGlossaryBlock(report, opts = {}) {
  if (!report) return '';
  const hasAny = (report.acronyms?.length || 0) + (report.properTerms?.length || 0) + (report.jargon?.length || 0) > 0;
  if (!hasAny) return '';
  const title = opts.title || 'DOCUMENT GLOSSARY';
  const lines = [];
  lines.push(`## ${title}`);
  lines.push('Treat the following terms as the document\'s authoritative vocabulary. Use the exact form (preserve casing and definitions). When the user asks about an acronym, expand it once on first use.');

  if (report.acronyms.length > 0) {
    lines.push('### Acronyms');
    for (const a of report.acronyms) {
      lines.push(`- **${a.acronym}** — ${a.expansion}`);
    }
  }
  if (report.properTerms.length > 0) {
    lines.push('### Proper terms (recurring named concepts)');
    lines.push(report.properTerms.slice(0, 12).map((p) => `- ${p.phrase} (×${p.count})`).join('\n'));
  }
  if (report.jargon.length > 0) {
    lines.push('### Domain jargon (high-frequency content words)');
    lines.push(report.jargon.slice(0, 12).map((j) => `- ${j.term} (×${j.count})`).join('\n'));
  }
  return lines.join('\n\n');
}

module.exports = {
  extractGlossary,
  buildGlossaryForFiles,
  renderGlossaryBlock,
  _internal: { extractAcronyms, extractProperTerms, extractJargon, STOPWORDS },
};
