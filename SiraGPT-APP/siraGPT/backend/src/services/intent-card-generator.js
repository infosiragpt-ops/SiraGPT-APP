'use strict';

/**
 * Intent Card Generator
 *
 * Consolidates the full context-intelligence pipeline output (10+ subsystems)
 * into a single compact "User Intent Card" — a structured summary of what
 * the system believes the user wants, with confidence, alternatives, and
 * suggested next actions.
 *
 * This is the user-facing distillation of every attribution-graph signal
 * the engine extracted on a turn: surface verb, subject, deeper motivation,
 * blockers, suggested clarifications, and predicted follow-ups. Designed to
 * be:
 *
 *   - logged into telemetry on every turn (for offline calibration analysis)
 *   - optionally rendered as a hover-card or inline note in the UI without
 *     coupling to any frontend component (UI rules forbid UI edits — this
 *     module only produces the JSON shape)
 *   - sent back to the user as confirmation when confidence is borderline
 *
 * Heuristic-only, no LLM. Takes a context-intelligence report (the output
 * of context-intelligence-engine.analyzeContext) plus optional
 * conversation-arc-summarizer output and returns a compact, stable
 * IntentCard shape.
 */

const CARD_VERSION = '1.0';

const SEVERITY_BY_CATEGORY = Object.freeze({
  clarification: 'medium',
  grounding: 'high',
  faithfulness: 'high',
  entities: 'high',
  lookahead: 'low',
  coreference: 'medium',
  domain_shift: 'low',
  hidden_goal: 'info',
  robustness: 'high',
  intent: 'info',
});

