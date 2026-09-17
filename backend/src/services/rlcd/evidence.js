'use strict';

/**
 * Evidence quality for document RLCD.
 *
 * Scores how well an answer is grounded in the extract / RAG hits
 * before defer. Phase 3 also blends retrieval scores and page
 * locators. Fail-open. No network. Used only when
 * SIRAGPT_RLCD_DOCUMENTS is on (caller gates).
 */

const CITE_MARK_RE = /\[S\d+\]|\bp[aá]g(?:ina|\.)?\s*\d+\b|\bpage\s+\d+\b|\bseg[uú]n\s+el\s+documento\b|\ben\s+el\s+extracto\b/i;
const PAGE_RE = /\b(?:p[áa]g(?:ina|\.)?|page|p)\s*[:#.-]?\s*(\d{1,4})\b/i;
const QUOTE_RE = /"([^"]{8,200})"|«([^»]{8,200})»/g;
const TOKEN_RE = /[a-záéíóúüñ0-9]{3,}/gi;
const SCORE_KEYS = Object.freeze([
  'rerankScore',
  'cohereScore',
  'relevance',
  'similarity',
  'score',
  'fusionScore',
  'vectorScore',
]);

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function extractionChars(files = []) {
  const list = Array.isArray(files) ? files : [];
  let chars = 0;
  for (const file of list) {
    if (!file || typeof file === 'string') continue;
    const text = file.extractedText || file.text || file.content || '';
    chars += String(text || '').trim().length;
  }
  return chars;
}

function tokenize(text) {
  const raw = String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const out = new Set();
  let m;
  const re = new RegExp(TOKEN_RE.source, TOKEN_RE.flags);
  while ((m = re.exec(raw)) !== null) {
    out.add(m[0]);
    if (out.size >= 400) break;
  }
  return out;
}

function extractPool(files = [], hits = []) {
  const parts = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || typeof file === 'string') continue;
    const text = file.extractedText || file.text || file.content || '';
    if (text) parts.push(String(text));
  }
  for (const hit of Array.isArray(hits) ? hits : []) {
    if (!hit) continue;
    const text = typeof hit === 'string' ? hit : (hit.text || hit.excerpt || hit.content || '');
    if (text) parts.push(String(text));
  }
  return parts.join('\n');
}

function coverageAgainst(answer, pool) {
  const answerTokens = tokenize(answer);
  if (answerTokens.size === 0) return { coverage: 0, overlap: 0, answerTokens: 0 };
  const poolTokens = tokenize(pool);
  if (poolTokens.size === 0) return { coverage: 0, overlap: 0, answerTokens: answerTokens.size };
  let overlap = 0;
  for (const t of answerTokens) {
    if (poolTokens.has(t)) overlap += 1;
  }
  return {
    coverage: round3(overlap / answerTokens.size),
    overlap,
    answerTokens: answerTokens.size,
  };
}

function quotedInPool(answer, pool) {
  const hay = String(pool || '').toLowerCase();
  if (!hay) return 0;
  let n = 0;
  const re = new RegExp(QUOTE_RE.source, QUOTE_RE.flags);
  let m;
  while ((m = re.exec(String(answer || ''))) !== null) {
    const q = String(m[1] || m[2] || '').trim().toLowerCase();
    if (q.length >= 8 && hay.includes(q)) n += 1;
    if (n >= 6) break;
  }
  return n;
}

function hitCount(hits) {
  return Array.isArray(hits) ? hits.filter(Boolean).length : 0;
}

function pageFromValue(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (Number.isInteger(n) && n > 0 && n < 10000) return n;
  const m = String(value).match(PAGE_RE);
  if (!m) return null;
  const page = Number(m[1]);
  return Number.isInteger(page) && page > 0 && page < 10000 ? page : null;
}

