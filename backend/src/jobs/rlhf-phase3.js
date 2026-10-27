'use strict';

/**
 * Daily RLHF phase-3 pass: backfill Message.feedback → preference_events,
 * then maybe retrain the in-process reward model.
 */

async function run(opts = {}) {
  const logger = opts.logger || console;
  const prisma = opts.prisma || require('../config/database');
  const store = require('../services/rlhf/preference-store');
  if (typeof store.attachPrisma === 'function') store.attachPrisma(prisma);

  let embedder;
  try {
    const rag = require('../services/rag-service');
    embedder = (texts) => rag.embed(texts);
  } catch {
    embedder = undefined;
  }

  const { backfill } = require('../services/rlhf/backfill');
  const backfillResult = await backfill({ prisma, embedder, limit: opts.limit || 500 });
  logger.info?.(`[rlhf-phase3] backfill ${require('../utils/compact-log-json').compactLogJson(backfillResult)}`);

  let trainResult = { ok: false, reason: 'skipped' };
  try {
    const trainer = require('../services/rlhf/trainer');
    if (backfillResult.ingested > 0) {
      trainResult = await trainer.train();
    } else {
      const maybe = trainer.maybeRetrain();
      trainResult = maybe && typeof maybe.then === 'function'
        ? await maybe
        : { ok: false, reason: 'no_new_labels' };
    }
  } catch (err) {
    trainResult = { ok: false, reason: err.message };
    logger.warn?.(`[rlhf-phase3] train skipped: ${err.message}`);
  }

  return { backfill: backfillResult, train: summarizeTrainResult(trainResult) };
}

/**
 * What a run reports about training: outcome, version and metrics — never
 * the model itself. trainer.train() returns the reward model (a 1536-weight
 * vector), and the cron printed it whole in every «rlhf-phase3 done» line.
 * The trained model stays active in the trainer and persisted in its
 * snapshot table; nobody reads it from this result.
 */
function summarizeTrainResult(result) {
  if (!result || typeof result !== 'object') return result;
  const { model, ...rest } = result;
  if (!model || typeof model !== 'object') return rest;
  const dim = Number(model.dim);
  const weightCount = model.weights && typeof model.weights === 'object' ? Object.keys(model.weights).length : null;
  return { ...rest, model: { dim: Number.isFinite(dim) ? dim : weightCount } };
}

if (require.main === module) {
  run()
    .then((res) => {
      console.log('[rlhf-phase3] result:', require('../utils/compact-log-json').compactLogJson(res));
      process.exit(0);
    })
    .catch((err) => {
      console.error('[rlhf-phase3] fatal:', err);
      process.exit(1);
    });
}

module.exports = { run, summarizeTrainResult };
