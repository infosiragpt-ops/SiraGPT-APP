'use strict';

/**
 * Per-claim grounding for document Q&A.
 *
 * Splits an answer into short claims and labels each
 * `supported` (overlaps the extract / RAG hits) or `inferred`.
 * Fail-open. No LLM. Used only when the documents flag is on.
 */

const { extractPool, coverageAgainst } = require('./evidence');

const SKIP_RE = /\b(?:no\s+tengo\s+suficiente|confianza\s+(?:baja|media)|puedes\s+indicar|secci[oó]n\s+o\s+p[aá]gina)\b/i;
const DISTINCTIVE_RE = /\b(?:\d+(?:[.,]\d+)?%?|20\d{2}|19\d{2})\b/;

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function splitClaims(text) {
  const raw = String(text || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return [];
  const parts = raw
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 18 && s.length <= 280)
    .filter((s) => !SKIP_RE.test(s))
    .filter((s) => !/\?$/.test(s));
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= 8) break;
  }
  return out;
}

function labelClaim(claim, pool) {
  const cov = coverageAgainst(claim, pool);
  const distinctive = DISTINCTIVE_RE.exec(claim);
  let distinctiveHit = false;
  if (distinctive && pool) {
    const needle = distinctive[0].toLowerCase();
    distinctiveHit = String(pool).toLowerCase().includes(needle);
  }
  const supported = cov.coverage >= 0.28 || distinctiveHit;
  return {
    text: claim.slice(0, 160),
    label: supported ? 'supported' : 'inferred',
    coverage: cov.coverage,
  };
}

/**
 * @returns {{
 *   n: number,
 *   supported: number,
 *   inferred: number,
 *   supportRate: number,
 *   items: Array<{text: string, label: string, coverage: number}>,
 * }}
 */
function analyzeClaims({ text, files, hits } = {}) {
  try {
    const sentences = splitClaims(text);
    const pool = extractPool(files, hits);
    const items = sentences.map((s) => labelClaim(s, pool));
    const supported = items.filter((i) => i.label === 'supported').length;
    const n = items.length;
    const supportRate = n ? Math.round((supported / n) * 1000) / 1000 : null;
    return {
      n,
      supported,
      inferred: n - supported,
      supportRate,
      items,
    };
  } catch {
    return { n: 0, supported: 0, inferred: 0, supportRate: null, items: [] };
  }
}

/**
 * Pull stated confidence down when most claims are inferred.
 */
function applyClaimAdjustment(confidence, claims) {
  const raw = clamp01(confidence);
  if (!claims || claims.n < 1 || claims.supportRate == null) {
    return { confidence: Math.round(raw * 100) / 100, pulled: false };
  }
  if (claims.supportRate >= 0.4) {
    return { confidence: Math.round(raw * 100) / 100, pulled: false };
  }
  const next = Math.max(0.22, raw * 0.72 + claims.supportRate * 0.18);
  const rounded = Math.round(Math.min(raw, next) * 100) / 100;
  return { confidence: rounded, pulled: rounded < raw - 0.01 };
}

function compactClaimPhrase({ language = 'es', claims } = {}) {
  if (!claims || claims.n < 1 || claims.inferred < 1) return '';
  const es = String(language || 'es').slice(0, 2).toLowerCase() !== 'en';
  if (claims.supported === 0) {
    return es
      ? '_Afirmaciones inferidas: no aparecen en el extracto. Pide la sección o página._'
      : '_Inferred claims: they are not in the extract. Ask for the section or page._';
  }
  return es
    ? '_Parte inferida: solo las afirmaciones con respaldo en el extracto están cubiertas._'
    : '_Partly inferred: only claims backed by the extract are covered._';
}

function publicClaims(claims) {
  if (!claims || claims.n === 0) return undefined;
  return {
    n: claims.n,
    supported: claims.supported,
    inferred: claims.inferred,
    supportRate: claims.supportRate,
    items: (claims.items || []).slice(0, 6).map((i) => ({
      text: String(i.text || '').slice(0, 120),
      label: i.label,
    })),
  };
}

module.exports = {
  splitClaims,
  analyzeClaims,
  applyClaimAdjustment,
  compactClaimPhrase,
  publicClaims,
};
