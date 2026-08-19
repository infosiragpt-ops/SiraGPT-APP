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
const { withRetry } = require('../../utils/retry-with-backoff');

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

// Pluggable error classifier for retry decisions.
// Injected by the boot sequence after classifyTaskError() is loaded.
// Falls back to the default classifier (always-retryable) when unset.
let _classifier = null;
function setJobClassifier(fn) { _classifier = fn; }

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
  ensureDataDir();
  // Write via temp-file + rename for atomicity; a crash mid-write
  // won't leave a partial file that loadAll would then scrap.
  const tmp = `${JOBS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2));
  fs.renameSync(tmp, JOBS_FILE);
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

// ─── Execution ─────────────────────────────────────────────────────────────

/**
 * Run a job's prompt. Callable from cron or webhook. Does NOT throw —
 * all errors are captured into the run record so the cron thread /
 * webhook handler stays clean.
 */
async function fireJob(jobId, { source = 'cron', payload = null } = {}) {
  const job = getJob(jobId);
  if (!job) return { ok: false, reason: 'job not found' };
  if (!job.enabled) return { ok: false, reason: 'disabled' };
  if (!_invoker) {
    console.warn(`[scheduler] no invoker registered — skipping job ${jobId}`);
    return { ok: false, reason: 'no invoker' };
  }

  const startedAt = new Date();
  const record = { at: startedAt.toISOString(), source, durationMs: 0, ok: false };

  try {
    running.add(job.id);
    // Interpolate a lightweight {{payload.*}} template so webhook
    // callers can pass context. Cron jobs with no payload get the
    // plain prompt.
    const effectivePrompt = payload
      ? interpolate(job.prompt, { payload, at: startedAt.toISOString() })
      : job.prompt;

    const out = await withRetry(
      () => _invoker({
        userId: job.userId,
        prompt: effectivePrompt,
        thinking: job.thinking,
        source: `${source}:${job.id}`,
      }),
      {
        maxRetries: 2,
        baseDelayMs: 5_000,
        maxDelayMs: 60_000,
        classifyError: _classifier || undefined,
        onRetry: (info) => {
          console.warn(
            `[scheduler] retry ${info.attempt} for job ${jobId}: ` +
            `${info.reason}, waiting ${info.delayMs}ms`
          );
        },
      },
    );
    record.ok = true;
    record.answerSnippet = String(out?.answer || '').slice(0, 400);
  } catch (err) {
    record.error = err.message || String(err);
    record.retries = true;
  } finally {
    running.delete(job.id);
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
  listJobs, getJob, cancelJob,
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
