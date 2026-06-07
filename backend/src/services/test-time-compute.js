'use strict';

/**
 * test-time-compute.js — Phase 3 of the cognitive core.
 * ───────────────────────────────────────────────────────────────────────────
 * Consumes the reasoning-orchestrator's `compute` plan and turns it into
 * concrete "spend more thinking on hard problems" behavior. Frontier
 * assistants feel smart partly because they spend MORE compute on harder
 * questions (extended chain-of-thought, self-consistency voting, best-of-N
 * drafting) and LESS on trivial ones. The orchestrator already decided WHEN;
 * this module decides HOW.
 *
 * Two integration surfaces:
 *
 *   1. Streaming chat (the common path): we cannot cheaply fan out N live
 *      token streams, so test-time compute is expressed as a REASONING
 *      DIRECTIVE injected into the system prompt — an instruction to reason
 *      carefully / consider multiple approaches / self-critique BEFORE
 *      committing to the answer. `buildReasoningDirective()`.
 *
 *   2. Non-streaming callers (background tasks, /answer, evals) that CAN
 *      afford multiple completions get a concrete sampling plan via
 *      `planSampling()` + `aggregateSamples()` (majority vote for
 *      deterministic answers; judged best-of-N otherwise).
 *
 * Pure & deterministic. No I/O, no LLM. Gated by the caller
 * (SIRAGPT_TEST_TIME_COMPUTE). Fail-safe: unknown shapes → no directive.
 *
 * Public API:
 *   shouldApply(decision)                       → boolean
 *   buildReasoningDirective(decision, opts?)    → string  (system block or '')
 *   planSampling(decision)                      → { mode, samples, strategy }
 *   aggregateSamples(samples, plan)             → { answer, method, support }
 *   COMPUTE_MODES
 */

const COMPUTE_MODES = Object.freeze(['direct', 'extended', 'self_consistency', 'best_of_n']);
const MAX_DIRECTIVE_CHARS = Number(process.env.SIRAGPT_TEST_TIME_COMPUTE_MAX_CHARS) || 1400;

function shouldApply(decision) {
  const c = decision && decision.compute;
  if (!c || !c.mode) return false;
  if (c.mode === 'direct' && (!c.reflection && (c.reasoningEffort === 'low' || !c.reasoningEffort))) return false;
  return COMPUTE_MODES.includes(c.mode);
}

/** Spanish (default) / English directive text per compute mode. */
function directiveBody(mode, samples, lang) {
  const es = lang !== 'en';
  switch (mode) {
    case 'extended':
      return es
        ? [
            'Esta consulta es compleja. Antes de responder, razona internamente paso a paso:',
            'descompón el problema, identifica supuestos y casos límite, y verifica cada paso.',
            'Luego entrega SOLO la respuesta final, clara y bien estructurada (no muestres el',
            'borrador de razonamiento salvo que se pida). Si algo es incierto, dilo explícitamente.',
          ].join(' ')
        : [
            'This request is complex. Before answering, reason step by step internally:',
            'decompose the problem, surface assumptions and edge cases, and verify each step.',
            'Then deliver ONLY the final, well-structured answer (do not expose the scratch',
            'reasoning unless asked). If anything is uncertain, state it explicitly.',
          ].join(' ');
    case 'self_consistency':
      return es
        ? [
            `Problema de razonamiento riguroso. Internamente, considera ${samples} enfoques o`,
            'cadenas de razonamiento independientes para llegar al resultado. Si convergen, entrega',
            'esa respuesta con alta confianza; si divergen, identifica el error y reconcilia hacia',
            'la respuesta más consistente y verificable. Muestra solo el resultado final y, si aplica,',
            'una verificación breve.',
          ].join(' ')
        : [
            `Rigorous reasoning problem. Internally consider ${samples} independent approaches or`,
            'reasoning chains to reach the result. If they converge, deliver that answer with high',
            'confidence; if they diverge, find the error and reconcile to the most consistent,',
            'verifiable answer. Show only the final result plus a brief verification if relevant.',
          ].join(' ');
    case 'best_of_n':
      return es
        ? [
            `Entregable de alto valor. Internamente, esboza ${samples} versiones de la respuesta,`,
            'evalúa cada una contra los requisitos explícitos (completitud, exactitud, formato,',
            'fuentes) y entrega únicamente la versión más fuerte, ya pulida. No muestres los',
            'borradores descartados.',
          ].join(' ')
        : [
            `High-stakes deliverable. Internally draft ${samples} versions of the answer, evaluate`,
            'each against the explicit requirements (completeness, accuracy, format, sources), and',
            'deliver only the strongest, already-polished version. Do not show discarded drafts.',
          ].join(' ');
    default:
      return '';
  }
}

