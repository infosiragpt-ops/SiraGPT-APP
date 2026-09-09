'use strict';

/**
 * Optional durable backend for the coding harness (Phase 4c).
 *
 * Same HTTP API as Phase 4a/4b. When a jobs backend is injected (or the
 * flag is on and REDIS_URL is present on that env), runs enqueue and
 * persist. Otherwise the in-process loop is unchanged.
 */

const { isAgentesCodingV2Enabled } = require('../../flags');
const { fail } = require('../../coding-sandbox/errors');
const {
  sanitizePrompt,
  createRun,
  findRun,
  getStore,
  publicRun,
  ACTIVE_STATUSES,
} = require('../store');
const { resolveCaps } = require('../runner');
const { resolveCodingModel } = require('../llm');
const { findPending, normalizeDecision } = require('../permissions');
const { serializeRun, hydrateRun, publicFromSnapshot } = require('./snapshot');
const { createRunStore, createMemoryRunStore, createRedisRunStore } = require('./store');
const {
  QUEUE_NAME,
  JOB_NAME,
  createHarnessQueue,
  createMemoryQueue,
  jobIdFor,
} = require('./queue');
const { processHarnessJob, startHarnessWorker, attachRun } = require('./worker');

let sharedWorker = null;
let sharedJobs = null;

function truthy(value) {
  return /^(1|true|on)$/i.test(String(value || '').trim());
}

function jobsDisabled(env) {
  return /^(0|false|off)$/i.test(String(env.AGENTES_CODING_HARNESS_JOBS || '').trim());
}

function shouldUseDurable(env = process.env, extras = {}) {
  if (extras.jobs) return true;
  if (extras.queue) return true;
  if (!isAgentesCodingV2Enabled(env)) return false;
  if (jobsDisabled(env)) return false;
  return Boolean(String(env.REDIS_URL || '').trim());
}

function createJobsBackend(opts = {}) {
  const store = createRunStore(opts);
  const queue = createHarnessQueue(opts);
  const autoDrain = opts.autoDrain !== false && queue.kind !== 'bullmq';
  const ctx = {
    sandbox: opts.sandbox || null,
    store,
    env: opts.env || null,
    llmTurn: opts.llmTurn || null,
    complete: opts.complete || null,
    createClient: opts.createClient || null,
    permissionPolicy: opts.permissionPolicy || null,
  };
  return {
    kind: queue.kind,
    store,
    queue,
    autoDrain,
    ctx,
    bind(next = {}) {
      Object.assign(ctx, next);
      return this;
    },
    async process(job) {
      return processHarnessJob(job, ctx);
    },
    async drain() {
      if (typeof queue.drain !== 'function') return [];
      return queue.drain((job) => processHarnessJob(job, ctx));
    },
  };
}

function resolveJobs(env, extras = {}) {
  if (extras.jobs) return extras.jobs;
  if (!shouldUseDurable(env, extras)) return null;
  if (extras.queue || extras.store || extras.redis) {
    return createJobsBackend(extras);
  }
  return sharedJobs;
}

async function hasActiveInStore(jobs, sessionId) {
  if (!jobs || !jobs.store) return false;
  const items = await jobs.store.list(sessionId);
  return items.some((row) => ACTIVE_STATUSES.includes(row.status));
}

async function persistRow(jobs, raw, row, sessionId) {
  const snapshot = serializeRun(row, { sessionId, raw });
  await jobs.store.save(snapshot);
  return snapshot;
}

async function enqueueAndMaybeDrain(jobs, data) {
  await jobs.queue.add(JOB_NAME, data, { jobId: jobIdFor(data) });
  if (jobs.autoDrain) await jobs.drain();
}

