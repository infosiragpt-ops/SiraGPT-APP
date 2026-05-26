/**
 * code-bleu — Ren et al. (2020) "CodeBLEU: a Method for Automatic
 * Evaluation of Code Synthesis" (arXiv:2009.10297).
 *
 * Motivation (Jiang et al. survey §5.10): plain BLEU treats code as
 * text — it rewards lexical overlap but doesn't care whether the
 * output is syntactically valid or whether it preserves the reference's
 * data flow. CodeBLEU corrects for that with four weighted components:
 *
 *   CodeBLEU = α · BLEU
 *            + β · weighted-BLEU   (keywords weighted higher)
 *            + γ · syntax_match    (abstract-syntax token match)
 *            + δ · dataflow_match  (variable-usage structure match)
 *
 * Canonical weights (Ren et al.): α=β=γ=δ=0.25.
 *
 * This is a pure-JS, zero-dependency implementation. We approximate
 * syntax_match and dataflow_match using language-aware token/AST-
 * shallow heuristics rather than a full parser — the paper reports
 * that the canonical implementation also uses heuristic parsers
 * (tree-sitter grammars); a keyword-weighted surface matcher captures
 * most of the signal for Python/JS code comparison in our use case
 * (ranking candidate solutions against a reference).
 *
 * The score is not meant to REPLACE pass@k — it complements it. A
 * failing solution can still be "close" (0.85 CodeBLEU) to the
 * reference, which tells you the model got the structure right but
 * a detail wrong — a useful diagnostic in benchmark reports.
 */

// Common programming keywords that get weighted more in weighted-BLEU.
// We keep a superset covering Python + JS/TS so the weight table is
// reusable across both languages. Language-specific ones are fine to
// include — absence just means no extra weight on those tokens.
const KEYWORDS = new Set([
  // Python
  'def', 'return', 'if', 'elif', 'else', 'for', 'while', 'in', 'not',
  'and', 'or', 'is', 'None', 'True', 'False', 'lambda', 'class',
  'import', 'from', 'as', 'try', 'except', 'finally', 'raise', 'with',
  'yield', 'pass', 'break', 'continue', 'global', 'nonlocal',
  // JS / TS
  'function', 'const', 'let', 'var', 'null', 'undefined', 'typeof',
  'new', 'this', 'extends', 'instanceof', 'async', 'await', 'throw',
  'switch', 'case', 'default', 'do', 'void', 'delete',
]);

const KEYWORD_WEIGHT = 5;
const NON_KEYWORD_WEIGHT = 1;

// Identifiers / operators / punctuation split. We keep punctuation
// separate because it carries syntax signal (e.g. ":", "{", "}").
const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]*|[-+*/%=<>!&|^~?:]+|[(){}\[\],;.]/g;