function pagesFromHit(hit) {
  if (hit == null) return [];
  if (typeof hit === 'string') {
    const page = pageFromValue(hit);
    return page ? [page] : [];
  }
  const meta = hit.metadata && typeof hit.metadata === 'object' ? hit.metadata : {};
  const candidates = [
    hit.page,
    hit.pageNumber,
    hit.page_label,
    hit.locator,
    meta.page,
    meta.pageNumber,
    hit.source,
    hit.title,
  ];
  const pages = [];
  for (const candidate of candidates) {
    const page = pageFromValue(candidate);
    if (page) pages.push(page);
  }
  const head = String(hit.text || hit.excerpt || hit.content || '').slice(0, 96);
  const fromText = pageFromValue(head);
  if (fromText) pages.push(fromText);
  return [...new Set(pages)];
}

function pagesFromAnswer(text) {
  const raw = String(text || '');
  const pages = [];
  const re = new RegExp(PAGE_RE.source, 'gi');
  let m;
  while ((m = re.exec(raw)) !== null) {
    const page = Number(m[1]);
    if (Number.isInteger(page) && page > 0 && page < 10000) pages.push(page);
    if (pages.length >= 8) break;
  }
  return [...new Set(pages)];
}

/**
 * Map a retrieval score onto [0, 1]. Cosine / rerank stay as-is;
 * 0–100 scales divide; tiny RRF ranks are treated as moderate presence
 * so they do not look like a failed retrieve.
 */
function normalizeRetrievalScore(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > 1 && n <= 100) return clamp01(n / 100);
  if (n > 1) return clamp01(n / (n + 1));
  return clamp01(n);
}

function bestHitScore(hit) {
  if (!hit || typeof hit === 'string') return null;
  for (const key of SCORE_KEYS) {
    if (hit[key] == null) continue;
    const normalised = normalizeRetrievalScore(hit[key]);
    if (normalised != null) return normalised;
  }
  return null;
}

/**
 * Summarise RAG / docintel hits for confidence blending.
 *
 * @returns {{
 *   hitCount: number,
 *   topScore: number|null,
 *   meanScore: number|null,
 *   weak: boolean,
 *   pages: number[],
 * }}
 */
function summarizeRetrieval(hits = []) {
  const list = Array.isArray(hits) ? hits.filter(Boolean) : [];
  const scores = [];
  const pages = [];
  for (const hit of list) {
    const score = bestHitScore(hit);
    if (score != null) scores.push(score);
    pages.push(...pagesFromHit(hit));
  }
  const topScore = scores.length ? Math.max(...scores) : null;
  const meanScore = scores.length
    ? round3(scores.reduce((sum, n) => sum + n, 0) / scores.length)
    : null;
  return {
    hitCount: list.length,
    topScore: topScore == null ? null : round3(topScore),
    meanScore,
    weak: list.length > 0 && topScore != null && topScore < 0.28,
    pages: [...new Set(pages)].slice(0, 8),
  };
}

/**
 * Score evidence quality in [0, 1].
 *
 * @returns {{
 *   quality: number,
 *   cited: boolean,
 *   coverage: number,
 *   extractChars: number,
 *   hitCount: number,
 *   emptyExtract: boolean,
 *   thinExtract: boolean,
 *   reasons: string[],
 * }}
 */
