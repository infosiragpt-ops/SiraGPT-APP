'use strict';

/**
 * Lookahead Planner
 *
 * Inspired by the attribution-graphs paper finding that language models plan
 * ahead — e.g. choosing the rhyming word of a couplet before producing the
 * intermediate text. We do the same at the request level: given the current
 * user turn plus history, predict the most likely 1-3 follow-up turns and
 * pre-stage suggestions (tools, fetches, clarifications) for them.
 *
 * The planner is deterministic and heuristic; it never calls out to an LLM.
 * Patterns were chosen by surveying common SiraGPT chat-flow archetypes
 * (analyse → ask for chart → ask for summary; code → run → debug; etc.).
 */

const WORKFLOW_PATTERNS = Object.freeze([
  {
    id: 'analyze_then_visualize',
    triggers: [/analyz/i, /analiz/i, /review/i, /audit/i, /revis/i, /examina/i],
    nextSteps: [
      { label: 'Create a chart of the key findings', tool: 'create_chart', confidence: 0.7 },
      { label: 'Produce an executive summary', tool: 'create_document', confidence: 0.5 },
      { label: 'Identify risks or anomalies', tool: 'deep-document-analyzer', confidence: 0.55 },
    ],
  },
  {
    id: 'visualize_then_explain',
    triggers: [/chart/i, /gráf/i, /grafi/i, /diagram/i, /diagrama/i, /visual/i, /dashboard/i],
    nextSteps: [
      { label: 'Walk through what the chart shows', tool: null, confidence: 0.65 },
      { label: 'Compare with previous period or peer', tool: 'create_comparison_table', confidence: 0.5 },
      { label: 'Adjust chart styling or labels', tool: 'create_chart', confidence: 0.45 },
    ],
  },
  {
    id: 'code_then_test',
    triggers: [/implement/i, /implementa/i, /code/i, /codigo/i, /script/i, /function/i, /refactor/i],
    nextSteps: [
      { label: 'Run unit tests or sanity checks', tool: 'code-sandbox', confidence: 0.75 },
      { label: 'Add error handling and edge cases', tool: null, confidence: 0.55 },
      { label: 'Wire into existing modules or routes', tool: null, confidence: 0.5 },
    ],
  },
  {
    id: 'search_then_synthesize',
    triggers: [/search/i, /busca/i, /find/i, /encuentra/i, /research/i, /investiga/i],
    nextSteps: [
      { label: 'Synthesise findings into a brief', tool: 'analysis-pipeline', confidence: 0.7 },
      { label: 'Cite sources and verify provenance', tool: null, confidence: 0.65 },
      { label: 'Compare findings across sources', tool: 'create_comparison_table', confidence: 0.5 },
    ],
  },
  {
    id: 'summarize_then_extract',
    triggers: [/summarize/i, /resume/i, /resumir/i, /resumen/i, /tl;dr/i],
    nextSteps: [
      { label: 'Extract action items or decisions', tool: 'document-pipeline', confidence: 0.6 },
      { label: 'Highlight key numbers and dates', tool: 'extract_data', confidence: 0.55 },
      { label: 'Translate the summary', tool: 'translate-content', confidence: 0.4 },
    ],
  },
  {
    id: 'translate_then_localize',
    triggers: [/translate/i, /traduce/i, /traducir/i, /idioma/i],
    nextSteps: [
      { label: 'Localize tone for the target audience', tool: null, confidence: 0.55 },
      { label: 'Produce side-by-side comparison', tool: 'create_comparison_table', confidence: 0.4 },
    ],
  },
  {
    id: 'compare_then_decide',
    triggers: [/compare/i, /compara/i, /vs\b/i, /versus/i, /diff/i, /pros\s+(?:and|y)\s+cons/i],
    nextSteps: [
      { label: 'Recommend an option with rationale', tool: null, confidence: 0.75 },
      { label: 'Build a decision matrix', tool: 'create_chart', confidence: 0.5 },
      { label: 'Run sensitivity analysis', tool: 'analysis-pipeline', confidence: 0.4 },
    ],
  },
  {
    id: 'plan_then_break_down',
    triggers: [/plan/i, /roadmap/i, /strategy/i, /estrategia/i],
    nextSteps: [
      { label: 'Break the plan into milestones', tool: 'create_timeline', confidence: 0.7 },
      { label: 'Assign owners and dependencies', tool: 'create_raci_matrix', confidence: 0.55 },
      { label: 'Spot risks and mitigations', tool: 'create_risk_matrix', confidence: 0.55 },
    ],
  },
  {
    id: 'draft_then_review',
    triggers: [/draft/i, /redacta/i, /write/i, /escribe/i, /email/i, /correo/i],
    nextSteps: [
      { label: 'Tighten tone and wording', tool: null, confidence: 0.65 },
      { label: 'Add a subject line or call to action', tool: null, confidence: 0.6 },
      { label: 'Translate to another language', tool: 'translate-content', confidence: 0.35 },
    ],
  },
  {
    id: 'troubleshoot_then_fix',
    triggers: [/error/i, /fail/i, /falla/i, /not working/i, /no funciona/i, /broken/i, /roto/i, /bug/i, /stuck/i, /atascado/i],
    nextSteps: [
      { label: 'Reproduce locally and capture logs', tool: null, confidence: 0.7 },
      { label: 'Apply a targeted fix', tool: 'agent-tools', confidence: 0.65 },
      { label: 'Add a regression test', tool: 'code-sandbox', confidence: 0.55 },
    ],
  },
]);

