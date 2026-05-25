'use strict';

/**
 * Conversation Arc Summarizer
 *
 * Compresses a multi-turn conversation into a one-line statement of what
 * the user is trying to accomplish ("the arc"). It threads together:
 *
 *   - the recurring entities across turns (the SUBJECT)
 *   - the dominant intent kind (analyze / generate / decide / …) — the VERB
 *   - the recurring hidden goal (decide_whether_to_read, troubleshoot, …)
 *     — the underlying MOTIVATION
 *   - any active prerequisite gaps (missing data, ambiguous references) —
 *     the BLOCKERS
 *
 * Inspired by the attribution-graphs paper's "long-range circuit" view:
 * many features fire in a single token but only a handful summarise the
 * downstream behaviour. We pick the handful for the WHOLE conversation.
 *
 * Heuristic-only and dependency-light: takes a list of cross-turn / hidden
 * goal / multi-hop reports already produced by the context-intelligence
 * engine and returns a structured arc + a human-readable sentence.
 */

const VERB_TEMPLATES = Object.freeze({
  analyze: 'analyse',
  review: 'review',
  generate: 'produce',
  search: 'find',
  summarize: 'summarise',
  translate: 'translate',
  compare: 'compare',
  extract: 'extract',
  explain: 'explain',
  code: 'build code for',
  plan: 'plan',
  visualize: 'visualise',
  converse: 'discuss',
});

const HIDDEN_GOAL_TEMPLATES = Object.freeze({
  decide_whether_to_read: 'decide whether the source is worth reading',
  spot_risks_or_red_flags: 'spot risks and red flags',
  compare_against_peers: 'compare against peers or alternatives',
  make_a_decision: 'reach a concrete decision',
  understand_a_concept: 'build a clean mental model of the topic',
  troubleshoot_a_problem: 'unblock a specific failure',
  persuade_or_pitch: 'persuade an audience',
  extract_actionables: 'extract clear next steps',
  validate_a_belief: 'validate a working belief',
  produce_deliverable: 'ship a concrete deliverable',
  plan_a_workflow: 'plan a workflow',
  learn_to_do_it_myself: 'learn to do it independently',
});

function clamp(value, min = 0, max = 1) {
  if (value == null || Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function tally(map, key, weight = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + weight);
}

function topByCount(map, limit = 3) {
  return [...map.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([key, count]) => ({ key, count: Number(count.toFixed(3)) }));
}

function dedupeStrings(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const norm = String(v || '').trim();
    if (!norm || seen.has(norm.toLowerCase())) continue;
    seen.add(norm.toLowerCase());
    out.push(norm);
  }
  return out;
}

