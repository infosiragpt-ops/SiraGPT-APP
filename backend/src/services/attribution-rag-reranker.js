'use strict';

const conceptExtractor = require('./concept-extractor');
const conceptSim = require('./concept-similarity');

const DEFAULT_ATTRIBUTION_WEIGHT = 0.4;
const DEFAULT_MAX_RESULTS = 16;

function safeText(v) { return String(v == null ? '' : v).slice(0, 6000); }
function tokenize(text) {
  return safeText(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9_]+/g, ' ').split(/\s+/).filter((t) => t.length >= 3);
}
function snippetText(s) { if (!s) return ''; if (typeof s === 'string') return s; return safeText(s.text || s.content || s.snippet || s.summary || ''); }
function baseScore(s) {
  if (!s || typeof s !== 'object') return 0.5;
  const candidates = [s.score, s.relevance, s.rerankScore, s.similarity];
  for (const c of candidates) if (Number.isFinite(c)) return Math.max(0, Math.min(1, Number(c)));
  return 0.5;
}

function rerank({ prompt = '', snippets = [], beliefs = [], entities = [], weight = DEFAULT_ATTRIBUTION_WEIGHT, max = DEFAULT_MAX_RESULTS } = {}) {
  if (!Array.isArray(snippets) || !snippets.length) return [];
  const w = Math.max(0, Math.min(1, Number(weight) || DEFAULT_ATTRIBUTION_WEIGHT));
  const { concepts } = conceptExtractor.extractConcepts(prompt);
  const conceptSurfaces = new Set(concepts.map((c) => (c.normalized || c.surface || '').toLowerCase()).filter(Boolean));
  const conceptCanonicals = new Set(concepts.map((c) => conceptSim.canonical(c)).filter(Boolean));
  const entityTokens = new Set((Array.isArray(entities) ? entities : []).flatMap((e) => tokenize(typeof e === 'string' ? e : e?.canonical || e?.surface || '')).filter(Boolean));
  const beliefTokens = new Set((Array.isArray(beliefs) ? beliefs : []).flatMap((b) => tokenize(typeof b === 'string' ? b : b?.subject || '')).filter(Boolean));
  const scored = snippets.map((s, idx) => {
    const tokens = tokenize(snippetText(s));
    const tokenSet = new Set(tokens);
    let conceptHits = 0;
    for (const c of conceptSurfaces) if (tokenSet.has(c)) conceptHits++;
    for (const c of conceptCanonicals) if (tokenSet.has(c)) conceptHits++;
    let entityHits = 0;
    for (const t of entityTokens) if (tokenSet.has(t)) entityHits++;
    let beliefHits = 0;
    for (const t of beliefTokens) if (tokenSet.has(t)) beliefHits++;
    const conceptDenom = Math.max(1, conceptSurfaces.size + conceptCanonicals.size);
    const entityDenom = Math.max(1, entityTokens.size);
    const beliefDenom = Math.max(1, beliefTokens.size);
    const attributionScore = 0.6 * (conceptHits / conceptDenom) + 0.3 * (entityHits / entityDenom) + 0.1 * (beliefHits / beliefDenom);
    const base = baseScore(s);
    const combined = (1 - w) * base + w * Math.min(1, attributionScore);
    return { original: s, originalIndex: idx, baseScore: Number(base.toFixed(3)), attributionScore: Number(attributionScore.toFixed(3)), combinedScore: Number(combined.toFixed(3)), hits: { concepts: conceptHits, entities: entityHits, beliefs: beliefHits } };
  });
  scored.sort((a, b) => { if (b.combinedScore !== a.combinedScore) return b.combinedScore - a.combinedScore; return a.originalIndex - b.originalIndex; });
  return scored.slice(0, Math.max(1, Math.min(200, Number(max) || DEFAULT_MAX_RESULTS)));
}

function buildRerankBlock(ranked, opts = {}) {
  if (!ranked || !ranked.length) return '';
  const cap = Math.max(1, Number(opts.max) || 6);
  const lines = ['## RAG REORDER NOTE', 'Top snippets re-ranked by attribution overlap. Use them preferentially:'];
  for (const r of ranked.slice(0, cap)) {
    const preview = snippetText(r.original).slice(0, 140);
    lines.push(`- [combined=${r.combinedScore} base=${r.baseScore} attr=${r.attributionScore}] ${preview}`);
  }
  return lines.join('\n');
}

module.exports = { rerank, buildRerankBlock, DEFAULT_ATTRIBUTION_WEIGHT, DEFAULT_MAX_RESULTS };
