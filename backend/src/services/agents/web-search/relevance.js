'use strict';

/**
 * relevance.js — query↔result relevance scoring, ranking, dedupe and
 * diversity for the web-search adapter's aggregating path (`searchMany`).
 *
 * Two-stage design
 * ----------------
 *  1. FILTER  — a bounded [0,1] overlap score (`scoreResult`) decides whether
 *     a result is relevant enough to keep at all. This is stable and cheap and
 *     is what kills the "¿qué día es hoy?" → random DOI papers bug: a casual,
 *     content-free prompt yields no query tokens, so every candidate scores 0
 *     and is dropped.
 *  2. RANK    — survivors are ordered by an IDF-weighted BM25-lite score with
 *     a title-field boost and a source-authority multiplier (.gov/.edu/peer-
 *     reviewed domains float up). Optional per-domain diversity caps stop a
 *     single site from dominating the list.
 *
 * Pure, deterministic, zero-deps (token-overlap + BM25, no embeddings/LLM) so
 * it ranks hundreds of candidates in well under a millisecond.
 */

const { classifySource } = require('../../search/source-confidence');

// Words that carry no discriminating signal: removing them prevents a single
// common word from "matching" an unrelated document. Spanish + English.
const STOPWORDS = new Set([
  // ── Spanish ──
  'de', 'la', 'el', 'que', 'en', 'y', 'a', 'los', 'las', 'un', 'una', 'unos',
  'unas', 'del', 'al', 'se', 'su', 'sus', 'lo', 'le', 'les', 'es', 'son',
  'era', 'fue', 'ser', 'por', 'con', 'para', 'como', 'pero', 'mas', 'o', 'u',
  'si', 'no', 'ya', 'me', 'mi', 'te', 'tu', 'nos', 'este', 'esta', 'esto',
  'estos', 'estas', 'ese', 'esa', 'eso', 'esos', 'esas', 'cual', 'cuales',
  'cuál', 'cuáles', 'donde', 'dónde', 'cuando', 'cuándo', 'quien', 'quién',
  'sobre', 'entre', 'hasta', 'desde', 'muy', 'tan', 'también', 'tambien',
  'porque', 'qué', 'cómo', 'como', 'dime', 'dame', 'quiero', 'puedes',
  'necesito', 'hacer', 'tiene', 'tienen', 'hay', 'va', 'van', 'ha', 'han',
  // ── English ──
  'the', 'an', 'of', 'to', 'in', 'on', 'and', 'or', 'is', 'are', 'was',
  'were', 'be', 'been', 'for', 'with', 'as', 'at', 'by', 'it', 'this',
  'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'how', 'when',
  'where', 'why', 'do', 'does', 'did', 'can', 'could', 'will', 'would',
  'should', 'i', 'you', 'he', 'she', 'we', 'they', 'my', 'your', 'me',
  'about', 'into', 'than', 'then', 'there', 'here', 'tell', 'give', 'want',
  'need', 'please', 'make',
]);

// Temporal / freshness words appear in a huge fraction of documents, so they
// are non-discriminating for relevance even though they (correctly) trigger a
// fresh-web lookup. Treat them like stopwords for SCORING purposes so e.g.
// "hoy"/"today" in a result title doesn't fake a match for "¿qué día es hoy?".
const NON_DISCRIMINATING = new Set([
  'hoy', 'ayer', 'manana', 'mañana', 'ahora', 'actual', 'actualmente',
  'actuales', 'ultimo', 'ultima', 'ultimos', 'ultimas', 'último', 'última',
  'últimos', 'últimas', 'reciente', 'recientes', 'recientemente',
  'dia', 'día', 'dias', 'días', 'fecha', 'fechas', 'hora', 'horas',
  'today', 'yesterday', 'tomorrow', 'now', 'current', 'currently', 'latest',
  'recent', 'recently', 'new', 'newest', 'day', 'days', 'date', 'dates',
  'time', 'times',
]);

// Hosts where many distinct results legitimately share one host (each path is
// a different paper / question / repo), so per-domain diversity caps must NOT
// collapse them. Registrable-domain matched (sub-domains included).
const DIVERSITY_EXEMPT_DOMAINS = new Set([
  'doi.org', 'arxiv.org', 'ncbi.nlm.nih.gov', 'pubmed.ncbi.nlm.nih.gov',
  'wikipedia.org', 'github.com', 'stackoverflow.com', 'stackexchange.com',
  'semanticscholar.org', 'researchgate.net', 'scielo.org', 'openalex.org',
]);

const AUTHORITY_BOOST = { verified: 1.6, unverified: 1.0, inferred: 0.85 };

