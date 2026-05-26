'use strict';

/**
 * attribution-executive-summary.js
 *
 * Meta-summarizer over the full attribution stack. Takes the engine
 * bundle, quality score, skill recommendation, confidence aggregator,
 * and anti-pattern detection, and produces a single human-readable
 * 'I understood you want X; confidence Y; recommended action Z' message
 * for transparent AI UX.
 *
 * Designed for:
 *   - chat composer "preview" — show the user what the system thinks
 *     before they hit send
 *   - sidebar "system understanding" widget
 *   - logs/audits where a one-line summary is more useful than the
 *     full bundle
 *
 * No LLM. Pure templating + light synthesis.
 */

const promptQualityScorer = require('./attribution-prompt-quality-scorer');
const skillRecommender = require('./attribution-skill-recommender');
const confidenceAggregator = require('./attribution-confidence-aggregator');
const antipatternDetector = require('./attribution-anti-pattern-detector');
const suite = require('./attribution-suite');

function safeText(v) { return String(v == null ? '' : v); }

function buildSummary({
  prompt = '',
  history = [],
  files = [],
  memories = [],
  ragSnippets = [],
  userProfile = null,
  draftResponse = null,
} = {}) {
  if (!safeText(prompt).trim()) {
    return {
      headline: 'No prompt — nothing to interpret.',
      detail: '',
      verdict: 'allow',
      confidenceGrade: 'F',
      qualityGrade: 'F',
      recommendation: null,
      recommendedSkill: null,
    };
  }

  const bundle = suite.run({ prompt, history, files, memories, ragSnippets, userProfile, draftResponse });
  const quality = promptQualityScorer.score({ prompt });
  const skill = skillRecommender.recommend({ prompt, engineBundle: bundle.engine });
  const ap = antipatternDetector.detect({ history });
  const conf = confidenceAggregator.aggregate({
    engineBundle: bundle.engine,
    safetyResult: bundle.safety,
    driftObservation: bundle.drift,
    beliefResult: bundle.beliefs,
    faithfulness: bundle.engine?.faithfulness || null,
    antipatternResult: ap,
  });

  const primaryIntent = bundle.telemetry?.primaryIntent || skill.primary?.id || 'general assistance';
  const verdict = bundle.verdict || 'allow';
  const headline = composeHeadline({ primaryIntent, verdict, conf, skill, quality });
  const detail = composeDetail({ bundle, conf, ap, quality, skill });

  return {
    headline,
    detail,
    verdict,
    confidenceGrade: conf.grade,
    confidenceScore: conf.score,
    qualityGrade: quality.grade,
    qualityScore: quality.score,
    recommendation: conf.recommendation,
    recommendedSkill: skill.primary,
    hasAntipattern: ap.hasAntipattern,
    antipatternKinds: ap.patterns.map((p) => p.kind),
    metrics: {
      multiHopDepth: bundle.telemetry?.multiHopDepth || 0,
      planNodes: bundle.telemetry?.planNodes || 0,
      conflicts: bundle.telemetry?.conflicts || 0,
      driftClass: bundle.telemetry?.driftClass || 'baseline',
      beliefsObserved: bundle.telemetry?.beliefsObserved || 0,
      beliefsContradicted: bundle.telemetry?.beliefsContradicted || 0,
    },
  };
}

function composeHeadline({ primaryIntent, verdict, conf, skill, quality }) {
  if (verdict === 'refuse') return `Cannot proceed safely with this request (confidence ${conf.grade}).`;
  if (verdict === 'route_to_human') return `Recommend handing off to a human or qualified professional (confidence ${conf.grade}).`;
  if (verdict === 'caution') return `Proceeding with caution. Primary intent: ${primaryIntent} (confidence ${conf.grade}).`;
  if (skill.primary) return `I'll handle this with **${skill.primary.id}** — intent ${primaryIntent} (confidence ${conf.grade}, quality ${quality.grade}).`;
  return `Primary intent: ${primaryIntent} (confidence ${conf.grade}, quality ${quality.grade}).`;
}

function composeDetail({ bundle, conf, ap, quality, skill }) {
  const lines = [];
  if (quality.suggestions && quality.suggestions.length) {
    lines.push(`Prompt suggestions: ${quality.suggestions.slice(0, 2).join(' / ')}`);
  }
  if (skill.alternatives && skill.alternatives.length) {
    lines.push(`Alternatives considered: ${skill.alternatives.slice(0, 2).map((a) => a.id).join(', ')}`);
  }
  if (ap.hasAntipattern) {
    lines.push(`Anti-pattern: ${ap.patterns.map((p) => p.kind).join(', ')} — ${ap.patterns[0]?.recommendation || ''}`);
  }
  if (bundle.telemetry?.conflicts) {
    lines.push(`Suppression conflicts: ${bundle.telemetry.conflicts} (confirm whether the new request overrides prior rules).`);
  }
  if (bundle.telemetry?.multiHopDepth > 0) {
    lines.push(`Multi-hop depth: ${bundle.telemetry.multiHopDepth} — resolve referents before answering.`);
  }
  lines.push(`Recommended action: ${conf.recommendation}`);
  return lines.join('\n');
}

function buildExecutiveBlock(summary) {
  if (!summary) return '';
  const lines = ['## EXECUTIVE SUMMARY'];
  lines.push(summary.headline);
  if (summary.detail) lines.push('', summary.detail);
  return lines.join('\n');
}

module.exports = {
  buildSummary,
  buildExecutiveBlock,
};
