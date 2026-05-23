'use strict';

const { resetAllFreeDailyQuotas } = require('../services/free-daily-quota');

async function run({ logger, prisma: injectedPrisma } = {}) {
  const log = logger || console;
  let prisma = injectedPrisma;
  if (!prisma) {
    // eslint-disable-next-line global-require
    prisma = require('../config/database');
  }

  const result = await resetAllFreeDailyQuotas(prisma);
  log.info?.(`[reset-free-daily-quota] refreshed ${result.updated} FREE users for ${result.day}`);
  return result;
}

module.exports = { run };
