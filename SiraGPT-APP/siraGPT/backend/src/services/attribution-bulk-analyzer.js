'use strict';

/**
 * attribution-bulk-analyzer.js
 *
 * Batch-process N prompts in one call. Returns per-prompt
 * { quality, recommendedSkill, intent, supernodes, latencyMs } plus an
 * aggregate summary (avg quality, intent distribution, dominant
 * supernodes).
 *
 * Useful for:
 *   - offline dashboarding ("what kinds of prompts do users send most?")
 *   - prompt quality audits across a chat history
 *   - pre-computing skill recommendations for a chat backlog
 *   - eval datasets (run the bulk analyzer over a corpus, dump JSON)
 *
 * Bounded to MAX_BATCH per call (default 200) to keep latency predictable.
 *
 * Pure orchestration over the existing modules; no LLM, no I/O.
 */

const conceptExtractor = require('./concept-extractor');
const conceptSim = require('./concept-similarity');
const promptQualityScorer = require('./attribution-prompt-quality-scorer');
const skillRecommender = require('./attribution-skill-recommender');
const suite = require('./attribution-suite');

const MAX_BATCH = Number.parseInt(process.env.SIRAGPT_BULK_ANALYZER_MAX || '200', 10);

function safeText(v) { return String(v == null ? '' : v).slice(0, 4000); }

function analyzeOne(prompt, { includeSuite = false } = {}) {
  const start = Date.now();
  const p = safeText(prompt);
  if (!p.trim()) {
    return { prompt: '', empty: true, latencyMs: 0 };
  }
  const { concepts, language } = conceptExtractor.extractConcepts(p);
  const intents = concepts.filter((c) => c.type === 'action').map((c) => c.normalized);
  const supernodes = [...new Set(concepts
    .filter((c) => c.type === 'entity')
    .map((c) => conceptSim.canonical(c))
    .filter(Boolean))];
  const quality = promptQualityScorer.score({ prompt: p });
  const skill = skillRecommender.recommend({ prompt: p });
  const out = {
    prompt: p.slice(0, 200),
    language,
    intents,
    supernodes,
    quality: { score: quality.score, grade: quality.grade, suggestions: quality.suggestions.slice(0, 3) },
    recommendedSkill: skill.primary,
    alternatives: skill.alternatives.slice(0, 2),
    latencyMs: Date.now() - start,
  };
  if (includeSuite) {
    out.suite = suite.run({ prompt: p });
  }
  return out;
}

function analyzeBatch(prompts = [], { includeSuite = false, limit = MAX_BATCH } = {}) {
  if (!Array.isArray(prompts) || !prompts.length) {
    return { total: 0, results: [], aggregate: { avgQuality: 0, intentDistribution: {}, dominantSupernodes: [] } };
  }
  const cap = Math.max(1, Math.min(MAX_BATCH, Number(limit) || MAX_BATCH));
  const slice = prompts.slice(0, cap);
  const start = Date.now();
  const results = slice.map((p) => analyzeOne(p, { includeSuite }));

  // Aggregate.
  const intentCounts = {};
  const supernodeCounts = {};
  let qSum = 0;
  let qN = 0;
  for (const r of results) {
    if (r.empty) continue;
    qSum += r.quality.score;
    qN += 1;
    for (const i of r.intents) intentCounts[i] = (intentCounts[i] || 0) + 1;
    for (const s of r.supernodes) supernodeCounts[s] = (supernodeCounts[s] || 0) + 1;
  }

  const intentDistribution = Object.entries(intentCounts)
    .map(([intent, count]) => ({ intent, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const dominantSupernodes = Object.entries(supernodeCounts)
    .map(([supernode, count]) => ({ supernode, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return {
    total: results.length,
    elapsedMs: Date.now() - start,
    results,
    aggregate: {
      avgQuality: qN ? Number((qSum / qN).toFixed(3)) : 0,
      intentDistribution,
      dominantSupernodes,
    },
  };
}

function buildBulkBlock(batch) {
  if (!batch || !batch.total) return '';
  const lines = ['## BULK ATTRIBUTION SUMMARY'];
  lines.push(`Analyzed ${batch.total} prompts in ${batch.elapsedMs}ms.`);
  lines.push(`Avg quality score: ${batch.aggregate.avgQuality}`);
  if (batch.aggregate.intentDistribution.length) {
    lines.push('Top intents:');
    for (const i of batch.aggregate.intentDistribution.slice(0, 5)) lines.push(`- ${i.intent}: ${i.count}`);
  }
  if (batch.aggregate.dominantSupernodes.length) {
    lines.push('Dominant supernodes:');
    for (const s of batch.aggregate.dominantSupernodes.slice(0, 5)) lines.push(`- ${s.supernode}: ${s.count}`);
  }
  return lines.join('\n');
}

module.exports = {
  analyzeOne,
  analyzeBatch,
  buildBulkBlock,
  MAX_BATCH,
};
