/**
 * scheduler — cron + webhook backend for the agent.
 *
 * The agent can now schedule work for itself:
 *   - `cron_schedule` creates a recurring job with a cron expression
 *     that fires the agent on a stored prompt.
 *   - `webhook_create` returns a URL + secret that, when POSTed, fires
 *     the same agent with the stored prompt (+ optional payload).
 *
 * Persistence is a plain JSON file at backend/data/scheduled-jobs.json
 * to keep this commit free of a Prisma migration. When siraGPT grows
 * beyond a single-host install, swap `loadAll`/`saveAll` for a real
 * repository against the existing Prisma client.
 *
 * Why node-cron (already in deps) vs building our own ticker:
 *   - Correct DST / month-length / cron-expression handling out of
 *     the box, including the awkward "29th of Feb" cases.
 *   - Per-job task refs so cancel is O(1) and doesn't leak timers.
 *
 * Safety rails:
 *   - A job inherits the policy mode its owner last used, default
 *     "sandbox" — schedules are non-interactive, so broad caps (shell,
 *     browser) should not run without explicit opt-in. That happens
 *     at run time via the policy system, not here.
 *   - Each job keeps a ring buffer of its last N runs (lastRuns).
 *   - Webhook invocations must present the secret; failures are
 *     logged but don't retry automatically.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');
const { writeJsonAtomicSync } = require('../../utils/atomic-json-write');
const { redactErrorMessage } = require('../../utils/secret-redactor');
const {
  acquireJobOverlap,
  releaseJobOverlap,
  startJobOverlapRenew,
  ensureDefaultRedisClient,
  OVERLAP_HELD_REASON_ES,
} = require('./overlap-lease');

function isThenable(value) {
  return Boolean(value && typeof value.then === 'function');
}

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const JOBS_FILE = path.join(DATA_DIR, 'scheduled-jobs.json');
const RUN_LOG_FILE = path.join(DATA_DIR, 'scheduled-runs.jsonl');
const LAST_RUNS_KEEP = 10;

// In-memory state: id → { job, task (node-cron handle) }
// Kept separate from the persisted job so we can re-hydrate on boot
// without having to serialise node-cron task objects.
const active = new Map();
const running = new Set();

// Pluggable agent invoker. The skills layer injects the real invoker
// at boot (setInvoker). This avoids a circular require between
// scheduler → agent-entry → skills → scheduler.
let _invoker = null;
function setInvoker(fn) { _invoker = fn; }

// Kept for the existing boot contract. A whole agent turn can already have
// performed external effects before failing, so a transient classifier cannot
// authorize replay here. Read-only tool retries remain inside the agent loop.
function setJobClassifier() {}

// ─── Persistence ──────────────────────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll() {
  ensureDataDir();
  if (!fs.existsSync(JOBS_FILE)) return [];
  try {
    const raw = fs.readFileSync(JOBS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // Corrupted jobs file shouldn't take down the server. Move it
    // aside so the operator can inspect; we boot with an empty set.
    const backup = `${JOBS_FILE}.corrupt.${Date.now()}`;
    try { fs.renameSync(JOBS_FILE, backup); } catch { /* best effort */ }
    console.error(`[scheduler] jobs file corrupt, moved to ${backup}:`, err.message);
    return [];
  }
}

function saveAll(jobs) {
  // Uses shared atomic-json-write for crash-safe persistence (centralized
  // implementation of the temp+rename+fsync pattern previously duplicated here).
  writeJsonAtomicSync(JOBS_FILE, jobs, { pretty: 2, ensureDir: true });
}

function appendRunLog(entry) {
  ensureDataDir();
  fs.appendFileSync(RUN_LOG_FILE, JSON.stringify(entry) + '\n');
}

// ─── Id + secret helpers ───────────────────────────────────────────────────

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}
function newSecret() {
  return crypto.randomBytes(24).toString('base64url');
}

// ─── Cron expression validation ────────────────────────────────────────────
//
// node-cron's own validator is permissive — it accepts some expressions
// that then silently never fire. We add an upfront check on frequency
// so users don't end up with a "every second" schedule burning LLM
// budget. Tight floor: 1 minute. Callers that need sub-minute polling
// should use webhooks.

