/**
 * contradiction-detector — find pairs of claims in a corpus that
 * disagree with each other.
 *
 * Three deterministic signals are combined:
 *
 *   1. Polarity flip: shared subject + shared object + opposite
 *      polarity (one sentence has a negator, the other doesn't).
 *
 *   2. Numeric divergence: shared subject + shared number-bearing
 *      unit (%, $, count, year) but the numbers differ by more
 *      than a tolerance.
 *
 *   3. Comparative flip: "X increased" vs "X decreased" (or grew /
 *      fell / rose / dropped / gained / lost).
 *
 * We do NOT do natural-language entailment here. The detector
 * catches the loud, machine-checkable cases so that downstream
 * humans can arbitrate the rest.
 *
 * Output shape is ready to feed into the evidence-ledger's
 * markContradicted() flow.
 */

const NEGATORS = new Set([
  "not", "no", "never", "without", "nothing", "none", "neither",
  "nor", "cannot", "can't", "won't", "shouldn't", "doesn't",
  "didn't", "isn't", "wasn't", "weren't", "aren't", "hasn't",
  "haven't", "hadn't", "fail", "failed", "lacks", "lacked",
]);

const OPPOSITE_VERBS = [
  ["increase", "decrease"], ["increased", "decreased"],
  ["grew", "fell"], ["rose", "fell"], ["rise", "fall"],
  ["rises", "falls"], ["gained", "lost"], ["gain", "lose"],
  ["climbed", "dropped"], ["expanded", "contracted"],
  ["surged", "plunged"], ["doubled", "halved"],
  ["approved", "rejected"], ["accepted", "denied"],
  ["confirmed", "denied"], ["supports", "opposes"],
];

const STOP = new Set([
  "the", "a", "an", "of", "to", "in", "on", "at", "for", "by", "with",
  "and", "or", "but", "as", "is", "are", "was", "were", "be", "been",
  "being", "this", "that", "these", "those", "it", "its", "their",
  "from", "into", "about", "than", "then", "so", "have", "has", "had",
  "do", "does", "did", "will", "would", "can", "could", "should",
  "may", "might", "must", "shall",
]);

const NUMBER_RE = /(\d[\d.,]*\s?%|\$\s?\d[\d.,]*|\d{4}(?:-\d{2}-\d{2})?|\d[\d.,]*)/g;

function detectContradictions(claims, opts = {}) {
  if (!Array.isArray(claims) || claims.length < 2) {
    return { ok: true, contradictions: [], stats: { claims: claims?.length || 0, contradictions: 0 } };
  }
  const numericTolerance = opts.numeric_tolerance ?? 0.1; // 10% relative diff

  const prepared = claims.map((c, i) => ({
    id: c.id || `c_${i + 1}`,
    source_id: c.source_id || null,
    sentence: String(c.sentence || c.text || ""),
    tokens: tokenize(String(c.sentence || c.text || "")),
    negated: hasNegator(String(c.sentence || c.text || "")),
    numbers: extractNumbers(String(c.sentence || c.text || "")),
    verbs: extractVerbs(String(c.sentence || c.text || "")),
  }));

  const contradictions = [];
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const a = prepared[i];
      const b = prepared[j];
      if (a.source_id && b.source_id && a.source_id === b.source_id) continue;
      const subjectOverlap = sharedSubject(a.tokens, b.tokens);
      if (subjectOverlap.length < 2) continue;

      const polarityHit = a.negated !== b.negated && overlapScore(a.tokens, b.tokens) >= 0.4;
      const verbHit = oppositeVerbFound(a.verbs, b.verbs);
      const numHit = numericDivergence(a.numbers, b.numbers, numericTolerance);

      if (polarityHit || verbHit || numHit) {
        contradictions.push({
          id: `${a.id}__vs__${b.id}`,
          claim_a: { id: a.id, sentence: a.sentence, source_id: a.source_id },
          claim_b: { id: b.id, sentence: b.sentence, source_id: b.source_id },
          kind: numHit ? "numeric_divergence" : verbHit ? "comparative_flip" : "polarity_flip",
          shared_subject: subjectOverlap,
          evidence: {
            polarity_flip: polarityHit,
            opposite_verbs: verbHit || null,
            numeric: numHit || null,
          },
        });
      }
    }
  }

  return {
    ok: contradictions.length === 0,
    contradictions,
    stats: {
      claims: claims.length,
      contradictions: contradictions.length,
      by_kind: countBy(contradictions, "kind"),
    },
  };
}