// BM25 tunables.
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const TITLE_FIELD_BOOST = 2.4; // title term occurrences count this much more.

/**
 * Lowercase, strip diacritics (día→dia, investigación→investigacion) and
 * split into bare alphanumeric tokens. Keeps the matcher accent-insensitive.
 */
function rawTokens(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // drop combining accents
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

/**
 * The discriminating content tokens of a string: raw tokens minus stopwords,
 * minus temporal/common words, minus 1-char noise. Numbers >= 4 digits (years,
 * counts) are kept since they can be meaningful ("2026", "5g").
 */
function contentTokens(text) {
  const out = [];
  const seen = new Set();
  for (const t of rawTokens(text)) {
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    if (NON_DISCRIMINATING.has(t)) continue;
    if (/^\d{1,3}$/.test(t)) continue; // tiny bare numbers are noise
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Bounded relevance score in [0,1] — the FILTER signal. 0 means "no
 * discriminating overlap" (drop it).
 *
 * Weighting:
 *   - coverage   : fraction of distinct query tokens present anywhere in the
 *                  result (title + snippet + domain).             (0.60)
 *   - titleHit   : fraction of query tokens present in the TITLE — a much
 *                  stronger signal than the snippet.              (0.40)
 *   - phraseBonus: additive bonus when the query's content words appear as a
 *                  contiguous phrase in the title/snippet.        (+0.15)
 */
function scoreResult(queryTokensArg, result) {
  const queryTokens = Array.isArray(queryTokensArg)
    ? queryTokensArg
    : contentTokens(queryTokensArg);
  if (queryTokens.length === 0) return 0;

  const title = String(result?.title || '');
  const snippet = String(result?.snippet || result?.content || '');
  const domain = String(result?.domain || result?.url || '');

  const titleSet = new Set(rawTokens(title));
  const bodySet = new Set([
    ...rawTokens(title),
    ...rawTokens(snippet),
    ...rawTokens(domain),
  ]);

  let anyHits = 0;
  let titleHits = 0;
  for (const qt of queryTokens) {
    if (bodySet.has(qt)) anyHits += 1;
    if (titleSet.has(qt)) titleHits += 1;
  }
  if (anyHits === 0) return 0;

  const coverage = anyHits / queryTokens.length;
  const titleCoverage = titleHits / queryTokens.length;
  let score = coverage * 0.6 + titleCoverage * 0.4;

  if (queryTokens.length >= 2) {
    const phrase = queryTokens.join(' ');
    const hay = `${title} ${snippet}`
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    if (hay.includes(phrase)) score += 0.15;
  }

  return score > 1 ? 1 : score;
}

/**
 * Stable key for de-duplication: prefer a normalised URL (host+path without
 * query/hash/trailing slash); fall back to host+title.
 */
function dedupeKey(result) {
  const url = String(result?.url || '');
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const path = u.pathname.replace(/\/+$/, '').toLowerCase();
    return `${host}${path}`;
  } catch {
    const title = String(result?.title || '').toLowerCase().trim();
    return `title:${title}`;
  }
}

/** Registrable-ish domain (last two labels) for diversity bucketing. */
function registrableDomain(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    // Handle common 2-label public suffixes (co.uk, com.mx, gob.ar, ac.uk…).
    const twoLabelSuffix = /^(co|com|gob|gov|org|net|edu|ac)\.[a-z]{2}$/;
    const lastTwo = parts.slice(-2).join('.');
    if (twoLabelSuffix.test(lastTwo)) return parts.slice(-3).join('.');
    return lastTwo;
  } catch {
    return '';
  }
}

/** BM25-lite term-frequency map for a doc, with the title field up-weighted. */
function buildDocStats(result) {
  const titleToks = rawTokens(result?.title);
  const bodyToks = rawTokens(`${result?.snippet || result?.content || ''} ${result?.domain || ''}`);
  const tf = new Map();
  for (const t of titleToks) tf.set(t, (tf.get(t) || 0) + TITLE_FIELD_BOOST);
  for (const t of bodyToks) tf.set(t, (tf.get(t) || 0) + 1);
  // Effective length uses the boosted counts so long titles don't game it.
  let len = 0;
  for (const v of tf.values()) len += v;
  return { tf, len: len || 1 };
}

function freshnessBoost(result) {
  const hay = `${result?.title || ''} ${result?.snippet || result?.content || ''}`;
  const m = hay.match(/\b(20[2-9]\d)\b/);
  if (!m) return 1;
  const year = Number(m[1]);
  const now = new Date().getFullYear();
  if (year >= now) return 1.12;
  if (year >= now - 1) return 1.08;
  if (year >= now - 3) return 1.03;
  return 1;
}

/**
 * Merge + dedupe + relevance-rank + filter a flat list of provider results.
 *
 * Ranking: IDF-weighted BM25-lite (title-boosted) × source-authority ×
 * freshness. Filtering: bounded `scoreResult` ≥ minScore.
 *
 * @param {string} query
 * @param {Array<{title,url,snippet,source,domain?}>} results
 * @param {object} [opts]
 * @param {number} [opts.minScore=0.3]  drop results below this relevance.
 * @param {number} [opts.limit=30]      cap the returned list.
 * @param {number} [opts.perDomain]     max results per registrable domain
 *                                       (aggregator hosts are exempt). Omit
 *                                       for no diversity cap.
 * @param {boolean} [opts.authority=true] apply the source-authority multiplier.
 * @returns {Array} ranked, de-duplicated, filtered results, each annotated
 *                  with `_score` (filter score) and `_rank` (rank score).
 */
function rankAndFilter(query, results, opts = {}) {
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0.3;
  const limit = Math.max(1, Math.min(Number(opts.limit) || 30, 1000));
  const useAuthority = opts.authority !== false;
  const perDomain = Number.isFinite(opts.perDomain) && opts.perDomain > 0
    ? Math.floor(opts.perDomain) : Infinity;
  const queryTokens = contentTokens(query);

  // A query with no discriminating content tokens (e.g. "¿qué día es hoy?")
  // can't be meaningfully matched — return nothing rather than noise.
  if (queryTokens.length === 0) return [];

  const list = Array.isArray(results) ? results : [];

  // ── Stage 1: filter + dedupe (keep the better filter-score on collision) ──
  const byKey = new Map();
  for (const r of list) {
    if (!r || typeof r.url !== 'string' || !r.url) continue;
    const filterScore = scoreResult(queryTokens, r);
    if (filterScore < minScore) continue;
    const key = dedupeKey(r);
    const prev = byKey.get(key);
    if (!prev || filterScore > prev._score) {
      byKey.set(key, { ...r, _score: filterScore });
    }
  }
  const survivors = Array.from(byKey.values());
  if (survivors.length === 0) return [];

  // ── Stage 2: corpus stats for IDF, then BM25-lite rank score ──
  const N = survivors.length;
  const stats = survivors.map(buildDocStats);
  const avgdl = stats.reduce((s, d) => s + d.len, 0) / N || 1;
  const df = new Map();
  for (const qt of queryTokens) {
    let c = 0;
    for (const d of stats) if (d.tf.has(qt)) c += 1;
    df.set(qt, c);
  }
  const idf = new Map();
  for (const qt of queryTokens) {
    const dfi = df.get(qt) || 0;
    // BM25 idf with +1 floor so a term present in every doc still counts a bit.
    idf.set(qt, Math.log(1 + (N - dfi + 0.5) / (dfi + 0.5)) + 0.05);
  }

  for (let i = 0; i < survivors.length; i++) {
    const d = stats[i];
    let bm25 = 0;
    for (const qt of queryTokens) {
      const f = d.tf.get(qt) || 0;
      if (f === 0) continue;
      const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (d.len / avgdl));
      bm25 += (idf.get(qt) || 0) * (f * (BM25_K1 + 1)) / denom;
    }
    let rank = bm25;
    if (useAuthority) {
      const cls = classifySource({ url: survivors[i].url });
      rank *= AUTHORITY_BOOST[cls.confidence] || 1;
    }
    rank *= freshnessBoost(survivors[i]);
    survivors[i]._rank = rank;
  }

  survivors.sort((a, b) => (b._rank - a._rank) || (b._score - a._score));

  // ── Stage 3: optional per-domain diversity cap ──
  if (perDomain !== Infinity) {
    const perDomainCount = new Map();
    const diversified = [];
    for (const r of survivors) {
      const reg = registrableDomain(r.url);
      if (reg && !DIVERSITY_EXEMPT_DOMAINS.has(reg)) {
        const n = perDomainCount.get(reg) || 0;
        if (n >= perDomain) continue;
        perDomainCount.set(reg, n + 1);
      }
      diversified.push(r);
      if (diversified.length >= limit) break;
    }
    return diversified;
  }

  return survivors.slice(0, limit);
}

module.exports = {
  rawTokens,
  contentTokens,
  scoreResult,
  dedupeKey,
  registrableDomain,
  rankAndFilter,
  STOPWORDS,
  NON_DISCRIMINATING,
  DIVERSITY_EXEMPT_DOMAINS,
  AUTHORITY_BOOST,
};