function buildReasoningDirective(decision, opts = {}) {
  if (!shouldApply(decision)) return '';
  const c = decision.compute;
  const lang = (opts.language || 'es').slice(0, 2).toLowerCase();
  const body = directiveBody(c.mode, c.samples || 3, lang);
  if (!body) return '';
  const header = lang === 'en' ? 'REASONING EFFORT' : 'ESFUERZO DE RAZONAMIENTO';
  const block = `\n\n## ${header} (${c.mode}, effort=${c.reasoningEffort || 'medium'})\n${body}`;
  const max = Number(opts.maxChars) || MAX_DIRECTIVE_CHARS;
  return block.length <= max ? block : `${block.slice(0, max - 1)}…`;
}

/**
 * Sampling plan for callers that can afford multiple completions. Deterministic
 * answers (math/logic) → majority vote; generative → judged best-of-N.
 */
function planSampling(decision) {
  const c = (decision && decision.compute) || {};
  if (c.mode === 'self_consistency') {
    return { mode: c.mode, samples: Math.max(2, c.samples || 3), strategy: 'majority_vote' };
  }
  if (c.mode === 'best_of_n') {
    return { mode: c.mode, samples: Math.max(2, c.samples || 2), strategy: 'judge_best' };
  }
  return { mode: 'direct', samples: 1, strategy: 'single' };
}

/** Normalise a candidate answer for majority comparison. */
function normaliseForVote(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, ' ')
    .trim();
}

/**
 * Aggregate N sampled completions. For majority_vote we group by a normalised
 * key and return the most-supported answer (ties → first). For judge_best we
 * defer to a provided scoring function, else fall back to the longest non-empty
 * (a crude proxy for completeness) — callers with a real judge should pass one.
 */
function aggregateSamples(samples = [], plan = {}, opts = {}) {
  const clean = (Array.isArray(samples) ? samples : []).map((s) => (typeof s === 'string' ? s : (s && s.text) || '')).filter((s) => s && s.trim());
  if (clean.length === 0) return { answer: '', method: 'empty', support: 0, total: 0 };
  if (clean.length === 1) return { answer: clean[0], method: 'single', support: 1, total: 1 };

  if (plan.strategy === 'majority_vote') {
    const groups = new Map();
    for (const s of clean) {
      const key = normaliseForVote(s).slice(0, 400);
      const g = groups.get(key) || { count: 0, sample: s };
      g.count += 1;
      groups.set(key, g);
    }
    let best = null;
    for (const g of groups.values()) if (!best || g.count > best.count) best = g;
    return { answer: best.sample, method: 'majority_vote', support: best.count, total: clean.length };
  }

  // judge_best
  const scorer = typeof opts.scoreFn === 'function' ? opts.scoreFn : (t) => t.length;
  let best = null;
  let bestScore = -Infinity;
  for (const s of clean) {
    const score = Number(scorer(s)) || 0;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return { answer: best, method: 'judge_best', support: 1, total: clean.length, score: bestScore };
}

module.exports = {
  shouldApply,
  buildReasoningDirective,
  planSampling,
  aggregateSamples,
  normaliseForVote,
  COMPUTE_MODES,
  MAX_DIRECTIVE_CHARS,
};
