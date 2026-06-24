'use strict';

/**
 * query-planner — decompose a user question into focused sub-queries so the
 * answer engine can retrieve coverage for every part (like Perplexity's "steps"
 * / ChatGPT search's query planning), then merge the evidence.
 *
 * Deterministic heuristics only (split on comparison / conjunction / multi-
 * question boundaries + synonym expansion). No model, no network.
 */

const qi = require('../agents/web-search/query-intelligence');
const { contentTokens } = require('../agents/web-search/relevance');

const COMPARISON_RE = /\b(?:vs\.?|versus|compar(?:a|ar|ación|acion|e)|diferencias?\s+entre|difference\s+between|mejor\s+que|better\s+than|o\s+mejor)\b/i;
const CONJUNCTION_SPLIT_RE = /\s+(?:y\s+tambi[eé]n|adem[aá]s|así\s+como|as\s+well\s+as)\s+/i;

function normalise(q) {
  return String(q || '').replace(/\s+/g, ' ').trim();
}

function splitComparison(q) {
  // "A vs B", "diferencia entre A y B", "A o B mejor"
  const m = q.match(/^(.*?)\s+(?:vs\.?|versus|o)\s+(.*)$/i)
    || q.match(/diferencias?\s+entre\s+(.+?)\s+y\s+(.+)/i)
    || q.match(/difference\s+between\s+(.+?)\s+and\s+(.+)/i);
  if (!m) return [];
  const a = normalise(m[1]).replace(/^(qué|que|cual|cuál|what|which)\s+es\s+/i, '');
  const b = normalise(m[2]).replace(/[?.!]+$/, '');
  const parts = [a, b].filter((p) => contentTokens(p).length > 0);
  return parts.length === 2 ? parts : [];
}

function splitMultiQuestion(q) {
  // Multiple "?"-terminated asks, or explicit "y también/además" joins.
  const byQ = q.split(/\?+/).map((s) => s.trim()).filter((s) => contentTokens(s).length > 0);
  if (byQ.length >= 2) return byQ.map((s) => (/[?]$/.test(s) ? s : `${s}?`));
  const byConj = q.split(CONJUNCTION_SPLIT_RE).map(normalise).filter((s) => contentTokens(s).length > 1);
  return byConj.length >= 2 ? byConj : [];
}

/**
 * Build a retrieval plan for a query.
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.maxSubQueries=4]
 * @param {boolean} [opts.expand=true]  add a synonym-expanded variant.
 * @returns {{ query, subQueries: string[], aspects: string[],
 *             isComparison: boolean, isMultiPart: boolean, lang: string }}
 */
function plan(query, opts = {}) {
  const q = normalise(query);
  const maxSub = Math.max(1, Math.min(Number(opts.maxSubQueries) || 4, 8));
  const expand = opts.expand !== false;
  const lang = qi.detectLanguage(q);

  const isComparison = COMPARISON_RE.test(q);
  const comparison = isComparison ? splitComparison(q) : [];
  const multi = splitMultiQuestion(q);
  const isMultiPart = multi.length >= 2;

  const subQueries = [];
  const seen = new Set();
  const push = (s) => {
    const v = normalise(s);
    const key = v.toLowerCase();
    if (v && !seen.has(key) && contentTokens(v).length > 0) {
      seen.add(key);
      subQueries.push(v);
    }
  };

  push(q); // always retrieve the original
  for (const c of comparison) push(c);
  for (const m of multi) push(m);
  // Synonym-expanded variant of the original for extra recall.
  if (expand) {
    for (const v of qi.queryVariants(q, { max: 2 })) if (v !== q) push(v);
  }

  const aspects = [...comparison, ...multi];

  return {
    query: q,
    subQueries: subQueries.slice(0, maxSub),
    aspects,
    isComparison: comparison.length === 2,
    isMultiPart,
    lang,
  };
}

module.exports = { plan, splitComparison, splitMultiQuestion };
