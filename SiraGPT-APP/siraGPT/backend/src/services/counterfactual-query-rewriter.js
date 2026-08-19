'use strict';

/**
 * Counterfactual Query Rewriter
 *
 * Inspired by activation patching from the attribution-graphs paper: to
 * confirm a hypothesis about a feature, swap in alternative activations and
 * see if behaviour changes. Here we do it at the conversational level —
 * given a user query, generate small rephrasings ("counterfactuals") and
 * run each through an intent-detection function. If the inferred intent
 * flips under a tiny perturbation, the original interpretation is brittle
 * and the agent should ask before acting.
 */

const SYNONYM_SWAPS = Object.freeze([
  { from: /\banalyze\b/i, to: 'review' },
  { from: /\breview\b/i, to: 'audit' },
  { from: /\bsummarize\b/i, to: 'give me a tl;dr of' },
  { from: /\bsummary\b/i, to: 'overview' },
  { from: /\bcompare\b/i, to: 'contrast' },
  { from: /\bcreate\b/i, to: 'build' },
  { from: /\bbuild\b/i, to: 'make' },
  { from: /\bgenerate\b/i, to: 'produce' },
  { from: /\bexplain\b/i, to: 'walk me through' },
  { from: /\bfix\b/i, to: 'repair' },
  { from: /\bdebug\b/i, to: 'troubleshoot' },
  { from: /\bplan\b/i, to: 'roadmap' },
  { from: /\bdraft\b/i, to: 'write' },
  { from: /\bfind\b/i, to: 'search for' },
  { from: /\btranslate\b/i, to: 'localize' },
  { from: /\banaliza\b/i, to: 'revisa' },
  { from: /\bcompara\b/i, to: 'contrasta' },
  { from: /\bcrea\b/i, to: 'construye' },
  { from: /\bconstruye\b/i, to: 'haz' },
  { from: /\bexplica\b/i, to: 'describe' },
  { from: /\bbusca\b/i, to: 'encuentra' },
  { from: /\bresume\b/i, to: 'sintetiza' },
  { from: /\bdraft\b/i, to: 'redacta' },
]);

