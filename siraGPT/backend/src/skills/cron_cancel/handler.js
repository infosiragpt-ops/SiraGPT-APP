const scheduler = require('../../services/scheduler/scheduler');

async function execute(args, ctx) {
  if (!ctx?.userId) throw new Error('cron_cancel: ctx.userId required');
  const res = scheduler.cancelJob({ userId: ctx.userId, jobId: args.id });
  if (!res.ok) return { cancelled: false, reason: res.reason };
  return { cancelled: true, id: res.removed.id, type: res.removed.type };
}

module.exports = { execute };
