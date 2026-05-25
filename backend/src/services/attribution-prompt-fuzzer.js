'use strict';

/**
 * attribution-prompt-fuzzer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Generates controlled perturbations of a prompt (paraphrases, synonym
 * swaps, dropped stopwords, reordered clauses) and runs each through
 * the attribution pipeline so we can measure *graph stability* under
 * input variation. Inspired by the activation-patching / counterfactual
 * intervention experiments in Anthropic's circuit-tracing work: a
 * robust pipeline should produce ~equivalent attribution graphs under
 * meaning-preserving perturbations; a fragile one shifts intent or
 * topology dramatically.
 *
 * Stability score in [0, 1]: 1 means every variant produced the same
 * dominant intent / similar centroid; 0 means every variant produced a
 * different intent.
 *
 * Public API:
 *   generateVariants(prompt, opts?)          → string[]
 *   probeStability({ prompt, scorerFn, opts? }) → StabilityReport
 *   compareIntents(reports)                  → IntentStabilityReport
 *
 * `scorerFn(variantText)` must return a graph-summary-ish shape with
 * at least a primary intent kind and a centroid; typically the caller
 * passes `(t) => engine.analyze({ prompt: t }).attribution.summary` or
 * similar.
 */

const STOPWORDS_DROP = new Set([
  'the', 'a', 'an', 'please', 'kindly', 'just', 'really', 'very', 'quite',
  'por', 'favor', 'el', 'la', 'los', 'las', 'un', 'una',
]);

const SYNONYMS = Object.freeze({
  build: ['create', 'make', 'develop', 'implement'],
  create: ['build', 'make', 'generate', 'produce'],
  fix: ['repair', 'correct', 'debug', 'resolve'],
  explain: ['describe', 'clarify', 'tell me about', 'elaborate on'],
  summarize: ['recap', 'condense', 'sum up', 'brief'],
  improve: ['enhance', 'upgrade', 'refine'],
  show: ['display', 'present', 'render'],
  add: ['include', 'append', 'insert'],
  user: ['person', 'customer', 'visitor'],
  bug: ['issue', 'defect', 'problem'],
  function: ['method', 'routine', 'procedure'],
  page: ['screen', 'view'],
  database: ['db', 'datastore'],
  fast: ['quick', 'rapid', 'speedy'],
  slow: ['sluggish', 'laggy'],
  // ES
  necesito: ['quiero', 'requiero'],
  quiero: ['necesito', 'requiero'],
  arregla: ['corrige', 'repara'],
  explica: ['describe', 'aclara'],
  ayuda: ['asiste', 'colabora'],
});

function tokenize(text) {
  return String(text || '').split(/(\s+)/).filter(Boolean);
}

function dropStopwordVariant(text) {
  const tokens = tokenize(text);
  const out = [];
  let dropped = false;
  for (const t of tokens) {
    const w = t.toLowerCase().replace(/[^a-z]/g, '');
    if (!dropped && w && STOPWORDS_DROP.has(w)) {
      dropped = true;
      continue;
    }
    out.push(t);
  }
  const result = out.join('').replace(/\s{2,}/g, ' ').trim();
  return result === text.trim() ? null : result;
}

function synonymVariant(text) {
  const tokens = tokenize(text);
  const candidates = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const w = tokens[i].toLowerCase().replace(/[^a-záéíóúñü]/g, '');
    if (SYNONYMS[w]) candidates.push({ idx: i, original: tokens[i], options: SYNONYMS[w] });
  }
  if (candidates.length === 0) return null;
  const pick = candidates[0];
  const newTokens = [...tokens];
  newTokens[pick.idx] = pick.options[0];
  return newTokens.join('');
}

