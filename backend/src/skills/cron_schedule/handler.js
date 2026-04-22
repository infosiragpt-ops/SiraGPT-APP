const scheduler = require('../../services/scheduler/scheduler');

async function execute(args, ctx) {
  if (!ctx?.userId) throw new Error('cron_schedule: ctx.userId required');
  const job = scheduler.createCronJob({
    userId: ctx.userId,
    cron: args.cron,
    prompt: args.prompt,
    thinking: args.thinking || 'medium',
    timezone: args.timezone || null,
  });
  return {
    scheduled: true,
    id: job.id,
    cron: job.cron,
    timezone: job.timezone,
    prompt_preview: job.prompt.slice(0, 160),
  };
}

module.exports = { execute };