function tokenize(text) {
  return String(text).toLowerCase()
    .split(/[^a-z0-9à-ÿ]+/i)
    .filter(t => t.length >= 3 && !STOP.has(t));
}

function hasNegator(text) {
  const lower = " " + text.toLowerCase() + " ";
  for (const n of NEGATORS) if (lower.includes(` ${n} `)) return true;
  return false;
}

function extractNumbers(text) {
  const matches = String(text).match(NUMBER_RE) || [];
  return matches.map(normalizeNumber).filter(n => n !== null);
}

function normalizeNumber(raw) {
  const cleaned = String(raw).replace(/\s/g, "");
  if (/^\d{4}(-\d{2}-\d{2})?$/.test(cleaned)) {
    return { kind: "date", value: cleaned };
  }
  if (cleaned.endsWith("%")) {
    const v = parseFloat(cleaned.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(v)) return null;
    return { kind: "percent", value: v };
  }
  if (cleaned.startsWith("$")) {
    const v = parseFloat(cleaned.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(v)) return null;
    return { kind: "currency", value: v };
  }
  const v = parseFloat(cleaned.replace(/,/g, ""));
  if (!Number.isFinite(v)) return null;
  return { kind: "scalar", value: v };
}

function extractVerbs(text) {
  const toks = String(text).toLowerCase().split(/\W+/).filter(Boolean);
  return new Set(toks);
}

function sharedSubject(a, b) {
  const setB = new Set(b);
  return a.filter(t => setB.has(t));
}

function overlapScore(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function oppositeVerbFound(verbsA, verbsB) {
  for (const [x, y] of OPPOSITE_VERBS) {
    if (verbsA.has(x) && verbsB.has(y)) return [x, y];
    if (verbsA.has(y) && verbsB.has(x)) return [y, x];
  }
  return null;
}

function numericDivergence(aNums, bNums, tol) {
  const byKindA = groupByKind(aNums);
  const byKindB = groupByKind(bNums);
  for (const kind of Object.keys(byKindA)) {
    if (!byKindB[kind] || byKindB[kind].length === 0) continue;
    if (kind === "date") {
      const missing = byKindA[kind].find(a => !byKindB[kind].some(b => b.value === a.value));
      const extra = byKindB[kind].find(b => !byKindA[kind].some(a => a.value === b.value));
      if (missing && extra) return { kind, a: missing.value, b: extra.value };
      continue;
    }
    let minRel = Infinity;
    let bestPair = null;
    for (const a of byKindA[kind]) {
      for (const b of byKindB[kind]) {
        const denom = Math.max(Math.abs(a.value), Math.abs(b.value), 1e-9);
        const rel = Math.abs(a.value - b.value) / denom;
        if (rel < minRel) { minRel = rel; bestPair = [a, b]; }
      }
    }
    if (bestPair && minRel > tol) {
      return { kind, a: bestPair[0].value, b: bestPair[1].value, relative_diff: Math.round(minRel * 100) / 100 };
    }
  }
  return null;
}

function groupByKind(nums) {
  const out = {};
  for (const n of nums) {
    if (!out[n.kind]) out[n.kind] = [];
    out[n.kind].push(n);
  }
  return out;
}

function countBy(arr, key) {
  const out = {};
  for (const x of arr) out[x[key]] = (out[x[key]] || 0) + 1;
  return out;
}

module.exports = {
  detectContradictions,
  hasNegator,
  extractNumbers,
  OPPOSITE_VERBS,
};
