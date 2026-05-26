/**
 * ragas — combined RAGAS evaluation runner.
 *
 * Computes the four RAGAS metrics (Es et al. 2024) on a single
 * (question, answer, retrieved_contexts, ground_truth?) tuple.
 * Returns a full report with per-metric scores + aggregate.
 *
 * Two modes:
 *   - With ground truth: all 4 metrics (faithfulness, answer_relevancy,
 *     context_precision, context_recall).
 *   - Without ground truth: 3 metrics (no context_recall — it requires gt).
 *
 * All metrics run in parallel. Runtime is LLM-call-bounded; ~5-10s
 * per tuple on gpt-4o-mini.
 */

const faithfulness = require('./faithfulness');
const answerRelevancy = require('./answer-relevancy');
const contextPrecision = require('./context-precision');
const contextRecall = require('./context-recall');

/**
 * Run the full RAGAS suite on one example.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.question
 * @param {string|object} args.answer
 * @param {Array} args.retrievedContexts
 * @param {string|null} [args.groundTruth]  — when null, skips context_recall
 * @param {function} args.embedder           — for answer_relevancy
 * @param {string} [args.model]
 *
 * @returns {Promise<{
 *   faithfulness: {score, ...},
 *   answer_relevancy: {score, ...},
 *   context_precision: {score, ...},
 *   context_recall: {score, ...} | null,
 *   aggregate: number,  // mean of available scores
 * }>}
 */
async function evaluate({
  openai, question, answer, retrievedContexts, groundTruth = null,
  embedder, model,
}) {
  if (!openai) throw new Error('ragas.evaluate: openai required');
  if (!question) throw new Error('ragas.evaluate: question required');

  const metricCalls = [
    faithfulness.compute({ openai, question, answer, retrievedContexts, model }),
    answerRelevancy.compute({ openai, question, answer, embedder, model }),
    contextPrecision.compute({ openai, question, retrievedContexts, model }),
  ];
  if (groundTruth) {
    metricCalls.push(contextRecall.compute({ openai, groundTruth, retrievedContexts, model }));
  }

  const [faith, rel, prec, recall] = await Promise.all(metricCalls);

  const scores = [faith.score, rel.score, prec.score];
  if (recall) scores.push(recall.score);
  const aggregate = scores.reduce((a, b) => a + b, 0) / scores.length;

  return {
    faithfulness: faith,
    answer_relevancy: rel,
    context_precision: prec,
    context_recall: recall || null,
    aggregate,
    summary: {
      faithfulness: faith.score,
      answer_relevancy: rel.score,
      context_precision: prec.score,
      context_recall: recall?.score ?? null,
      aggregate,
    },
  };
}

/**
 * Batch evaluation. Runs `evaluate` over an array of examples, returns
 * per-example results + aggregated summary with per-metric mean and
 * standard deviation.
 *
 * Paper reports aggregated RAGAS scores over benchmark sets; this is
 * the typical "batch eval of a RAG pipeline on a labeled test set".
 */
async function evaluateBatch({ openai, examples, embedder, model }) {
  if (!Array.isArray(examples) || examples.length === 0) {
    return { n: 0, perExample: [], aggregate: null };
  }
  const perExample = [];
  for (const ex of examples) {
    // Sequential by default — parallel risks rate-limits on large sets.
    // eslint-disable-next-line no-await-in-loop
    const r = await evaluate({ openai, embedder, model, ...ex });
    perExample.push({ id: ex.id || null, ...r });
  }

  const meanOf = (key) => {
    const vals = perExample.map(r => r[key]?.score).filter(Number.isFinite);
    if (vals.length === 0) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  const stddevOf = (key) => {
    const vals = perExample.map(r => r[key]?.score).filter(Number.isFinite);
    if (vals.length < 2) return 0;
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    const v = vals.reduce((a, b) => a + (b - m) ** 2, 0) / (vals.length - 1);
    return Math.sqrt(v);
  };

  return {
    n: perExample.length,
    perExample,
    aggregate: {
      faithfulness:      { mean: meanOf('faithfulness'),      std: stddevOf('faithfulness') },
      answer_relevancy:  { mean: meanOf('answer_relevancy'),  std: stddevOf('answer_relevancy') },
      context_precision: { mean: meanOf('context_precision'), std: stddevOf('context_precision') },
      context_recall:    { mean: meanOf('context_recall'),    std: stddevOf('context_recall') },
      aggregate_mean: perExample.reduce((a, b) => a + (b.aggregate || 0), 0) / perExample.length,
    },
  };
}

module.exports = {
  evaluate,
  evaluateBatch,
  faithfulness,
  answerRelevancy,
  contextPrecision,
  contextRecall,
};