async function startDurable(sandbox, sessionId, raw, opts = {}) {
  const jobs = opts.jobs;
  if (!jobs) fail('E_PARAMS', 'Falta el backend durable del harness.');
  if (getStore(raw).items.some((row) => ACTIVE_STATUSES.includes(row.status))) {
    fail('E_QUOTA', 'Ya hay un turno del harness en curso.');
  }
  if (await hasActiveInStore(jobs, sessionId)) {
    fail('E_QUOTA', 'Ya hay un turno del harness en curso.');
  }
  const caps = resolveCaps(opts.env || process.env, opts);
  const prompt = sanitizePrompt(opts.prompt || opts.text || opts.message);
  const resolved = resolveCodingModel(opts.modelAlias, opts.env || process.env);
  const row = createRun(raw, prompt, caps);
  row.sessionId = sessionId;
  row.permissionPolicy = opts.permissionPolicy;
  row.modelAlias = resolved.alias;
  jobs.bind({
    sandbox,
    env: opts.env,
    llmTurn: opts.llmTurn,
    complete: opts.complete,
    createClient: opts.createClient,
    permissionPolicy: opts.permissionPolicy,
  });
  const snapshot = await persistRow(jobs, raw, row, sessionId);
  try {
    await enqueueAndMaybeDrain(jobs, {
      action: 'start',
      runId: row.id,
      sessionId,
      snapshot,
    });
  } catch (err) {
    if (err && err.code && String(err.code).startsWith('E_')) throw err;
    fail('E_HARNESS_QUEUE', err && err.message ? String(err.message).slice(0, 160) : undefined);
  }
  const latest = await jobs.store.get(row.id);
  return publicFromSnapshot(latest) || publicRun(row);
}

async function readDurable(sandbox, sessionId, runId, jobs) {
  const snap = await jobs.store.get(runId);
  if (snap) {
    if (snap.sessionId && snap.sessionId !== sessionId) fail('E_HARNESS_NOT_FOUND');
    return { ok: true, run: publicFromSnapshot(snap) };
  }
  const raw = sandbox && typeof sandbox._unsafeGetRaw === 'function'
    ? sandbox._unsafeGetRaw(sessionId)
    : null;
  if (!raw) fail('E_HARNESS_NOT_FOUND');
  return { ok: true, run: publicRun(findRun(raw, runId)) };
}

async function listDurable(sandbox, sessionId, jobs) {
  const snaps = await jobs.store.list(sessionId);
  if (snaps.length) {
    return { ok: true, runs: snaps.map((snap) => publicFromSnapshot(snap)).filter(Boolean) };
  }
  const raw = sandbox && typeof sandbox._unsafeGetRaw === 'function'
    ? sandbox._unsafeGetRaw(sessionId)
    : null;
  if (!raw) return { ok: true, runs: [] };
  return { ok: true, runs: getStore(raw).items.map((row) => publicRun(row)) };
}

async function cancelDurable(sandbox, sessionId, raw, row, jobs) {
  row.cancelRequested = true;
  const snapshot = await persistRow(jobs, raw, row, sessionId);
  jobs.bind({ sandbox });
  await enqueueAndMaybeDrain(jobs, {
    action: 'cancel',
    runId: row.id,
    sessionId,
    snapshot,
  });
  const latest = await jobs.store.get(row.id);
  return { ok: true, run: publicFromSnapshot(latest) || publicRun(row) };
}

async function resolveDurable(sandbox, sessionId, raw, row, permissionId, decision, opts = {}) {
  const jobs = opts.jobs;
  const pending = findPending(row, permissionId);
  const normalized = normalizeDecision(decision);
  if (!normalized) fail('E_PARAMS', 'La decisión de permiso no es válida.');
  jobs.bind({
    sandbox,
    env: opts.env,
    llmTurn: opts.llmTurn,
    complete: opts.complete,
    createClient: opts.createClient,
    permissionPolicy: opts.permissionPolicy || row.permissionPolicy,
  });
  const snapshot = await persistRow(jobs, raw, row, sessionId);
  await enqueueAndMaybeDrain(jobs, {
    action: 'resume',
    runId: row.id,
    sessionId,
    permissionId,
    decision: normalized,
    snapshot,
  });
  const latest = await jobs.store.get(row.id);
  const run = publicFromSnapshot(latest) || publicRun(row);
  return {
    ok: true,
    run,
    decision: normalized,
    remembered: normalized === 'allow_always',
    pendingTool: pending.tool,
  };
}

