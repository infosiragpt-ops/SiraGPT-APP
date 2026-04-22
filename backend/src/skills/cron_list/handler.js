const scheduler = require('../../services/scheduler/scheduler');

async function execute(args, ctx) {
  if (!ctx?.userId) throw new Error('cron_list: ctx.userId required');
  const type = args?.type && args.type !== 'all' ? args.type : null;
  const jobs = scheduler.listJobs({ userId: ctx.userId, type });
  // Redact webhook secrets from the listing — the agent doesn't need
  // them. Owners fetch secrets via a dedicated admin endpoint.
  return {
    jobs: jobs.map(j => ({
      id: j.id,
      type: j.type,
      cron: j.cron || null,
      webhookPath: j.type === 'webhook' ? `/api/hooks/${j.id}` : null,
      prompt_preview: j.prompt.slice(0, 160),
      thinking: j.thinking,
      enabled: j.enabled,
      createdAt: j.createdAt,
      lastRunAt: j.lastRunAt || null,
      lastRunOk: j.lastRuns?.[0]?.ok ?? null,
    })),
  };
}

module.exports = { execute };