function summarize(turnReports = [], opts = {}) {
  if (!Array.isArray(turnReports) || turnReports.length === 0) {
    return {
      empty: true,
      arc: null,
      subject: [],
      verb: null,
      motivation: null,
      blockers: [],
      confidence: 0,
      sentence: '',
    };
  }

  const subjectTally = new Map();
  const verbTally = new Map();
  const motivationTally = new Map();
  const blockers = [];

  let confidenceSum = 0;
  let confidenceN = 0;

  for (const report of turnReports) {
    if (!report || typeof report !== 'object') continue;

    if (Array.isArray(report.crossTurn?.currentFingerprint?.entities)) {
      for (const e of report.crossTurn.currentFingerprint.entities) tally(subjectTally, e);
    }
    if (Array.isArray(report.entityGrounding?.entities)) {
      for (const e of report.entityGrounding.entities) {
        if (e?.kind === 'proper_noun' || e?.kind === 'url' || e?.kind === 'acronym') {
          tally(subjectTally, e.value);
        }
      }
    }

    const intent = report.attributionGraph?.primaryIntent?.kind;
    if (intent) tally(verbTally, intent, report.attributionGraph?.confidence ?? 0.5);

    const hidden = report.hiddenGoal?.topCandidate?.name;
    if (hidden) tally(motivationTally, hidden, report.hiddenGoal?.topCandidate?.score ?? 0.5);

    if (Array.isArray(report.multiHop?.missingPrerequisites)) {
      for (const p of report.multiHop.missingPrerequisites) blockers.push(p);
    }
    if (report.crossTurn?.needsCorefResolution) {
      blockers.push('unresolved_reference');
    }
    if (report.counterfactual?.verdict === 'brittle' || report.counterfactual?.verdict === 'unstable') {
      blockers.push('brittle_intent');
    }

    if (typeof report.confidence === 'number') {
      confidenceSum += report.confidence;
      confidenceN += 1;
    }
  }

  const topSubjects = topByCount(subjectTally, opts.subjectLimit || 3).map((s) => s.key);
  const topVerb = topByCount(verbTally, 1)[0]?.key || null;
  const topMotivation = topByCount(motivationTally, 1)[0]?.key || null;
  const uniqueBlockers = dedupeStrings(blockers);

  const confidence = confidenceN > 0 ? Number((confidenceSum / confidenceN).toFixed(3)) : 0;

  const verb = topVerb && VERB_TEMPLATES[topVerb] ? VERB_TEMPLATES[topVerb] : 'engage with';
  const motivationPhrase = topMotivation
    ? HIDDEN_GOAL_TEMPLATES[topMotivation] || topMotivation.replace(/_/g, ' ')
    : null;
  const subjectPhrase = topSubjects.length > 0
    ? topSubjects.slice(0, 2).join(' & ')
    : 'the current topic';

  let sentence;
  if (motivationPhrase) {
    sentence = `User wants to ${verb} ${subjectPhrase} so they can ${motivationPhrase}.`;
  } else {
    sentence = `User wants to ${verb} ${subjectPhrase}.`;
  }
  if (uniqueBlockers.length > 0) {
    sentence += ` Open blockers: ${uniqueBlockers.slice(0, 3).join(', ')}.`;
  }

  return {
    empty: false,
    arc: {
      subject: topSubjects,
      verb: topVerb,
      motivation: topMotivation,
      blockers: uniqueBlockers,
    },
    subject: topSubjects,
    verb: topVerb,
    motivation: topMotivation,
    blockers: uniqueBlockers,
    confidence,
    turnCount: turnReports.length,
    sentence,
  };
}

function buildArcPrompt(arc, opts = {}) {
  if (!arc || arc.empty) return '';
  const lines = ['### Conversation Arc'];
  lines.push(`Overall direction (${arc.turnCount} turn${arc.turnCount === 1 ? '' : 's'}, confidence ${Math.round((arc.confidence || 0) * 100)}%): ${arc.sentence}`);
  if (opts.includeDetail !== false) {
    if (arc.subject?.length) lines.push(`- Subjects: ${arc.subject.join(', ')}`);
    if (arc.verb) lines.push(`- Verb: ${arc.verb}`);
    if (arc.motivation) lines.push(`- Underlying motivation: ${arc.motivation.replace(/_/g, ' ')}`);
    if (arc.blockers?.length) lines.push(`- Blockers: ${arc.blockers.join(', ')}`);
  }
  lines.push('Keep responses aligned with this arc; flag explicitly if the user is shifting it.');
  return lines.join('\n');
}

function detectArcShift(prevArc, currentArc) {
  if (!prevArc || prevArc.empty || !currentArc || currentArc.empty) {
    return { shifted: false, reason: 'insufficient_data' };
  }
  const verbShift = prevArc.verb && currentArc.verb && prevArc.verb !== currentArc.verb;
  const motivationShift = prevArc.motivation && currentArc.motivation && prevArc.motivation !== currentArc.motivation;
  const subjectOverlap = (prevArc.subject || []).filter((s) =>
    (currentArc.subject || []).some((c) => c.toLowerCase() === s.toLowerCase()),
  ).length;
  const subjectShift = (prevArc.subject?.length || 0) > 0 && subjectOverlap === 0;

  const reasons = [];
  if (verbShift) reasons.push(`verb ${prevArc.verb} → ${currentArc.verb}`);
  if (motivationShift) reasons.push(`motivation ${prevArc.motivation} → ${currentArc.motivation}`);
  if (subjectShift) reasons.push('subjects fully changed');

  return {
    shifted: reasons.length > 0,
    reason: reasons.length ? reasons.join('; ') : 'none',
    verbShift,
    motivationShift,
    subjectShift,
  };
}

module.exports = {
  VERB_TEMPLATES,
  HIDDEN_GOAL_TEMPLATES,
  summarize,
  buildArcPrompt,
  detectArcShift,
};