function scoreEvidence({ text, files, hits } = {}) {
  try {
    const answer = String(text || '');
    const chars = extractionChars(files);
    const retrieval = summarizeRetrieval(hits);
    const hitsN = retrieval.hitCount || hitCount(hits);
    const pool = extractPool(files, hits);
    const cov = coverageAgainst(answer, pool);
    const citedPages = pagesFromAnswer(answer);
    const pageCited = retrieval.pages.some((page) => citedPages.includes(page));
    const cited = CITE_MARK_RE.test(answer) || quotedInPool(answer, pool) > 0 || pageCited;
    const emptyExtract = chars === 0 && hitsN === 0;
    const thinExtract = !emptyExtract && chars > 0 && chars < 400 && hitsN === 0;
    const reasons = [];

    let quality;
    if (emptyExtract) {
      quality = 0.12;
      reasons.push('empty_extract');
    } else if (thinExtract && cov.coverage < 0.15) {
      quality = 0.28;
      reasons.push('thin_extract');
    } else {
      const richness = Math.min(0.28, (chars / 2000) * 0.28);
      const hitBonus = Math.min(0.14, hitsN * 0.04);
      const retrievalBonus = retrieval.topScore != null ? retrieval.topScore * 0.16 : 0;
      quality = 0.22 + cov.coverage * 0.42 + (cited ? 0.18 : 0) + richness + hitBonus + retrievalBonus;
      if (pageCited) quality += 0.06;
      if (retrieval.weak && cov.coverage < 0.2) {
        quality = Math.min(quality, 0.32);
        reasons.push('weak_retrieval');
      }
      if (cov.coverage >= 0.35) reasons.push('coverage');
      if (cited) reasons.push('cited');
      if (pageCited) reasons.push('page_cited');
      if (hitsN > 0) reasons.push('rag_hits');
      if (retrieval.topScore != null && retrieval.topScore >= 0.6) reasons.push('strong_retrieval');
      if (chars < 400) reasons.push('short_extract');
    }

    const clamped = clamp01(quality);
    return {
      quality: round3(clamped == null ? 0.4 : clamped),
      cited,
      coverage: cov.coverage,
      extractChars: chars,
      hitCount: hitsN,
      emptyExtract,
      thinExtract,
      retrievalScore: retrieval.topScore,
      meanRetrievalScore: retrieval.meanScore,
      weakRetrieval: retrieval.weak === true,
      pages: retrieval.pages,
      citedPages,
      pageCited,
      reasons,
    };
  } catch {
    return {
      quality: 0.4,
      cited: false,
      coverage: 0,
      extractChars: 0,
      hitCount: 0,
      emptyExtract: false,
      thinExtract: false,
      retrievalScore: null,
      meanRetrievalScore: null,
      weakRetrieval: false,
      pages: [],
      citedPages: [],
      pageCited: false,
      reasons: ['fail_open'],
    };
  }
}

/**
 * Blend a stated confidence with evidence. Weak evidence pulls down;
 * strong cited evidence may nudge a structured trailer up slightly.
 * Never raises a verbalized low hedge.
 */
function adjustConfidence({ stated, source, evidence } = {}) {
  const raw = clamp01(stated);
  if (raw == null) return { confidence: 0.5, adjusted: false, raw: 0.5 };
  const ev = evidence && typeof evidence === 'object' ? evidence : {};
  let next = raw;
  const quality = clamp01(ev.quality);

  if (ev.emptyExtract) {
    next = Math.min(next, 0.28);
  } else if (quality != null && quality < 0.35) {
    next = Math.min(next, round3(0.5 * raw + 0.5 * quality));
  } else if (ev.weakRetrieval && (ev.coverage == null || ev.coverage < 0.2)) {
    next = Math.min(next, round3(0.55 * raw + 0.2));
  }

  if (
    source === 'structured'
    && ev.cited
    && quality != null
    && quality >= 0.75
    && raw < 0.9
    && raw >= 0.45
  ) {
    next = Math.min(1, round3(raw + 0.05));
  }

  if (source === 'verbalized' && raw < 0.45) {
    next = Math.min(next, raw);
  }

  const rounded = Math.round(next * 100) / 100;
  const rawRounded = Math.round(raw * 100) / 100;
  return {
    confidence: rounded,
    raw: rawRounded,
    adjusted: Math.abs(rounded - rawRounded) >= 0.02,
  };
}

function publicEvidence(evidence) {
  if (!evidence) return undefined;
  return {
    quality: evidence.quality,
    cited: evidence.cited === true,
    coverage: evidence.coverage,
    extractChars: evidence.extractChars,
    hitCount: evidence.hitCount,
    emptyExtract: evidence.emptyExtract === true,
    retrievalScore: evidence.retrievalScore == null ? undefined : evidence.retrievalScore,
    weakRetrieval: evidence.weakRetrieval === true ? true : undefined,
    pages: Array.isArray(evidence.pages) && evidence.pages.length ? evidence.pages.slice(0, 6) : undefined,
    pageCited: evidence.pageCited === true ? true : undefined,
  };
}

module.exports = {
  scoreEvidence,
  adjustConfidence,
  publicEvidence,
  extractPool,
  coverageAgainst,
  tokenize,
  summarizeRetrieval,
  pagesFromHit,
  pagesFromAnswer,
  bestHitScore,
  normalizeRetrievalScore,
};