const FORMALITY_SHIFTS = Object.freeze([
  { from: /\bcan you\b/i, to: 'I need you to' },
  { from: /\bcould you\b/i, to: 'please' },
  { from: /\bplease\b/i, to: '' },
  { from: /\bpuedes\b/i, to: 'necesito que' },
  { from: /\bpor favor\b/i, to: '' },
  { from: /\bI'?d like\b/i, to: 'give me' },
  { from: /\bme gustaría\b/i, to: 'dame' },
]);

const SCOPE_TIGHTENERS = Object.freeze([
  { suffix: ' — focus only on the top 3 items' },
  { suffix: ' — in 200 words or less' },
  { suffix: ' — for an executive audience' },
  { suffix: ' — sólo lo más crítico' },
  { suffix: ' — en una sola oración' },
]);

const SCOPE_LOOSENERS = Object.freeze([
  { suffix: ' — be thorough, cover edge cases' },
  { suffix: ' — include alternatives and trade-offs' },
  { suffix: ' — incluye contexto y antecedentes' },
]);

const HEDGES = Object.freeze([
  { prefix: 'Maybe ' },
  { prefix: 'Could you possibly ' },
  { prefix: 'Quizá ' },
  { prefix: 'Tal vez ' },
]);

function applyOnce(pattern, query) {
  const re = new RegExp(pattern.from.source, pattern.from.flags);
  if (!re.test(query)) return null;
  return query.replace(re, pattern.to);
}

function dedupe(queries) {
  const seen = new Set();
  const out = [];
  for (const q of queries) {
    if (!q) continue;
    const norm = q.trim().toLowerCase();
    if (norm.length < 3 || seen.has(norm)) continue;
    seen.add(norm);
    out.push(q.trim());
  }
  return out;
}

function generateRewrites(query, opts = {}) {
  if (!query || typeof query !== 'string') return [];
  const seedQuery = query.trim();
  const variants = new Set();

  for (const swap of SYNONYM_SWAPS) {
    const rewritten = applyOnce(swap, seedQuery);
    if (rewritten && rewritten !== seedQuery) variants.add(rewritten);
    if (variants.size >= 12) break;
  }
  for (const shift of FORMALITY_SHIFTS) {
    const rewritten = applyOnce(shift, seedQuery);
    if (rewritten && rewritten !== seedQuery) variants.add(rewritten.replace(/\s+/g, ' ').trim());
  }
  for (const tight of SCOPE_TIGHTENERS) {
    variants.add(`${seedQuery}${tight.suffix}`);
    if (variants.size >= 14) break;
  }
  for (const loose of SCOPE_LOOSENERS) {
    variants.add(`${seedQuery}${loose.suffix}`);
    if (variants.size >= 16) break;
  }
  for (const hedge of HEDGES) {
    variants.add(`${hedge.prefix}${seedQuery}`);
    if (variants.size >= 18) break;
  }

  const limit = Math.max(2, Math.min(opts.limit || 6, 12));
  return dedupe([...variants]).slice(0, limit);
}

function normaliseIntentResult(result) {
  if (typeof result === 'string') return { intent: result, confidence: null };
  if (result && typeof result === 'object') {
    return {
      intent: result.intent || result.kind || null,
      confidence: typeof result.confidence === 'number' ? result.confidence : (result.weight ?? null),
    };
  }
  return { intent: null, confidence: null };
}

function probeRobustness(query, intentFn, opts = {}) {
  if (!query || typeof query !== 'string') {
    return { original: null, rewrites: [], robustnessScore: 0, verdict: 'invalid_query', flippedRewrites: [] };
  }
  if (typeof intentFn !== 'function') {
    throw new TypeError('counterfactual-rewriter.probeRobustness requires an intentFn(query, context)');
  }
  const context = opts.context || {};
  const original = normaliseIntentResult(intentFn(query, context));
  const rewrites = generateRewrites(query, opts);
  if (rewrites.length === 0) {
    return { original, rewrites: [], robustnessScore: 1, verdict: 'no_rewrites_generated', flippedRewrites: [] };
  }
  const probed = rewrites.map((variant) => {
    const result = normaliseIntentResult(intentFn(variant, context));
    return {
      variant,
      intent: result.intent,
      confidence: result.confidence,
      flipped: result.intent !== original.intent && original.intent != null,
    };
  });
  const flipped = probed.filter((p) => p.flipped);
  const robustnessScore = Number((1 - flipped.length / probed.length).toFixed(3));
  let verdict;
  if (robustnessScore >= 0.9) verdict = 'highly_robust';
  else if (robustnessScore >= 0.7) verdict = 'mostly_robust';
  else if (robustnessScore >= 0.5) verdict = 'brittle';
  else verdict = 'unstable';
  return { original, rewrites: probed, robustnessScore, verdict, flippedRewrites: flipped };
}

function buildCounterfactualPrompt(result, opts = {}) {
  if (!result || !result.original) return '';
  const lines = ['### Counterfactual Robustness'];
  lines.push(`Intent stability: **${result.verdict}** (${Math.round(result.robustnessScore * 100)}% of rewrites kept the same intent).`);
  if (result.flippedRewrites.length > 0) {
    lines.push('Rewrites that produced a different intent:');
    for (const f of result.flippedRewrites.slice(0, opts.limit || 3)) {
      lines.push(`- "${f.variant.slice(0, 80)}" → ${f.intent || 'unknown'}`);
    }
  }
  if (result.verdict === 'brittle' || result.verdict === 'unstable') {
    lines.push('Original interpretation is fragile — ask one disambiguation question before producing any artefact.');
  }
  return lines.join('\n');
}

module.exports = {
  generateRewrites,
  probeRobustness,
  buildCounterfactualPrompt,
};
