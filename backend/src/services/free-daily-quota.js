'use strict';

const { FREE_DAILY_CALL_LIMIT } = require('./plan-credits');

function todayUtcDateString(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * ensureFreeDailyQuota — resets FREE plan call counter at UTC midnight.
 * `monthlyCallLimit` stores REMAINING daily calls (legacy column name).
 */
async function ensureFreeDailyQuota(userId, prisma) {
  if (!userId || !prisma) return null;

  const today = todayUtcDateString();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, plan: true, freeQuotaDay: true, monthlyCallLimit: true },
  });

  if (!user || user.plan !== 'FREE') return user;

  if (user.freeQuotaDay === today) return user;

  await prisma.user.update({
    where: { id: userId },
    data: {
      freeQuotaDay: today,
      monthlyCallLimit: BigInt(FREE_DAILY_CALL_LIMIT),
    },
  });

  return {
    ...user,
    freeQuotaDay: today,
    monthlyCallLimit: BigInt(FREE_DAILY_CALL_LIMIT),
  };
}

/**
 * resetAllFreeDailyQuotas — cron job: refresh every FREE user whose
 * `freeQuotaDay` is not today (UTC).
 */
async function resetAllFreeDailyQuotas(prisma) {
  if (!prisma) return { updated: 0 };

  const today = todayUtcDateString();
  const result = await prisma.user.updateMany({
    where: {
      plan: 'FREE',
      OR: [
        { freeQuotaDay: null },
        { freeQuotaDay: { not: today } },
      ],
    },
    data: {
      freeQuotaDay: today,
      monthlyCallLimit: BigInt(FREE_DAILY_CALL_LIMIT),
    },
  });

  return { updated: result.count, day: today };
}

module.exports = {
  todayUtcDateString,
  ensureFreeDailyQuota,
  resetAllFreeDailyQuotas,
};
