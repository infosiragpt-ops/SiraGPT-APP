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
  logger.info?.(`[rlhf-phase3] backfill ${JSON.stringify(backfillResult)}`);

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

  return { backfill: backfillResult, train: trainResult };
}

if (require.main === module) {
  run()
    .then((res) => {
      console.log('[rlhf-phase3] result:', JSON.stringify(res));
      process.exit(0);
    })
    .catch((err) => {
      console.error('[rlhf-phase3] fatal:', err);
      process.exit(1);
    });
}

module.exports = { run };
