'use strict';

/**
 * Structured + verbalized confidence for document-analysis answers.
 *
 * Preferred signal: a hidden trailer the model is asked to emit
 *   <!--rlcd:{"c":0.72,"r":"evidencia parcial"}-->
 * Fallback: Spanish/English hedge lexicon + extraction thinness +
 * the pre-turn posture from confidence-calibration.js.
 *
 * The trailer is stripped from user-visible text. Rationale is
 * truncated and PII-scrubbed before it is stored.
 */

const TRAILER_RE = /<!--\s*rlcd\s*:\s*(\{[\s\S]*?\})\s*-->/i;
const JSON_LINE_RE = /^\s*\{[\s\S]*"rlcd"[\s\S]*\}\s*$/m;

const HIGH_VERBAL = /\b(?:confianza\s+alta|estoy\s+seguro|con\s+certeza|high\s+confidence|i'?m\s+certain|definitely)\b/i;
const MED_VERBAL = /\b(?:confianza\s+media|creo\s+que|parece\s+que|medium\s+confidence|it\s+seems|likely)\b/i;
const LOW_VERBAL = /\b(?:confianza\s+baja|no\s+estoy\s+seguro|no\s+puedo\s+afirmar|no\s+aparece|extracto\s+incompleto|no\s+tengo\s+evidencia|low\s+confidence|i'?m\s+not\s+sure|cannot\s+confirm|missing\s+from\s+the\s+(?:extract|document))\b/i;
const HEDGE_RE = /\b(?:quiz[aá]s|tal\s+vez|podr[ií]a|posiblemente|apparently|perhaps|maybe|might)\b/i;

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function binFor(confidence) {
  if (confidence == null) return 'unknown';
  if (confidence >= 0.7) return 'high';
  if (confidence >= 0.45) return 'medium';
  return 'low';
}

function scrubRationale(raw, { scrub } = {}) {
  let text = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!text) return '';
  if (typeof scrub === 'function') {
    try { text = String(scrub(text) || text).slice(0, 160); } catch { /* keep raw slice */ }
  } else {
    text = text
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<EMAIL>')
      .replace(/\b(?:sk-|Bearer\s+|AKIA)[A-Za-z0-9._-]{8,}/g, '<REDACTED>');
  }
  return text;
}

function parseTrailer(text) {
  const raw = String(text || '');
  const html = raw.match(TRAILER_RE);
  if (html) {
    try {
      const parsed = JSON.parse(html[1]);
      const confidence = clamp01(parsed.c ?? parsed.confidence);
      if (confidence == null) return null;
      return {
        confidence: round2(confidence),
        rationale: scrubRationale(parsed.r ?? parsed.rationale ?? ''),
        source: 'structured',
        match: html[0],
      };
    } catch {
      return null;
    }
  }
  const line = raw.match(JSON_LINE_RE);
  if (line) {
    try {
      const parsed = JSON.parse(line[0]);
      const payload = parsed && parsed.rlcd && typeof parsed.rlcd === 'object' ? parsed.rlcd : parsed;
      const confidence = clamp01(payload.c ?? payload.confidence);
      if (confidence == null) return null;
      return {
        confidence: round2(confidence),
        rationale: scrubRationale(payload.r ?? payload.rationale ?? ''),
        source: 'structured',
        match: line[0],
      };
    } catch {
      return null;
    }
  }
  return null;
}

function stripTrailer(text) {
  return String(text || '')
    .replace(TRAILER_RE, '')
    .replace(JSON_LINE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function verbalizedConfidence(text) {
  const raw = String(text || '');
  if (LOW_VERBAL.test(raw)) return { confidence: 0.28, source: 'verbalized', rationale: 'hedge_low' };
  if (HIGH_VERBAL.test(raw) && !HEDGE_RE.test(raw)) return { confidence: 0.86, source: 'verbalized', rationale: 'verbal_high' };
  if (MED_VERBAL.test(raw) || HEDGE_RE.test(raw)) return { confidence: 0.55, source: 'verbalized', rationale: 'hedge_medium' };
  return null;
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

function heuristicConfidence({ prompt, answer, files, calibration } = {}) {
  let confidence = 0.7;
  const reasons = [];
  const prior = Number(calibration && calibration.confidence);
  if (Number.isFinite(prior)) {
    confidence = prior;
    reasons.push('prior_posture');
  }
  const chars = extractionChars(files);
  if (chars === 0) {
    confidence = Math.min(confidence, 0.28);
    reasons.push('empty_extract');
  } else if (chars < 400) {
    confidence -= 0.18;
    reasons.push('thin_extract');
  }
  const text = `${String(prompt || '')} ${String(answer || '')}`;
  if (LOW_VERBAL.test(text)) {
    confidence -= 0.2;
    reasons.push('low_verbal');
  } else if (HEDGE_RE.test(text) || MED_VERBAL.test(text)) {
    confidence -= 0.08;
    reasons.push('hedge');
  }
  const clamped = clamp01(confidence);
  return {
    confidence: round2(clamped == null ? 0.5 : clamped),
    source: 'heuristic',
    rationale: reasons.join(',') || 'default',
  };
}

/**
 * Score an answer. Never throws.
 * Phase 2: after the stated signal (trailer / verbal / heuristic),
 * blend evidence quality + claim support so an empty extract cannot
 * keep a 0.95 trailer before defer.
 */
function scoreConfidence(args = {}) {
  try {
    const text = String(args.text ?? args.answer ?? args.response ?? '');
    const trailer = parseTrailer(text);
    const cleaned = stripTrailer(text);
    const verbal = verbalizedConfidence(cleaned);
    const heuristic = heuristicConfidence({
      prompt: args.prompt,
      answer: cleaned,
      files: args.files,
      calibration: args.calibration,
    });
    const picked = trailer || verbal || heuristic;
    const stated = round2(clamp01(picked.confidence) ?? 0.5);
    const source = picked.source || 'heuristic';

    let evidence = null;
    let claims = null;
    let blended = { confidence: stated, raw: stated, adjusted: false };
    try {
      const evidenceMod = require('./evidence');
      const claimsMod = require('./claims');
      evidence = evidenceMod.scoreEvidence({
        text: cleaned,
        files: args.files,
        hits: args.hits,
      });
      claims = claimsMod.analyzeClaims({
        text: cleaned,
        files: args.files,
        hits: args.hits,
      });
      blended = evidenceMod.adjustConfidence({
        stated,
        source,
        evidence,
      });
      const afterClaims = claimsMod.applyClaimAdjustment(blended.confidence, claims);
      if (afterClaims.pulled) {
        blended = {
          confidence: afterClaims.confidence,
          raw: blended.raw,
          adjusted: true,
        };
      }
    } catch {
      /* evidence/claims are optional */
    }

    return {
      confidence: blended.confidence,
      rawConfidence: blended.raw,
      bin: binFor(blended.confidence),
      source,
      rationale: scrubRationale(picked.rationale || '', { scrub: args.scrub }),
      cleanedText: cleaned,
      hadTrailer: !!trailer,
      adjusted: blended.adjusted === true,
      evidence,
      claims,
    };
  } catch {
    return {
      confidence: 0.5,
      rawConfidence: 0.5,
      bin: 'medium',
      source: 'fail_open',
      rationale: '',
      cleanedText: String(args.text ?? args.answer ?? ''),
      hadTrailer: false,
      adjusted: false,
      evidence: null,
      claims: null,
    };
  }
}

function publicMetadata(score, extra = {}) {
  if (!score) return null;
  return {
    v: 1,
    confidence: score.confidence,
    bin: score.bin,
    source: score.source,
    deferred: extra.deferred === true,
    rationale: extra.includeRationale ? (score.rationale || '') : undefined,
  };
}

module.exports = {
  clamp01,
  round2,
  binFor,
  scrubRationale,
  parseTrailer,
  stripTrailer,
  verbalizedConfidence,
  extractionChars,
  heuristicConfidence,
  scoreConfidence,
  publicMetadata,
};
