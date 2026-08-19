'use strict';

const { buildLiteratureReview } = require('./literature-review-engine');
const {
  buildSystematicReviewAudit,
  critiqueEvidence,
  verifyScientificCitations,
} = require('./research-quality-agents');

function systematicQuery(query) {
  const value = String(query || '').trim();
  if (!value) return '';
  return /\brevisi[oó]n sistem[aá]tica\b|\bsystematic review\b|\bprisma\b/i.test(value)
    ? value
    : `Revisión sistemática: ${value}`;
}

async function runSystematicReviewAgent(query, options = {}) {
  const normalized = String(query || '').trim();
  if (!normalized) throw new TypeError('query is required');
  const buildReview = typeof options.buildReview === 'function' ? options.buildReview : buildLiteratureReview;
  const { buildReview: _ignored, onStage, ...reviewOptions } = options;
  if (typeof onStage === 'function') onStage({ type: 'agent_stage', stage: 'strategy', status: 'running' });
  const review = await buildReview(systematicQuery(normalized), reviewOptions);
  const evidenceCritic = review.agents?.evidenceCritic || critiqueEvidence({ papers: review.papers, synthesis: review.synthesis });
  const citationVerifier = review.agents?.citationVerifier || verifyScientificCitations(review.report, review.papers);
  const systematicReview = buildSystematicReviewAudit(review, { evidenceCritic, citationVerifier });
  if (typeof onStage === 'function') {
    for (const item of systematicReview.stages) onStage({ type: 'agent_stage', stage: item.id, status: item.status, details: item.details });
  }
  return {
    ...review,
    originalQuery: normalized,
    agents: { evidenceCritic, citationVerifier, systematicReview },
  };
}

module.exports = { runSystematicReviewAgent, systematicQuery };
