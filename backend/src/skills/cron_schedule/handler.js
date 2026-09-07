const scheduler = require('../../services/scheduler/scheduler');

async function execute(args, ctx) {
  if (!ctx?.userId) throw new Error('cron_schedule: ctx.userId required');
  const job = scheduler.createCronJob({
    userId: ctx.userId,
    cron: args.cron,
    prompt: args.prompt,
    name: args.name || null,
    thinking: args.thinking || 'medium',
    timezone: args.timezone || null,
    // New routines notify their owner when each fire finishes
    // (opt-out via args.notify === false).
    meta: { notify: args.notify !== false },
  });
  const fresh = scheduler.getJob(job.id);
  return {
    scheduled: true,
    id: job.id,
    cron: job.cron,
    name: fresh?.name || null,
    nextRunAt: fresh?.nextRunAt || null,
    timezone: job.timezone,
    status: fresh?.status || 'idle',
    prompt_preview: job.prompt.slice(0, 160),
  };
}

module.exports = { execute };
