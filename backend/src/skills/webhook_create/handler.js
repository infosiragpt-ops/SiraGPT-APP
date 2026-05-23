const scheduler = require('../../services/scheduler/scheduler');

async function execute(args, ctx) {
  if (!ctx?.userId) throw new Error('webhook_create: ctx.userId required');
  const job = scheduler.createWebhookJob({
    userId: ctx.userId,
    prompt: args.prompt,
    thinking: args.thinking || 'medium',
  });
  return {
    created: true,
    id: job.id,
    // The agent needs to surface the URL + secret to the user. Once.
    // The secret is NOT shown again by cron_list — the user must
    // record it now.
    url: `/api/hooks/${job.id}`,
    secret: job.secret,
    note: 'POST JSON to the url with header "x-hook-secret: <secret>" to fire the agent.',
  };
}

module.exports = { execute };