function tokenize(code) {
  if (typeof code !== 'string' || code.length === 0) return [];
  const stripped = code
    // Strip Python line comments.
    .replace(/#.*$/gm, '')
    // Strip JS line comments.
    .replace(/\/\/.*$/gm, '')
    // Strip JS block comments.
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return stripped.match(TOKEN_RE) || [];
}

function nGrams(tokens, n) {
  const out = [];
  for (let i = 0; i + n <= tokens.length; i++) {
    out.push(tokens.slice(i, i + n).join(' '));
  }
  return out;
}

/** Standard n-gram precision with Brevity Penalty — plain BLEU-4. */
function bleu(reference, candidate) {
  const refTokens = tokenize(reference);
  const candTokens = tokenize(candidate);
  if (candTokens.length === 0) return 0;

  let logPrecSum = 0;
  let valid = 0;
  for (let n = 1; n <= 4; n++) {
    const refGrams = nGrams(refTokens, n);
    const candGrams = nGrams(candTokens, n);
    if (candGrams.length === 0) continue;
    const refCount = new Map();
    for (const g of refGrams) refCount.set(g, (refCount.get(g) || 0) + 1);
    let matches = 0;
    const used = new Map();
    for (const g of candGrams) {
      const avail = refCount.get(g) || 0;
      const soFar = used.get(g) || 0;
      if (soFar < avail) {
        matches++;
        used.set(g, soFar + 1);
      }
    }
    const prec = matches / candGrams.length;
    if (prec > 0) {
      logPrecSum += Math.log(prec);
      valid++;
    } else {
      // Zero precision on any n poisons plain BLEU to 0 mathematically;
      // matching the smoothed BLEU-4 convention we treat it as a tiny
      // epsilon rather than absolute zero so the score stays comparable.
      logPrecSum += Math.log(1e-9);
      valid++;
    }
  }
  const geoMean = Math.exp(logPrecSum / valid);
  const bp = candTokens.length >= refTokens.length
    ? 1
    : Math.exp(1 - refTokens.length / candTokens.length);
  return bp * geoMean;
}

/** Weighted BLEU: keywords count more toward the match. */
function weightedBleu(reference, candidate) {
  const refTokens = tokenize(reference);
  const candTokens = tokenize(candidate);
  if (candTokens.length === 0) return 0;

  const weight = t => (KEYWORDS.has(t) ? KEYWORD_WEIGHT : NON_KEYWORD_WEIGHT);

  let logPrecSum = 0;
  let valid = 0;
  for (let n = 1; n <= 4; n++) {
    const refGrams = nGrams(refTokens, n);
    const candGrams = nGrams(candTokens, n);
    if (candGrams.length === 0) continue;

    const refCount = new Map();
    for (const g of refGrams) refCount.set(g, (refCount.get(g) || 0) + 1);

    let weightedMatches = 0;
    let weightedTotal = 0;
    const used = new Map();
    for (const g of candGrams) {
      const w = g.split(' ').reduce((sum, tok) => sum + weight(tok), 0);
      weightedTotal += w;
      const avail = refCount.get(g) || 0;
      const soFar = used.get(g) || 0;
      if (soFar < avail) {
        weightedMatches += w;
        used.set(g, soFar + 1);
      }
    }
    const prec = weightedTotal > 0 ? weightedMatches / weightedTotal : 0;
    logPrecSum += Math.log(prec > 0 ? prec : 1e-9);
    valid++;
  }
  return Math.exp(logPrecSum / valid);
}

/**
 * Syntax match — surface-level shape overlap.
 *
 * We compare the SEQUENCE of structural markers (punctuation, control
 * keywords, block openers). The Jaccard similarity of their bigram
 * sets is a decent proxy for "does the reference structure look like
 * the candidate structure" without requiring a full parser.
 */
const STRUCTURAL_TOKENS = new Set([
  'if', 'elif', 'else', 'for', 'while', 'def', 'class', 'try', 'except', 'finally',
  'function', 'return',
  '(', ')', '{', '}', '[', ']', ':', ';', ',', '.', '->', '=>',
]);

function structuralBigrams(tokens) {
  const filtered = tokens.filter(t => STRUCTURAL_TOKENS.has(t));
  const bigrams = new Set();
  for (let i = 0; i + 1 < filtered.length; i++) {
    bigrams.add(`${filtered[i]}|${filtered[i + 1]}`);
  }
  return bigrams;
}

function syntaxMatch(reference, candidate) {
  const refBi = structuralBigrams(tokenize(reference));
  const candBi = structuralBigrams(tokenize(candidate));
  if (refBi.size === 0 && candBi.size === 0) return 1;
  if (refBi.size === 0 || candBi.size === 0) return 0;
  let inter = 0;
  for (const g of candBi) if (refBi.has(g)) inter++;
  const union = new Set([...refBi, ...candBi]).size;
  return inter / union;
}

/**
 * Dataflow match — identifier usage similarity.
 *
 * We collect identifiers (non-keyword, non-single-char) and compare the
 * multi-sets. This approximates the reference's "variable roles" by
 * assuming that using similar names in similar frequencies signals
 * comparable dataflow. Not as good as a proper def-use chain, but
 * zero-dependency and stable.
 */
function dataflowMatch(reference, candidate) {
  const pickIds = tokens => tokens.filter(t =>
    /^[A-Za-z_][A-Za-z0-9_]+$/.test(t) && !KEYWORDS.has(t) && t.length > 1
  );
  const refIds = pickIds(tokenize(reference));
  const candIds = pickIds(tokenize(candidate));
  if (refIds.length === 0 && candIds.length === 0) return 1;
  if (refIds.length === 0 || candIds.length === 0) return 0;
  const count = arr => {
    const m = new Map();
    for (const t of arr) m.set(t, (m.get(t) || 0) + 1);
    return m;
  };
  const refC = count(refIds);
  const candC = count(candIds);
  // Multi-set Jaccard: |min intersection| / |union of counts|.
  let inter = 0, union = 0;
  const allKeys = new Set([...refC.keys(), ...candC.keys()]);
  for (const k of allKeys) {
    const a = refC.get(k) || 0;
    const b = candC.get(k) || 0;
    inter += Math.min(a, b);
    union += Math.max(a, b);
  }
  return union === 0 ? 1 : inter / union;
}

/**
 * Compute CodeBLEU.
 *
 * @param {string} reference       — the reference (canonical) solution
 * @param {string} candidate       — the candidate to score
 * @param {object} [weights]       — override the α/β/γ/δ mix
 * @returns {{
 *   codeBleu: number,
 *   bleu: number,
 *   weightedBleu: number,
 *   syntaxMatch: number,
 *   dataflowMatch: number,
 *   weights: { bleu: number, weightedBleu: number, syntax: number, dataflow: number },
 * }}
 */
function codeBleu(reference, candidate, weights) {
  const w = {
    bleu: 0.25,
    weightedBleu: 0.25,
    syntax: 0.25,
    dataflow: 0.25,
    ...(weights || {}),
  };
  const parts = {
    bleu: bleu(reference, candidate),
    weightedBleu: weightedBleu(reference, candidate),
    syntaxMatch: syntaxMatch(reference, candidate),
    dataflowMatch: dataflowMatch(reference, candidate),
  };
  const score = w.bleu * parts.bleu
              + w.weightedBleu * parts.weightedBleu
              + w.syntax * parts.syntaxMatch
              + w.dataflow * parts.dataflowMatch;
  return {
    codeBleu: score,
    ...parts,
    weights: w,
  };
}

module.exports = {
  codeBleu,
  bleu,
  weightedBleu,
  syntaxMatch,
  dataflowMatch,
  tokenize,
  KEYWORDS,
  STRUCTURAL_TOKENS,
};
