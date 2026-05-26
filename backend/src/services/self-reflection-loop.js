'use strict';

/**
 * self-reflection-loop.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Post-generation reflection pass. After the LLM produces a draft
 * response, we score it against the attribution context that drove the
 * prompt (faithfulness, intent coverage, format adherence). If the
 * draft falls below a configurable threshold the loop builds a STRICT
 * retry instruction that names the specific gaps the next attempt must
 * close: missing high-weight features, format mismatches, ignored
 * hidden intents, plan-step skips, etc.
 *
 * Inspired by Anthropic's chain-of-thought-faithfulness section: a
 * plausible-sounding response can still ignore the load-bearing context
 * that produced it. The loop pushes responsibility for catching that
 * onto the orchestrator rather than the model alone.
 *
 * Pure JS, no LLM call inside this module. Consumers wire it as:
 *   draft → scoreFaithfulness → if reject: buildRetryPlan → re-prompt
 *
 * Public API:
 *   reflect({ draft, faithfulnessScore, plan?, report?, opts? })
 *       → ReflectionVerdict
 *   buildRetryInstruction(verdict, opts?)
 *       → string (system-prompt addendum for the retry attempt)
 *
 * Verdict shape:
 *   {
 *     accept: boolean,
 *     verdict: 'accept' | 'retry_soft' | 'retry_strict' | 'escalate',
 *     score: number,                  – 0–1, the faithfulness score
 *     gaps: string[],                 – itemised issues with the draft
 *     retryInstructions?: string,     – present iff !accept
 *     retryCount: number,             – how many retries before this
 *     escalateReason?: string,        – present iff verdict === 'escalate'
 *   }
 */

const DEFAULT_ACCEPT_THRESHOLD = Number(process.env.SIRAGPT_REFLECTION_ACCEPT_THRESHOLD) || 0.65;
const DEFAULT_SOFT_THRESHOLD = Number(process.env.SIRAGPT_REFLECTION_SOFT_THRESHOLD) || 0.45;
const DEFAULT_MAX_RETRIES = Number(process.env.SIRAGPT_REFLECTION_MAX_RETRIES) || 2;

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Collect a per-component gap list from a faithfulness-scorer report.
 * Accepts both API shapes returned by the project's two scorer modules:
 *   • `faithfulness-scorer` (newer): { score, unsupported, numbers, …, advisory }
 *   • the legacy shape: { overall, components: { … }, reasons }
 */
function collectGaps(score = {}, plan = null, report = null) {
  const gaps = [];
  if (!score || typeof score !== 'object') return gaps;
  // newer shape
  if (Array.isArray(score.unsupported) && score.unsupported.length > 0) {
    for (const u of score.unsupported.slice(0, 5)) {
      gaps.push(`unsupported ${u.kind || 'claim'}: "${(u.text || '').slice(0, 80)}"`);
    }
  }
  if (Array.isArray(score.numbers)) {
    const wrong = score.numbers.filter((n) => n && n.supported === false);
    for (const n of wrong.slice(0, 3)) gaps.push(`unverified number: ${n.value}`);
  }
  if (typeof score.advisory === 'string' && score.advisory.length > 0) {
    gaps.push(score.advisory.slice(0, 160));
  }
  // legacy shape
  if (Array.isArray(score.reasons)) {
    for (const r of score.reasons.slice(0, 4)) gaps.push(String(r).slice(0, 160));
  }
  // plan-step coverage
  if (plan && Array.isArray(plan.nodes) && plan.nodes.length > 0) {
    const draftText = String(score?.responseText || '').toLowerCase();
    const missed = plan.nodes.filter((n) => {
      const tag = String(n.label || n.kind || '').toLowerCase().split(/\s+/)[0];
      return tag && !draftText.includes(tag);
    });
    if (missed.length > 0) {
      gaps.push(`plan steps not addressed: ${missed.slice(0, 4).map((n) => n.label || n.kind).join(', ')}`);
    }
  }
  // hidden-intent coverage from report
  if (report && Array.isArray(report.hiddenIntents) && report.hiddenIntents.length > 0) {
    gaps.push(`hidden intents present (${report.hiddenIntents.length}); make sure the response addresses them`);
  }
  return [...new Set(gaps)];
}

