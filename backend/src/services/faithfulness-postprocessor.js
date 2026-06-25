'use strict';

/**
 * faithfulness-postprocessor.js
 *
 * Closes the hallucination-detection loop. Given a generated assistant
 * response and the same context that produced it, this module:
 *
 *   1. Scores faithfulness via `faithfulness-scorer`.
 *   2. If the grade is C or better, returns the response untouched.
 *   3. If the grade is D / F, builds a structured "repair instruction"
 *      that the AI route can either:
 *        - append as a hidden system message and ask the model to
 *          regenerate (high-friction, only when blocking);
 *        - attach to the response as a "self-check" footer for the
 *          client (low-friction, default).
 *
 * Inspired by Anthropic's circuit-tracing finding that hallucinations
 * arise when a "default answer" circuit fires without being suppressed
 * by a "known-entity" check. We can't suppress the circuit, but we can
 * detect when its output is ungrounded and surface a repair signal.
 *
 * No LLM call. Pure heuristic; cost is the same as the underlying
 * scorer (< 5 ms on a 4 KB response).
 */

const faithfulnessScorer = require('./faithfulness-scorer');

const DEFAULT_THRESHOLD = Number.parseFloat(process.env.SIRAGPT_FAITHFULNESS_THRESHOLD || '0.55');
const DEFAULT_MAX_UNGROUNDED_TO_LIST = 8;

function postprocess({
  response = '',
  context = [],
  mode = 'annotate',
  threshold = DEFAULT_THRESHOLD,
  maxUngroundedToList = DEFAULT_MAX_UNGROUNDED_TO_LIST,
} = {}) {
  const report = faithfulnessScorer.scoreFaithfulness({ response, context });

  // Empty response: nothing to do.
  if (report.empty) {
    return { ok: true, action: 'none', report, response, repair: null };
  }

  // No grounding context: faithfulness is undefined here. Every claim scores as
  // "unsupported" only because there was nothing to check against (score → 0),
  // so gating would slap a false "ungrounded" footer on a context-free turn
  // (general conversation, the model's own knowledge). Skip the gate.
  if (report.hasContext === false) {
    return { ok: true, action: 'none', report, response, repair: null };
  }

  const passed = report.score >= threshold;
  if (passed) {
    return { ok: true, action: 'pass', report, response, repair: null };
  }

  const repair = buildRepairInstruction(report, { maxUngroundedToList });

  if (mode === 'regenerate') {
    return {
      ok: false,
      action: 'regenerate',
      report,
      response,
      repair,
      systemAddendum: repair.systemAddendum,
    };
  }

  // mode === 'annotate' (default).
  const annotated = `${response}\n\n${repair.userFooter}`;
  return {
    ok: false,
    action: 'annotate',
    report,
    response: annotated,
    repair,
  };
}

function buildRepairInstruction(report, opts = {}) {
  const ungrounded = (report.unsupported || []).slice(0, opts.maxUngroundedToList);
  const numbersFlagged = ungrounded.filter((u) => u.kind === 'number').map((u) => u.text);
  const urlsFlagged = ungrounded.filter((u) => u.kind === 'url').map((u) => u.text);
  const entitiesFlagged = ungrounded.filter((u) => u.kind === 'entity').map((u) => u.text);
  const claimsFlagged = ungrounded.filter((u) => u.kind === 'claim').map((u) => u.text);

  const userFooter = renderUserFooter({ report, numbersFlagged, urlsFlagged, entitiesFlagged, claimsFlagged });
  const systemAddendum = renderSystemAddendum({ report, ungrounded });

  return {
    grade: report.grade,
    score: report.score,
    advisory: report.advisory,
    flaggedCounts: {
      numbers: numbersFlagged.length,
      urls: urlsFlagged.length,
      entities: entitiesFlagged.length,
      claims: claimsFlagged.length,
      total: ungrounded.length,
    },
    userFooter,
    systemAddendum,
  };
}

function renderUserFooter({ report, numbersFlagged, urlsFlagged, entitiesFlagged, claimsFlagged }) {
  const lines = [];
  lines.push('---');
  lines.push(`> ⚠️ Auto-fidelity check: ${report.grade} (${report.score}). ${report.advisory}`);
  if (numbersFlagged.length) {
    lines.push(`> Numbers not found in provided context: ${numbersFlagged.slice(0, 6).join(', ')}.`);
  }
  if (urlsFlagged.length) {
    lines.push(`> URLs not found in provided context: ${urlsFlagged.slice(0, 4).join(', ')}.`);
  }
  if (entitiesFlagged.length) {
    lines.push(`> Named entities not found in provided context: ${entitiesFlagged.slice(0, 6).join(', ')}.`);
  }
  if (claimsFlagged.length) {
    lines.push(`> Claims with low context overlap: ${claimsFlagged.length} sentence(s).`);
  }
  lines.push('> Treat the items above as unverified until confirmed from the source.');
  return lines.join('\n');
}

function renderSystemAddendum({ report, ungrounded }) {
  if (!ungrounded.length) return '';
  const lines = [];
  lines.push('## REGENERATION REQUEST — FAITHFULNESS CHECK FAILED');
  lines.push(`Previous draft scored ${report.score} (grade ${report.grade}). Regenerate with strict grounding.`);
  lines.push('Mandatory rules for the next attempt:');
  lines.push('1. Quote every number, URL, named entity, file path, and email from the provided context — do not invent any.');
  lines.push('2. If a fact is not present in the context, say so explicitly ("the context does not mention X") instead of guessing.');
  lines.push('3. Add inline citations (file/source identifiers) for every non-trivial claim.');
  lines.push('');
  lines.push('Items flagged as ungrounded in the previous draft:');
  for (const u of ungrounded.slice(0, 12)) {
    lines.push(`- [${u.kind}/${u.severity}] ${u.text}`);
  }
  return lines.join('\n');
}

module.exports = {
  postprocess,
  buildRepairInstruction,
  DEFAULT_THRESHOLD,
};