function reorderSentencesVariant(text) {
  const parts = String(text || '').split(/(?<=[.!?])\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return [...parts].reverse().join(' ');
}

function caseFlipVariant(text) {
  if (!text) return null;
  const upper = text.toUpperCase();
  return upper === text ? null : upper;
}

function whitespaceVariant(text) {
  if (!text) return null;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const padded = `  ${collapsed}\n\n`;
  return padded === text ? null : padded;
}

function pluraliseVariant(text) {
  // toggle simple plural/singular on the first matching noun. Crude.
  const tokens = tokenize(text);
  for (let i = 0; i < tokens.length; i += 1) {
    const w = tokens[i];
    if (/^[A-Za-z]{4,}s$/.test(w)) {
      tokens[i] = w.slice(0, -1);
      return tokens.join('');
    }
    if (/^[A-Za-z]{4,}$/.test(w)) {
      tokens[i] = `${w}s`;
      return tokens.join('');
    }
  }
  return null;
}

/**
 * Build a list of meaning-preserving variants. Always includes the
 * original prompt as the first element (acts as the baseline).
 */
function generateVariants(prompt, opts = {}) {
  const limit = Math.max(2, Number(opts.limit) || 5);
  const variants = [String(prompt || '')];
  const candidates = [
    dropStopwordVariant,
    synonymVariant,
    reorderSentencesVariant,
    whitespaceVariant,
    caseFlipVariant,
    pluraliseVariant,
  ];
  const seen = new Set([variants[0]]);
  for (const fn of candidates) {
    if (variants.length >= limit) break;
    try {
      const v = fn(prompt);
      if (v && !seen.has(v)) {
        variants.push(v);
        seen.add(v);
      }
    } catch (_) { /* swallow */ }
  }
  return variants;
}

function safePrimaryIntent(summary) {
  if (!summary) return null;
  if (typeof summary.primaryIntent === 'string') return summary.primaryIntent.toLowerCase();
  if (summary?.topIntents?.[0]?.kind) return String(summary.topIntents[0].kind).toLowerCase();
  if (summary?.topIntents?.[0]?.text) return String(summary.topIntents[0].text).toLowerCase();
  if (typeof summary?.summary?.topIntents?.[0]?.kind === 'string') return summary.summary.topIntents[0].kind.toLowerCase();
  return null;
}

function safeCentroid(summary) {
  if (!summary) return null;
  if (summary.centroid && typeof summary.centroid === 'object') return summary.centroid;
  if (summary.typeBreakdown && typeof summary.typeBreakdown === 'object') {
    const out = {};
    const total = Object.values(summary.typeBreakdown).reduce((a, b) => a + b, 0) || 1;
    for (const [k, v] of Object.entries(summary.typeBreakdown)) out[k] = v / total;
    return out;
  }
  return null;
}

function l1(a, b) {
  if (!a || !b) return 0;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let sum = 0;
  for (const k of keys) sum += Math.abs((a[k] || 0) - (b[k] || 0));
  return sum;
}

function probeStability({ prompt, scorerFn, opts = {} } = {}) {
  if (typeof scorerFn !== 'function') {
    return { ok: false, reason: 'scorerFn is required' };
  }
  const variants = generateVariants(prompt, opts);
  const reports = [];
  for (const v of variants) {
    try {
      const summary = scorerFn(v);
      reports.push({
        variant: v,
        primaryIntent: safePrimaryIntent(summary),
        centroid: safeCentroid(summary),
      });
    } catch (_err) {
      reports.push({ variant: v, primaryIntent: null, centroid: null, error: true });
    }
  }

  const baseline = reports[0];
  const baselineIntent = baseline?.primaryIntent || null;
  const baselineCentroid = baseline?.centroid || null;
  const intentMatches = reports.filter((r) => r.primaryIntent && baselineIntent && r.primaryIntent === baselineIntent).length;
  const intentStability = reports.length === 0 ? 0 : intentMatches / reports.length;

  let centroidShifts = [];
  if (baselineCentroid) {
    centroidShifts = reports.map((r) => (r.centroid ? l1(r.centroid, baselineCentroid) / 2 : null)).filter((v) => v !== null);
  }
  const meanCentroidShift = centroidShifts.length === 0
    ? 0
    : centroidShifts.reduce((a, b) => a + b, 0) / centroidShifts.length;
  // centroid stability = 1 - mean shift (clamped)
  const centroidStability = Math.max(0, Math.min(1, 1 - meanCentroidShift));

  // overall stability = blend intent + centroid (intent weighted heavier)
  const stability = Number((0.7 * intentStability + 0.3 * centroidStability).toFixed(3));

  return {
    ok: true,
    variants: reports.length,
    intentStability: Number(intentStability.toFixed(3)),
    centroidStability: Number(centroidStability.toFixed(3)),
    stability,
    classification: stability >= 0.85 ? 'robust' : (stability >= 0.6 ? 'mostly_stable' : 'fragile'),
    baselineIntent,
    perVariant: reports.map((r) => ({
      variant: r.variant,
      primaryIntent: r.primaryIntent,
      intentMatch: r.primaryIntent === baselineIntent,
      centroidShift: r.centroid && baselineCentroid ? Number((l1(r.centroid, baselineCentroid) / 2).toFixed(3)) : null,
      error: r.error || false,
    })),
  };
}

function compareIntents(reports) {
  if (!Array.isArray(reports) || reports.length === 0) return { distinctIntents: 0, mostCommon: null };
  const counts = new Map();
  for (const r of reports) {
    const k = r.primaryIntent || 'unknown';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return {
    distinctIntents: sorted.length,
    mostCommon: sorted[0] ? { intent: sorted[0][0], count: sorted[0][1] } : null,
    distribution: sorted.map(([intent, count]) => ({ intent, count })),
  };
}

module.exports = {
  generateVariants,
  probeStability,
  compareIntents,
  dropStopwordVariant,
  synonymVariant,
  reorderSentencesVariant,
  caseFlipVariant,
  whitespaceVariant,
  pluraliseVariant,
  STOPWORDS_DROP,
  SYNONYMS,
};
