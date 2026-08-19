'use strict';

/**
 * document-language-ratio.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Estimates the language mix of a document via stopword-frequency heuristic.
 * Counts occurrences of high-frequency function words from English, Spanish,
 * Portuguese, French, Italian, German and computes ratios. Surfaces:
 *
 *   - Primary language (highest stopword count)
 *   - Secondary language if ≥15% of primary
 *   - Bilingual / multilingual indicator if multiple languages exceed 10%
 *
 * Different from document-titles (per-doc title language guess) by
 * computing the full mix ratio. Routes "what languages does this use?"
 * to a citeable summary.
 *
 * Public API:
 *   extractLanguageRatio(text)         → LanguageRatioReport
 *   buildLanguageRatioForFiles(files)  → { perFile, aggregate }
 *   renderLanguageRatioBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_BLOCK_CHARS = 4500;

const STOPWORDS = {
  en: ['the', 'and', 'is', 'in', 'to', 'of', 'a', 'for', 'with', 'on', 'as', 'by', 'this', 'that', 'are', 'be', 'have', 'has', 'will', 'or', 'but', 'not', 'an', 'we', 'they', 'their', 'our', 'you', 'your'],
  es: ['el', 'la', 'los', 'las', 'de', 'y', 'que', 'en', 'un', 'una', 'es', 'por', 'con', 'para', 'su', 'sus', 'no', 'se', 'al', 'del', 'lo', 'pero', 'como', 'más', 'ser', 'son', 'fue', 'esta', 'este'],
  pt: ['o', 'a', 'os', 'as', 'de', 'e', 'que', 'em', 'um', 'uma', 'é', 'por', 'com', 'para', 'seu', 'sua', 'não', 'se', 'do', 'da', 'mas', 'como', 'mais', 'ser', 'são', 'foi', 'isto', 'este'],
  fr: ['le', 'la', 'les', 'de', 'et', 'que', 'en', 'un', 'une', 'est', 'pour', 'avec', 'pas', 'son', 'sa', 'ses', 'mais', 'comme', 'plus', 'être', 'sont', 'a', 'au', 'aux', 'dans', 'sur'],
  it: ['il', 'la', 'i', 'le', 'gli', 'di', 'e', 'che', 'in', 'un', 'una', 'è', 'per', 'con', 'non', 'si', 'al', 'del', 'ma', 'come', 'più', 'essere', 'sono', 'fu', 'questo', 'questa'],
  de: ['der', 'die', 'das', 'und', 'ist', 'in', 'zu', 'ein', 'eine', 'für', 'mit', 'auf', 'als', 'von', 'sich', 'nicht', 'aber', 'wie', 'mehr', 'sein', 'sind', 'war', 'dies', 'auch', 'noch', 'oder'],
};

const LANGS = Object.keys(STOPWORDS);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function tokenize(text) {
  const lower = text.toLowerCase();
  return lower.match(/[a-záéíóúñüäöß]{2,30}/giu) || [];
}

function countStopwords(tokens) {
  const counts = {};
  for (const lang of LANGS) {
    const set = new Set(STOPWORDS[lang]);
    counts[lang] = tokens.reduce((acc, t) => acc + (set.has(t) ? 1 : 0), 0);
  }
  return counts;
}

function extractLanguageRatio(input) {
  const text = safeText(input);
  if (!text) return { ratios: {}, primary: null, secondary: null, multilingual: false, total: 0, tokens: 0 };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const tokens = tokenize(head);
  if (tokens.length < 30) {
    return { ratios: {}, primary: null, secondary: null, multilingual: false, total: 0, tokens: tokens.length };
  }
  const counts = countStopwords(tokens);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total < 10) return { ratios: {}, primary: null, secondary: null, multilingual: false, total: 0, tokens: tokens.length };
  const ratios = {};
  for (const lang of LANGS) {
    ratios[lang] = total > 0 ? Math.round((counts[lang] / total) * 100) / 100 : 0;
  }
  const sorted = LANGS.slice().sort((a, b) => ratios[b] - ratios[a]);
  const primary = sorted[0];
  const secondary = ratios[sorted[1]] >= 0.15 ? sorted[1] : null;
  const multilingual = LANGS.filter((l) => ratios[l] >= 0.1).length >= 2;
  return { ratios, primary, secondary, multilingual, total, tokens: tokens.length };
}

function buildLanguageRatioForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  for (const f of list) {
    const r = extractLanguageRatio(safeText(f.extractedText));
    if (!r.primary) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, ...r });
  }
  return { perFile };
}

function renderRatios(r) {
  return LANGS
    .filter((l) => (r.ratios[l] || 0) > 0)
    .sort((a, b) => r.ratios[b] - r.ratios[a])
    .map((l) => `${l}=${Math.round((r.ratios[l] || 0) * 100)}%`)
    .join('  ');
}

function renderEntry(e) {
  const lines = [`### File: ${e.file}`];
  lines.push(`Primary: **${e.primary}**${e.secondary ? `, secondary: ${e.secondary}` : ''}${e.multilingual ? ' (multilingual)' : ''}`);
  lines.push(`Ratios: ${renderRatios(e)}`);
  lines.push(`Tokens analysed: ${e.tokens}, stopword hits: ${e.total}`);
  return lines.join('\n');
}

function renderLanguageRatioBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## LANGUAGE MIX
Per-document language ratio computed via stopword-frequency heuristic across English / Spanish / Portuguese / French / Italian / German. Surfaces primary language, optional secondary (≥15%), and a multilingual flag when ≥2 languages exceed 10% of stopword hits. Different from per-doc title language guess by computing the full mix ratio. Routes "what languages does this use?" to a citeable summary.`;
  const sections = report.perFile.map(renderEntry);
  let combined = `${heading}\n\n${sections.join('\n\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...language mix block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractLanguageRatio,
  buildLanguageRatioForFiles,
  renderLanguageRatioBlock,
  _internal: {
    STOPWORDS,
    LANGS,
    tokenize,
    countStopwords,
  },
};
