'use strict';

/**
 * jobs/memory-consolidation — nightly "dreaming" over every user whose memory
 * changed since their last pass. Thin wrapper so system-cron can lazy-require
 * it like the other jobs; all logic lives in services/memory/consolidation.
 */

async function run({ logger = console, env = process.env, batch } = {}) {
  // eslint-disable-next-line global-require
  const consolidation = require('../services/memory/consolidation');
  const size = Number.isFinite(Number(batch)) ? Number(batch) : (Number(env.SIRAGPT_MEMORY_CONSOLIDATION_BATCH) || 50);
  return consolidation.runPass({ batch: Math.max(1, Math.min(500, size)), env, log: logger });
}

module.exports = { run };