function clamp(value, min = 0, max = 1) {
  if (value == null || Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function shorten(value, max = 120) {
  if (value == null) return '';
  const s = String(value);
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function buildHeadline(report, arc) {
  if (arc && !arc.empty && arc.sentence) return shorten(arc.sentence, 200);
  const verb = report?.attributionGraph?.primaryIntent?.kind || 'engage with';
  const conf = Math.round((report?.attributionGraph?.confidence ?? 0) * 100);
  return `User likely wants to ${verb} (${conf}% confidence).`;
}

function buildAlternatives(report) {
  const intents = report?.attributionGraph?.intents;
  if (!Array.isArray(intents) || intents.length < 2) return [];
  return intents
    .slice(1, 4)
    .map((i) => ({ kind: i.kind, confidence: Number((i.weight || 0).toFixed(3)) }));
}

function buildBlockers(report, arc) {
  const out = new Set();
  if (Array.isArray(arc?.blockers)) {
    arc.blockers.forEach((b) => out.add(b));
  }
  if (Array.isArray(report?.multiHop?.missingPrerequisites)) {
    report.multiHop.missingPrerequisites.forEach((p) => out.add(p));
  }
  if (report?.crossTurn?.needsCorefResolution) out.add('unresolved_reference');
  if (report?.counterfactual?.verdict === 'brittle' || report?.counterfactual?.verdict === 'unstable') {
    out.add('brittle_intent');
  }
  if (report?.knowledgeBoundary?.severity === 'high') out.add('ungrounded_claims');
  if (report?.entityGrounding?.severity === 'high') out.add('ungrounded_entities');
  if (report?.reasoningFaithfulness?.severity === 'high') out.add('unfaithful_reasoning');
  return [...out];
}

function buildClarifications(report) {
  const out = [];
  if (report?.hiddenGoal?.needsClarification && report.hiddenGoal.clarifyingQuestion) {
    out.push({
      reason: 'hidden_goal_ambiguous',
      question: shorten(report.hiddenGoal.clarifyingQuestion, 240),
    });
  }
  if (report?.multiHop?.needsClarification) {
    out.push({
      reason: 'request_under_specified',
      question: '¿Puedes confirmar el alcance / formato esperado antes de empezar?',
    });
  }
  if (report?.crossTurn?.needsCorefResolution) {
    const refs = report.crossTurn.unresolvedCoreferences || [];
    const sample = refs[0]?.reference || 'la referencia anterior';
    out.push({
      reason: 'coreference_ambiguous',
      question: `¿A qué te refieres con "${shorten(sample, 60)}"?`,
    });
  }
  return out;
}

function buildSuggestedActions(report) {
  const out = [];
  if (Array.isArray(report?.lookahead?.nextSteps)) {
    for (const step of report.lookahead.nextSteps.slice(0, 3)) {
      out.push({
        label: shorten(step.label, 120),
        tool: step.tool || null,
        confidence: Number((step.confidence || 0).toFixed(3)),
      });
    }
  }
  return out;
}

function buildEvidence(report) {
  const top = report?.attributionGraph?.signals
    ? [...report.attributionGraph.signals]
        .sort((a, b) => (b.weight || 0) - (a.weight || 0))
        .slice(0, 5)
        .map((s) => ({
          type: s.type,
          value: shorten(typeof s.value === 'string' ? s.value : String(s.value), 100),
          weight: Number((s.weight || 0).toFixed(3)),
        }))
    : [];
  return top;
}

function buildRiskFlags(report) {
  const flags = [];
  if (report?.knowledgeBoundary?.severity === 'high') {
    flags.push({ kind: 'knowledge_boundary', severity: 'high', score: report.knowledgeBoundary.riskScore });
  }
  if (report?.entityGrounding?.severity === 'high') {
    flags.push({ kind: 'entity_grounding', severity: 'high', score: report.entityGrounding.groundingRate });
  }
  if (report?.reasoningFaithfulness?.severity === 'high') {
    flags.push({ kind: 'reasoning_faithfulness', severity: 'high', score: report.reasoningFaithfulness.faithfulness });
  }
  if (report?.counterfactual?.verdict === 'brittle' || report?.counterfactual?.verdict === 'unstable') {
    flags.push({ kind: 'robustness', severity: 'high', verdict: report.counterfactual.verdict });
  }
  return flags;
}

function classifyAction(report, blockers, clarifications) {
  if (clarifications.length > 0) return 'ask_clarifying_question';
  if (blockers.length >= 2) return 'gather_prerequisites_first';
  if (report?.knowledgeBoundary?.severity === 'high') return 'hedge_or_verify';
  if (report?.entityGrounding?.severity === 'high') return 'verify_entities';
  if (report?.attributionGraph?.confidence >= 0.7) return 'proceed_with_answer';
  return 'proceed_with_hedging';
}

function generate(report, opts = {}) {
  if (!report || typeof report !== 'object') {
    return {
      version: CARD_VERSION,
      empty: true,
      headline: '',
      confidence: 0,
      primaryIntent: null,
      alternatives: [],
      motivation: null,
      blockers: [],
      clarifications: [],
      suggestedActions: [],
      riskFlags: [],
      evidence: [],
      recommendedAction: 'gather_more_context',
      generatedAt: Date.now(),
    };
  }

  const arc = opts.arc || null;
  const blockers = buildBlockers(report, arc);
  const clarifications = buildClarifications(report);
  const suggestedActions = buildSuggestedActions(report);
  const evidence = buildEvidence(report);
  const riskFlags = buildRiskFlags(report);
  const alternatives = buildAlternatives(report);
  const recommendedAction = classifyAction(report, blockers, clarifications);

  return {
    version: CARD_VERSION,
    empty: false,
    headline: buildHeadline(report, arc),
    confidence: Number((report?.confidence ?? report?.attributionGraph?.confidence ?? 0).toFixed(3)),
    primaryIntent: report?.attributionGraph?.primaryIntent?.kind || null,
    alternatives,
    motivation: report?.hiddenGoal?.topCandidate?.name || null,
    motivationConfidence: report?.hiddenGoal?.topCandidate?.score || null,
    arcSentence: arc?.sentence || null,
    blockers,
    clarifications,
    suggestedActions,
    riskFlags,
    evidence,
    recommendedAction,
    severities: {
      knowledgeBoundary: report?.knowledgeBoundary?.severity || null,
      entityGrounding: report?.entityGrounding?.severity || null,
      reasoningFaithfulness: report?.reasoningFaithfulness?.severity || null,
      counterfactual: report?.counterfactual?.verdict || null,
    },
    elapsedMs: report?.elapsedMs || null,
    generatedAt: Date.now(),
  };
}

function buildIntentCardPrompt(card, opts = {}) {
  if (!card || card.empty) return '';
  const lines = ['### Intent Card'];
  lines.push(card.headline);
  if (card.motivation) {
    lines.push(`Motivation: ${card.motivation.replace(/_/g, ' ')}`);
  }
  if (card.blockers.length > 0) {
    lines.push(`Blockers: ${card.blockers.join(', ')}`);
  }
  if (card.clarifications.length > 0 && opts.includeClarifications !== false) {
    lines.push('Clarifications you could ask:');
    for (const c of card.clarifications.slice(0, 2)) {
      lines.push(`- ${c.question}`);
    }
  }
  if (card.suggestedActions.length > 0 && opts.includeActions !== false) {
    lines.push(`Next likely action: ${card.suggestedActions[0].label}`);
  }
  lines.push(`Recommended posture: ${card.recommendedAction.replace(/_/g, ' ')}.`);
  return lines.join('\n');
}

function diff(prevCard, currentCard) {
  if (!prevCard || !currentCard || prevCard.empty || currentCard.empty) {
    return { changed: false, fields: [] };
  }
  const changes = [];
  if (prevCard.primaryIntent !== currentCard.primaryIntent) {
    changes.push({ field: 'primaryIntent', from: prevCard.primaryIntent, to: currentCard.primaryIntent });
  }
  if (prevCard.motivation !== currentCard.motivation) {
    changes.push({ field: 'motivation', from: prevCard.motivation, to: currentCard.motivation });
  }
  if (prevCard.recommendedAction !== currentCard.recommendedAction) {
    changes.push({ field: 'recommendedAction', from: prevCard.recommendedAction, to: currentCard.recommendedAction });
  }
  const blockerSetA = new Set(prevCard.blockers || []);
  const blockerSetB = new Set(currentCard.blockers || []);
  const added = [...blockerSetB].filter((b) => !blockerSetA.has(b));
  const removed = [...blockerSetA].filter((b) => !blockerSetB.has(b));
  if (added.length || removed.length) {
    changes.push({ field: 'blockers', added, removed });
  }
  return { changed: changes.length > 0, fields: changes };
}

module.exports = {
  CARD_VERSION,
  SEVERITY_BY_CATEGORY,
  generate,
  buildIntentCardPrompt,
  diff,
};