function classify(score, acceptThreshold = DEFAULT_ACCEPT_THRESHOLD, softThreshold = DEFAULT_SOFT_THRESHOLD) {
  const s = clamp01(score?.score ?? score?.overall ?? 0);
  if (s >= acceptThreshold) return { verdict: 'accept', score: s };
  if (s >= softThreshold) return { verdict: 'retry_soft', score: s };
  if (s >= softThreshold * 0.5) return { verdict: 'retry_strict', score: s };
  return { verdict: 'escalate', score: s };
}

function reflect({
  draft = '',
  faithfulnessScore = null,
  plan = null,
  report = null,
  retryCount = 0,
  opts = {},
} = {}) {
  const acceptThreshold = Number(opts.acceptThreshold) > 0 ? Number(opts.acceptThreshold) : DEFAULT_ACCEPT_THRESHOLD;
  const softThreshold = Number(opts.softThreshold) > 0 ? Number(opts.softThreshold) : DEFAULT_SOFT_THRESHOLD;
  const maxRetries = Number(opts.maxRetries) > 0 ? Number(opts.maxRetries) : DEFAULT_MAX_RETRIES;
  // Attach the draft text to the score so collectGaps can scan it for
  // plan-step coverage without us having to plumb a second arg through.
  const scoreWithDraft = faithfulnessScore && typeof faithfulnessScore === 'object'
    ? { ...faithfulnessScore, responseText: draft }
    : { score: 0, responseText: draft };
  const { verdict: rawVerdict, score } = classify(scoreWithDraft, acceptThreshold, softThreshold);
  const gaps = collectGaps(scoreWithDraft, plan, report);
  let verdict = rawVerdict;
  let accept = verdict === 'accept';
  let escalateReason = null;
  if (!accept && retryCount >= maxRetries) {
    verdict = 'escalate';
    accept = false;
    escalateReason = `retry budget exhausted (${retryCount}/${maxRetries})`;
  }
  const out = {
    accept,
    verdict,
    score: Number(score.toFixed(3)),
    gaps,
    retryCount,
  };
  if (!accept && verdict !== 'escalate') {
    out.retryInstructions = buildRetryInstruction({ ...out, ...{ verdict } });
  }
  if (escalateReason) out.escalateReason = escalateReason;
  return out;
}

function buildRetryInstruction(verdict, opts = {}) {
  if (!verdict || verdict.verdict === 'accept' || verdict.verdict === 'escalate') return '';
  const strict = verdict.verdict === 'retry_strict';
  const lines = ['\n\n<self_reflection_retry>'];
  lines.push(`El intento anterior obtuvo un puntaje de fidelidad de ${verdict.score} (umbral ${strict ? 'estricto' : 'suave'}).`);
  if (Array.isArray(verdict.gaps) && verdict.gaps.length > 0) {
    lines.push('Brechas detectadas que esta nueva versión DEBE cerrar:');
    for (const g of verdict.gaps.slice(0, 8)) lines.push(`  • ${g}`);
  }
  if (strict) {
    lines.push('Reglas estrictas para este re-intento:');
    lines.push('  1. Cita explícitamente las fuentes / contexto cuando hagas afirmaciones.');
    lines.push('  2. No introduzcas cifras ni entidades que no estén en el contexto.');
    lines.push('  3. Si una sub-intención fue ignorada, abórdala primero esta vez.');
    lines.push('  4. Si no puedes cumplir alguna brecha con la información disponible, dilo explícitamente.');
  } else {
    lines.push('Re-intento sugerido: refuerza las áreas listadas; no es necesario re-empezar desde cero.');
  }
  lines.push('</self_reflection_retry>');
  const text = lines.join('\n');
  const max = Number(opts.maxChars) || 1200;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

module.exports = {
  reflect,
  buildRetryInstruction,
  collectGaps,
  classify,
  DEFAULT_ACCEPT_THRESHOLD,
  DEFAULT_SOFT_THRESHOLD,
  DEFAULT_MAX_RETRIES,
};
