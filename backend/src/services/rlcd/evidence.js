'use strict';

/**
 * Evidence quality for document RLCD.
 *
 * Scores how well an answer is grounded in the extract / RAG hits
 * before defer. Fail-open. No network. Used only when
 * SIRAGPT_RLCD_DOCUMENTS is on (caller gates).
 */

const CITE_MARK_RE = /\[S\d+\]|\bp[aá]g(?:ina|\.)?\s*\d+\b|\bpage\s+\d+\b|\bseg[uú]n\s+el\s+documento\b|\ben\s+el\s+extracto\b/i;
const QUOTE_RE = /"([^"]{8,200})"|«([^»]{8,200})»/g;
const TOKEN_RE = /[a-záéíóúüñ0-9]{3,}/gi;

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
    const hitsN = hitCount(hits);
    const pool = extractPool(files, hits);
    const cov = coverageAgainst(answer, pool);
    const cited = CITE_MARK_RE.test(answer) || quotedInPool(answer, pool) > 0;
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
      quality = 0.22 + cov.coverage * 0.42 + (cited ? 0.18 : 0) + richness + hitBonus;
      if (cov.coverage >= 0.35) reasons.push('coverage');
      if (cited) reasons.push('cited');
      if (hitsN > 0) reasons.push('rag_hits');
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
  };
}

module.exports = {
  scoreEvidence,
  adjustConfidence,
  publicEvidence,
  extractPool,
  coverageAgainst,
  tokenize,
};