function validateCron(expr) {
  if (typeof expr !== 'string' || !cron.validate(expr)) {
    return { ok: false, reason: 'invalid cron expression' };
  }
  // Disallow expressions that would fire every second (6-field with a
  // second-level *). node-cron supports 6-field expressions when the
  // first field is seconds; 5-field is minute-granularity and fine.
  const parts = expr.trim().split(/\s+/);
  if (parts.length === 6 && parts[0].includes('*')) {
    return { ok: false, reason: 'sub-minute schedules are not allowed' };
  }
  return { ok: true };
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

/**
 * Register and start a single job's cron schedule. Called by
 * createCronJob and by start() on boot.
 */
function activate(job) {
  if (active.has(job.id)) {
    // Replace: tear down the old task first so we don't leak.
    try { active.get(job.id).task.stop(); } catch { /* noop */ }
    active.delete(job.id);
  }
  if (job.type !== 'cron' || !job.enabled) return;

  const check = validateCron(job.cron);
  if (!check.ok) {
    console.warn(`[scheduler] skipping job ${job.id}: ${check.reason}`);
    return;
  }

  const task = cron.schedule(job.cron, () => fireJob(job.id, { source: 'cron' }), {
    scheduled: true,
    timezone: job.timezone || undefined,
  });
  active.set(job.id, { job, task });
}

function deactivate(jobId) {
  const entry = active.get(jobId);
  if (entry) {
    try { entry.task.stop(); } catch { /* noop */ }
    active.delete(jobId);
  }
}

/** Start scheduler — load persisted jobs and activate cron ones. */
function start() {
  if (process.env.AGENT_SCHEDULER === 'off') {
    console.log('[scheduler] disabled via AGENT_SCHEDULER=off');
    return;
  }
  ensureDefaultRedisClient();
  const jobs = loadAll();
  for (const job of jobs) activate(job);
  console.log(`[scheduler] started — ${active.size} cron job(s) active, ${jobs.length} total`);
}

/** Stop all active cron tasks — for clean shutdown in tests. */
function stop() {
  for (const id of Array.from(active.keys())) deactivate(id);
}

// ─── CRUD ──────────────────────────────────────────────────────────────────

function createCronJob({ userId, cron: expr, prompt, thinking = 'medium', timezone = null, meta = {} }) {
  if (!userId) throw new Error('createCronJob: userId required');
  if (!prompt || typeof prompt !== 'string') throw new Error('createCronJob: prompt required');
  const check = validateCron(expr);
  if (!check.ok) throw new Error(`createCronJob: ${check.reason}`);

  const jobs = loadAll();
  const job = {
    id: newId('job'),
    type: 'cron',
    userId,
    cron: expr,
    timezone,
    prompt,
    thinking,
    meta,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastRuns: [],
  };
  jobs.push(job);
  saveAll(jobs);
  activate(job);
  return job;
}

function createWebhookJob({ userId, prompt, thinking = 'medium', meta = {} }) {
  if (!userId) throw new Error('createWebhookJob: userId required');
  if (!prompt || typeof prompt !== 'string') throw new Error('createWebhookJob: prompt required');
  const jobs = loadAll();
  const job = {
    id: newId('hook'),
    type: 'webhook',
    userId,
    secret: newSecret(),
    prompt,
    thinking,
    meta,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastRuns: [],
  };
  jobs.push(job);
  saveAll(jobs);
  return job;
}

function listJobs({ userId, type = null } = {}) {
  const jobs = loadAll();
  return jobs.filter(j => {
    if (userId != null && j.userId !== userId) return false;
    if (type && j.type !== type) return false;
    return true;
  }).map(withComputedStatus);
}

function getJob(jobId) {
  const jobs = loadAll();
  const job = jobs.find(j => j.id === jobId) || null;
  return job ? withComputedStatus(job) : null;
}

function cancelJob({ userId, jobId }) {
  const jobs = loadAll();
  const idx = jobs.findIndex(j => j.id === jobId && (userId == null || j.userId === userId));
  if (idx === -1) return { ok: false, reason: 'not found' };
  const [removed] = jobs.splice(idx, 1);
  saveAll(jobs);
  deactivate(jobId);
  return { ok: true, removed };
}

function setJobEnabled({ userId, jobId, enabled }) {
  const jobs = loadAll();
  const idx = jobs.findIndex(j => j.id === jobId && (userId == null || j.userId === userId));
  if (idx === -1) return { ok: false, reason: 'not found' };
  jobs[idx].enabled = Boolean(enabled);
  saveAll(jobs);
  if (jobs[idx].enabled) activate(jobs[idx]);
  else deactivate(jobId);
  return { ok: true, job: withComputedStatus(jobs[idx]) };
}

// ─── Execution ─────────────────────────────────────────────────────────────

// Native adaptation of OpenClaw's explicit CronRunOutcome / lastRunStatus
// contract (MIT, b56ddcc6ffdfc5be78c1c9c93926518367b876eb). A resolved Promise
// or delivery acknowledgement is not execution success. Keep SiraGPT's own
// invoker shape; do not import the upstream scheduler, retry policy or gateway.
const SUCCESSFUL_STOP_REASONS = new Set(['finalized', 'plain_text_finalize', 'completed']);

function hasCompletedPlanSteps(out) {
  if (!Array.isArray(out.plan) || out.plan.length === 0
    || !Array.isArray(out.steps) || out.steps.length !== out.plan.length) return false;
  const seen = new Set();
  return out.plan.every((spec, index) => {
    const result = out.steps[index];
    if (!spec || !Number.isSafeInteger(spec.step) || spec.step < 1 || seen.has(spec.step)
      || typeof spec.goal !== 'string' || !spec.goal.trim()
      || !result || result.step !== spec.step || result.goal !== spec.goal
      || typeof result.stoppedReason !== 'string') return false;
    seen.add(spec.step);
    // These are terminal sub-goal results from planner/executor, not raw
    // ReAct trace actions. A transient observation recovered within a sub-goal
    // must not invalidate its eventual verified finalization.
    const reason = result.stoppedReason.split(':', 1)[0].trim().toLowerCase();
    return SUCCESSFUL_STOP_REASONS.has(reason) && !result.error
      && (!Object.hasOwn(result, 'ok') || result.ok === true)
      && (!Object.hasOwn(result, 'status') || ['ok', 'completed', 'finalized'].includes(result.status));
  });
}

function completedRunOutcome(out) {
  const incomplete = {
    ok: false,
    errorCode: 'agent_run_incomplete',
    error: 'La ejecución no confirmó la finalización del trabajo.',
  };
  if (!out || typeof out !== 'object' || Array.isArray(out)) return incomplete;
  for (const field of ['stoppedReason', 'status']) {
    if (Object.hasOwn(out, field) && (typeof out[field] !== 'string' || !out[field].trim())) return incomplete;
  }
  if (Object.hasOwn(out, 'ok') && typeof out.ok !== 'boolean') return incomplete;
  // Diagnostics after ':' may contain private provider information. They are
  // never persisted or returned as part of a stop reason.
  const reason = typeof out.stoppedReason === 'string'
    ? out.stoppedReason.split(':', 1)[0].trim().toLowerCase() : '';
  const status = typeof out.status === 'string' ? out.status.trim().toLowerCase() : '';
  if (['cancelled', 'aborted', 'cancelled_by_user'].includes(reason)
    || ['cancelled', 'canceled', 'aborted'].includes(status)) {
    return { ok: false, errorCode: 'E_CANCELLED', error: 'La ejecución fue cancelada.' };
  }
  if (out.ok === false || out.error || (status && !['ok', 'completed', 'finalized'].includes(status))) {
    return incomplete;
  }
  if (reason && !SUCCESSFUL_STOP_REASONS.has(reason)) return incomplete;
  // The planner/executor may synthesize successfully after a sub-goal failed.
  // Require a terminal result for every planned sub-goal before trusting that
  // synthesis. Plain ReAct runs have no plan; their historical observations
  // are deliberately not interpreted as terminal sub-goal results.
  if (Object.hasOwn(out, 'plan') && !hasCompletedPlanSteps(out)) return incomplete;
  // Canonical runAgent supplies a stop reason. Preserve the historical
  // synchronous answer-only invoker contract, but not queued/accepted handles
  // or malformed stop/status fields masquerading as completed answers.
  const legacyAnswer = !Object.hasOwn(out, 'stoppedReason') && !Object.hasOwn(out, 'status')
    && !out.accepted && !out.taskId && typeof out.answer === 'string' && out.answer.trim();
  if (!reason && !status && !legacyAnswer) return incomplete;
  return { ok: true, answerSnippet: typeof out.answer === 'string' ? out.answer.slice(0, 400) : '' };
}

/**
 * Run a job's prompt. Callable from cron or webhook. Does NOT throw —
 * all errors are captured into the run record so the cron thread /
 * webhook handler stays clean.
 */
async function fireJob(jobId, { source = 'cron', payload = null } = {}) {
  const job = getJob(jobId);
  if (!job) return { ok: false, reason: 'job not found' };
  if (!job.enabled) return { ok: false, reason: 'disabled' };
  // Process-local fast path, then Redis (or documented local fallback).
  if (running.has(job.id)) {
    return {
      ok: false,
      reason: OVERLAP_HELD_REASON_ES,
      code: 'overlap_skipped',
      distributed: false,
      fallback: 'local_only',
    };
  }
  if (!_invoker) {
    console.warn(`[scheduler] no invoker registered — skipping job ${jobId}`);
    return { ok: false, reason: 'no invoker' };
  }

  const claimed = acquireJobOverlap({
    jobId: job.id,
    ownerId: job.userId,
    holderId: `scheduler:${source}`,
  });
  const claim = isThenable(claimed) ? await claimed : claimed;
  if (!claim.ok) {
    return {
      ok: false,
      reason: claim.reason || OVERLAP_HELD_REASON_ES,
      code: 'overlap_skipped',
      distributed: Boolean(claim.distributed),
      fallback: claim.fallback || null,
    };
  }

  const startedAt = new Date();
  const record = { at: startedAt.toISOString(), source, durationMs: 0, ok: false };
  const stopRenew = startJobOverlapRenew(claim);

  try {
    running.add(job.id);
    // Interpolate a lightweight {{payload.*}} template so webhook
    // callers can pass context. Cron jobs with no payload get the
    // plain prompt.
    const effectivePrompt = payload
      ? interpolate(job.prompt, { payload, at: startedAt.toISOString() })
      : job.prompt;

    // Invoke exactly once. Re-running a full agent may resend a message or
    // repeat a write after an ambiguous transport error. A later scheduled
    // occurrence or explicit user action is separate from automatic replay.
    const out = await _invoker({
      userId: job.userId,
      prompt: effectivePrompt,
      thinking: job.thinking,
      source: `${source}:${job.id}`,
    });
    Object.assign(record, completedRunOutcome(out));
  } catch (err) {
    const cancelled = err?.name === 'AbortError' || err?.code === 'E_CANCELLED' || err?.code === 'ABORT_ERR';
    record.errorCode = cancelled ? 'E_CANCELLED' : 'agent_run_failed';
    record.error = cancelled ? 'La ejecución fue cancelada.'
      : redactErrorMessage(err) || 'La ejecución falló sin confirmar el resultado.';
  } finally {
    running.delete(job.id);
    stopRenew();
    await releaseJobOverlap(claim);
  }
  record.durationMs = Date.now() - startedAt.getTime();

  // Persist run into the job's ring buffer + global jsonl log.
  const jobs = loadAll();
  const idx = jobs.findIndex(j => j.id === jobId);
  if (idx >= 0) {
    jobs[idx].lastRuns = [record, ...(jobs[idx].lastRuns || [])].slice(0, LAST_RUNS_KEEP);
    jobs[idx].lastRunAt = record.at;
    saveAll(jobs);
  }
  appendRunLog({ jobId, ...record });
  return { ok: record.ok, record };
}

function withComputedStatus(job) {
  if (!job || typeof job !== 'object') return job;
  const status = computeJobStatus(job);
  return {
    ...job,
    status,
    statusDetails: buildStatusDetails(job, status),
  };
}

function computeJobStatus(job) {
  if (!job || typeof job !== 'object') return 'skipped';
  if (!job.enabled) return 'disabled';
  if (running.has(job.id)) return 'running';

  if (job.type === 'cron') {
    const check = validateCron(job.cron);
    if (!check.ok) return 'skipped';
    if (!active.has(job.id)) return 'skipped';
  }

  const last = Array.isArray(job.lastRuns) ? job.lastRuns[0] : null;
  if (!last) return 'idle';
  return last.ok ? 'ok' : 'error';
}

function buildStatusDetails(job, status) {
  const last = Array.isArray(job?.lastRuns) ? job.lastRuns[0] : null;
  const details = {
    computedAt: new Date().toISOString(),
    lastRunAt: job?.lastRunAt || last?.at || null,
    lastRunOk: last?.ok ?? null,
    active: active.has(job?.id),
    running: running.has(job?.id),
  };
  if (job?.type === 'cron') {
    const check = validateCron(job.cron);
    details.cronValid = check.ok;
    if (!check.ok) details.reason = check.reason;
  }
  if (status === 'disabled') details.reason = 'job disabled';
  if (status === 'skipped' && !details.reason && job?.type === 'cron' && !active.has(job.id)) {
    details.reason = 'cron job is not active in this process';
  }
  if (status === 'error' && last?.error) details.reason = last.error;
  return details;
}

function interpolate(template, ctx) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, path) => {
    const parts = path.split('.');
    let cur = ctx;
    for (const p of parts) {
      if (cur == null) return '';
      cur = cur[p];
    }
    return cur == null ? '' : String(cur);
  });
}

// ─── Exports ──────────────────────────────────────────────────────────────

module.exports = {
  start, stop,
  createCronJob, createWebhookJob,
  listJobs, getJob, cancelJob, setJobEnabled,
  fireJob,
  setInvoker,
  setJobClassifier,
  validateCron,
  computeJobStatus,
  withComputedStatus,
  interpolate,
  // Exposed for tests / admin:
  _active: active,
  _running: running,
  _paths: { DATA_DIR, JOBS_FILE, RUN_LOG_FILE },
};