function clamp(value, min = 0, max = 1) {
  if (value == null || Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function matchPatterns(query) {
  if (!query || typeof query !== 'string') return [];
  const matches = [];
  for (const pattern of WORKFLOW_PATTERNS) {
    for (const trigger of pattern.triggers) {
      if (trigger.test(query)) {
        matches.push({ patternId: pattern.id, nextSteps: pattern.nextSteps });
        break;
      }
    }
  }
  return matches;
}

function scoreFromHistory(history, candidate) {
  if (!Array.isArray(history) || history.length === 0) return 0;
  let score = 0;
  const flat = history
    .map((h) => (typeof h === 'string' ? h : h?.content || ''))
    .join(' ')
    .toLowerCase();
  if (candidate.tool && flat.includes(candidate.tool.toLowerCase())) score += 0.1;
  if (candidate.label && flat.includes(candidate.label.toLowerCase().slice(0, 10))) score -= 0.15;
  return score;
}

function planNextSteps(query, context = {}) {
  const matches = matchPatterns(query);
  const merged = new Map();

  for (const match of matches) {
    for (const step of match.nextSteps) {
      const key = `${step.label}::${step.tool || ''}`;
      const existing = merged.get(key);
      const historyAdj = scoreFromHistory(context.history, step);
      const weight = clamp((step.confidence || 0.5) + historyAdj);
      if (!existing) {
        merged.set(key, {
          label: step.label,
          tool: step.tool,
          confidence: weight,
          fromPatterns: [match.patternId],
        });
      } else {
        existing.confidence = clamp(existing.confidence + weight * 0.4);
        existing.fromPatterns.push(match.patternId);
      }
    }
  }

  const steps = [...merged.values()]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3)
    .map((s) => ({
      ...s,
      confidence: Number(s.confidence.toFixed(3)),
    }));

  return {
    matchedPatterns: matches.map((m) => m.patternId),
    nextSteps: steps,
    confidence: steps.length ? steps[0].confidence : 0,
  };
}

function buildLookaheadPrompt(plan, opts = {}) {
  if (!plan || !plan.nextSteps?.length) return '';
  const lines = ['### Lookahead Planner'];
  lines.push('Likely next user requests (based on workflow heuristics):');
  for (const step of plan.nextSteps) {
    const conf = Math.round(step.confidence * 100);
    const tool = step.tool ? ` — tool: \`${step.tool}\`` : '';
    lines.push(`- ${step.label} (${conf}%)${tool}`);
  }
  if (opts.proactiveHints !== false) {
    lines.push(
      'If the user keeps going in this direction, offer one of these as a follow-up rather than waiting to be asked.',
    );
  }
  return lines.join('\n');
}

module.exports = {
  WORKFLOW_PATTERNS,
  matchPatterns,
  planNextSteps,
  buildLookaheadPrompt,
};
