'use strict';

/**
 * Hermes cron bridge — JavaScript port of hermes-agent/cron/*.
 * Wraps SiraGPT's existing scheduler with Hermes-compatible job API.
 */

const scheduler = require('../../scheduler/scheduler');

const INTERVAL_TO_CRON = Object.freeze({
  '1m': '* * * * *',
  '5m': '*/5 * * * *',
  '15m': '*/15 * * * *',
  '30m': '*/30 * * * *',
  '1h': '0 * * * *',
  '6h': '0 */6 * * *',
  '12h': '0 */12 * * *',
  '1d': '0 9 * * *',
});

function normalizeSchedule(schedule) {
  const raw = String(schedule || '').trim();
  if (!raw) throw new Error('schedule required');
  if (INTERVAL_TO_CRON[raw]) return INTERVAL_TO_CRON[raw];
  if (scheduler.validateCron(raw).ok) return raw;
  throw new Error(`unsupported schedule: ${raw}`);
}

function toHermesJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    schedule: job.cron || null,
    prompt: job.prompt,
    thinking: job.thinking,
    enabled: job.enabled,
    status: job.status,
    userId: job.userId,
    timezone: job.timezone || null,
    delivery: job.meta?.delivery || null,
    lastRunAt: job.lastRunAt || null,
    lastRuns: job.lastRuns || [],
    createdAt: job.createdAt,
  };
}

function createJob(opts = {}) {
  const userId = opts.userId;
  if (!userId) throw new Error('createJob: userId required');

  const schedule = normalizeSchedule(opts.schedule || opts.cron);
  const job = scheduler.createCronJob({
    userId,
    cron: schedule,
    prompt: opts.prompt,
    thinking: opts.thinking || 'medium',
    timezone: opts.timezone || null,
    meta: {
      delivery: opts.delivery || null,
      source: 'hermes-cron-bridge',
      ...(opts.meta || {}),
    },
  });
  return toHermesJob(scheduler.getJob(job.id));
}

function getJob(jobId) {
  return toHermesJob(scheduler.getJob(jobId));
}

function listJobs(opts = {}) {
  return scheduler.listJobs(opts).map(toHermesJob);
}

function removeJob(jobId, userId = null) {
  return scheduler.cancelJob({ jobId, userId });
}

function pauseJob(jobId, userId = null) {
  return scheduler.setJobEnabled({ jobId, userId, enabled: false });
}

function resumeJob(jobId, userId = null) {
  return scheduler.setJobEnabled({ jobId, userId, enabled: true });
}

async function triggerJob(jobId, opts = {}) {
  return scheduler.fireJob(jobId, { source: opts.source || 'hermes:manual', payload: opts.payload || null });
}

async function tick() {
  const jobs = scheduler.listJobs({ type: 'cron' }).filter((j) => j.enabled);
  const results = [];
  for (const job of jobs) {
    if (job.status === 'running') continue;
    results.push({ id: job.id, ...(await triggerJob(job.id, { source: 'hermes:tick' })) });
  }
  return { ticked: results.length, results };
}

function status() {
  const jobs = scheduler.listJobs();
  return {
    enabled: process.env.AGENT_SCHEDULER !== 'off',
    activeCronJobs: jobs.filter((j) => j.type === 'cron' && j.enabled).length,
    totalJobs: jobs.length,
    webhookJobs: jobs.filter((j) => j.type === 'webhook').length,
  };
}

module.exports = {
  INTERVAL_TO_CRON,
  normalizeSchedule,
  createJob,
  getJob,
  listJobs,
  removeJob,
  pauseJob,
  resumeJob,
  triggerJob,
  tick,
  status,
  toHermesJob,
};