async function loadRowForRequest(sandbox, sessionId, runId, jobs) {
  const raw = sandbox && typeof sandbox._unsafeGetRaw === 'function'
    ? sandbox._unsafeGetRaw(sessionId)
    : null;
  if (jobs) {
    const snap = await jobs.store.get(runId);
    if (snap) {
      const row = hydrateRun(snap);
      if (!raw) fail('E_SESSION_NOT_FOUND');
      attachRun(raw, row);
      return { raw, row };
    }
  }
  if (!raw) fail('E_SESSION_NOT_FOUND');
  return { raw, row: findRun(raw, runId) };
}

async function forgetDurable(sandbox, sessionId, jobs) {
  if (jobs && jobs.store && typeof jobs.store.forgetSession === 'function') {
    await jobs.store.forgetSession(sessionId);
  }
}

function closeHarnessWorker() {
  const closing = [];
  if (sharedWorker && typeof sharedWorker.close === 'function') {
    closing.push(sharedWorker.close());
  }
  sharedWorker = null;
  sharedJobs = null;
  return Promise.allSettled(closing);
}

function startSharedWorker(opts = {}) {
  if (sharedWorker) return sharedWorker;
  const env = opts.env || process.env;
  if (!shouldUseDurable(env, opts)) return null;
  if (!sharedJobs) {
    let redis = opts.redis;
    let connection = opts.connection;
    const redisUrl = String(env.REDIS_URL || '').trim();
    if (!opts.store && !opts.queue && !redis && redisUrl) {
      const IORedis = require('ioredis');
      redis = new IORedis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });
      connection = redis;
    }
    sharedJobs = createJobsBackend({
      store: opts.store,
      queue: opts.queue,
      redis,
      connection,
      autoDrain: false,
      env,
      llmTurn: opts.llmTurn,
      complete: opts.providerComplete || opts.complete,
      createClient: opts.createClient,
      permissionPolicy: opts.permissionPolicy,
    });
  }
  sharedWorker = startHarnessWorker({
    env,
    getSandbox: opts.getSandbox,
    sandbox: opts.sandbox,
    store: sharedJobs.store,
    llmTurn: opts.llmTurn,
    complete: opts.providerComplete || opts.complete,
    createClient: opts.createClient,
    permissionPolicy: opts.permissionPolicy,
    processor: opts.processor || ((job) => processHarnessJob(job, {
      ...sharedJobs.ctx,
      sandbox: typeof opts.getSandbox === 'function' ? opts.getSandbox() : (opts.sandbox || sharedJobs.ctx.sandbox),
      store: sharedJobs.store,
      env: opts.env || sharedJobs.ctx.env || env,
      llmTurn: opts.llmTurn || sharedJobs.ctx.llmTurn,
      complete: opts.providerComplete || opts.complete || sharedJobs.ctx.complete,
      createClient: opts.createClient || sharedJobs.ctx.createClient,
      permissionPolicy: opts.permissionPolicy || sharedJobs.ctx.permissionPolicy,
    })),
    queue: opts.queue,
    queueName: opts.queueName,
  });
  return sharedWorker;
}

module.exports = {
  QUEUE_NAME,
  shouldUseDurable,
  createJobsBackend,
  resolveJobs,
  startDurable,
  readDurable,
  listDurable,
  cancelDurable,
  resolveDurable,
  loadRowForRequest,
  forgetDurable,
  persistRow,
  startHarnessWorker,
  startSharedWorker,
  closeHarnessWorker,
  createMemoryRunStore,
  createRedisRunStore,
  createMemoryQueue,
  processHarnessJob,
  serializeRun,
  hydrateRun,
  publicFromSnapshot,
};
