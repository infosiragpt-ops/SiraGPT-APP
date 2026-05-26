/**
 * scheduler.js — Scheduler engine.
 *
 * Responsibilities:
 *   - Register jobs, persist their definitions.
 *   - Tick on a fixed interval; trigger any job whose nextRunAt <= now.
 *   - Run handlers under a per-job lock to prevent overlap (skipped state).
 *   - Idempotent run recording keyed by runId.
 *   - Configurable retries with exponential backoff + jitter.
 *   - Emits events: 'state' | 'run' | 'jobError' | 'skip'.
 *     ('error' is intentionally avoided — EventEmitter would throw without a
 *     listener; 'jobError' carries the same payload safely.)
 *
 * Time:
 *   The engine consults `now()` (injectable) on every tick so tests can drive
 *   it deterministically with Node's MockTimers.
 */

'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

const { Job, STATE } = require('./job');
const { InMemoryStore } = require('./store');

const DEFAULT_TICK_MS = 1000;
const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000;

class Scheduler extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {object} [opts.store]            — store impl (default: InMemoryStore)
   * @param {number} [opts.tickMs=1000]
   * @param {number} [opts.lockTtlMs]
   * @param {string} [opts.ownerToken]       — node identity for lock ownership
   * @param {() => Date} [opts.now]
   * @param {(level, msg, meta) => void} [opts.logger]
   */
  constructor(opts = {}) {
    super();
    this.store = opts.store || new InMemoryStore();
    this.tickMs = Number.isFinite(opts.tickMs) ? opts.tickMs : DEFAULT_TICK_MS;
    this.lockTtlMs = Number.isFinite(opts.lockTtlMs) ? opts.lockTtlMs : DEFAULT_LOCK_TTL_MS;
    this.ownerToken = opts.ownerToken || `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    this.now = typeof opts.now === 'function' ? opts.now : () => new Date();
    this.logger = typeof opts.logger === 'function' ? opts.logger : () => {};

    this.jobs = new Map();    // id -> Job
    this._timer = null;
    this._running = false;
    this._tickInFlight = false;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async register(cfg) {
    const job = cfg instanceof Job ? cfg : new Job(cfg);
    job.computeNextRun(this.now());
    this.jobs.set(job.id, job);
    await this.store.upsertJob({
      id: job.id,
      name: job.name,
      schedule: job.scheduleExpr,
      enabled: job.enabled,
      state: job.state,
      nextRunAt: job.nextRunAt,
      lastRunAt: null,
      lastError: null,
      runCount: 0,
      successCount: 0,
      failureCount: 0,
    });
    this.emit('state', { jobId: job.id, state: job.state });
    return job;
  }

  setEnabled(id, enabled) {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.setEnabled(enabled);
    if (job.enabled) job.computeNextRun(this.now());
    this.store.updateJobState(id, {
      enabled: job.enabled,
      state: job.state,
      nextRunAt: job.nextRunAt,
    }).catch(err => this.logger('warn', 'updateJobState failed', { err: err.message }));
    this.emit('state', { jobId: id, state: job.state });
    return true;
  }

  start() {
    if (this._running) return;
    this._running = true;
    const loop = () => {
      if (!this._running) return;
      this._timer = setTimeout(async () => {
        try { await this.tick(); } catch (e) { this.logger('error', 'tick error', { err: e.message }); }
        loop();
      }, this.tickMs);
      // Allow process to exit if scheduler is the only thing alive (tests).
      if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    };
    loop();
  }

  async stop() {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    // Wait for in-flight tick to settle.
    if (this._tickInFlight) {
      await new Promise(resolve => {
        const check = () => (this._tickInFlight ? setTimeout(check, 5) : resolve());
        check();
      });
    }
  }

  // ── Tick ─────────────────────────────────────────────────────────────────

  async tick() {
    if (this._tickInFlight) return;
    this._tickInFlight = true;
    try {
      const now = this.now();
      const due = [];
      for (const job of this.jobs.values()) {
        if (!job.enabled) continue;
        if (job.state === STATE.RUNNING) continue;
        if (job.nextRunAt && job.nextRunAt.getTime() <= now.getTime()) due.push(job);
      }
      // Fire all due jobs concurrently; each enforces its own lock.
      await Promise.all(due.map(j => this._dispatch(j, now)));
    } finally {
      this._tickInFlight = false;
    }
  }

  async _dispatch(job, now) {
    const runId = `${job.id}:${now.getTime()}:${crypto.randomBytes(3).toString('hex')}`;
    const acquired = await this.store.tryAcquireLock(job.id, runId, this.ownerToken, this.lockTtlMs);
    if (!acquired) {
      job.state = STATE.SKIPPED;
      job.skippedCount += 1;
      // Re-arm next run so we don't busy-loop on a held lock.
      job.computeNextRun(now);
      await this.store.updateJobState(job.id, { state: job.state, nextRunAt: job.nextRunAt });
      this.emit('skip', { jobId: job.id, reason: 'lock_held', runId });
      return;
    }
    await this._executeWithRetries(job, runId, now);
  }

  async _executeWithRetries(job, runId, scheduledFor) {
    job.state = STATE.RUNNING;
    job.lastRunAt = this.now();
    job.runCount += 1;
    job.currentRunId = runId;
    await this.store.updateJobState(job.id, { state: job.state, lastRunAt: job.lastRunAt, runCount: job.runCount });
    this.emit('state', { jobId: job.id, state: job.state, runId });

    await this.store.recordRun({
      runId,
      jobId: job.id,
      startedAt: job.lastRunAt,
      status: 'running',
      attempt: 0,
    });

    let lastErr = null;
    let success = false;
    const totalAttempts = 1 + Math.max(0, job.maxRetries);
    for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
      try {
        await this._invokeWithTimeout(job, { runId, attempt, scheduledFor });
        success = true;
        break;
      } catch (err) {
        lastErr = err;
        this.logger('warn', `job ${job.id} attempt ${attempt} failed`, { err: err.message });
        if (attempt < totalAttempts - 1) {
          await sleep(job.computeBackoff(attempt));
        }
      }
    }

    const finishedAt = this.now();
    job.lastFinishedAt = finishedAt;
    job.lastDurationMs = finishedAt.getTime() - job.lastRunAt.getTime();

    if (success) {
      job.state = STATE.OK;
      job.successCount += 1;
      job.lastError = null;
      this.emit('run', { jobId: job.id, runId, ok: true, durationMs: job.lastDurationMs });
    } else {
      job.state = STATE.ERROR;
      job.failureCount += 1;
      job.lastError = lastErr;
      this.emit('jobError', { jobId: job.id, runId, error: lastErr });
    }

    job.currentRunId = null;
    job.computeNextRun(finishedAt);

    await this.store.updateRun(runId, {
      finishedAt,
      status: success ? 'ok' : 'error',
      attempt: totalAttempts - (success ? 0 : 1),
      error: lastErr ? String(lastErr.message || lastErr) : null,
      durationMs: job.lastDurationMs,
    });
    await this.store.updateJobState(job.id, {
      state: job.state,
      nextRunAt: job.nextRunAt,
      successCount: job.successCount,
      failureCount: job.failureCount,
      lastError: lastErr ? String(lastErr.message || lastErr) : null,
    });
    await this.store.releaseLock(job.id, this.ownerToken);
    this.emit('state', { jobId: job.id, state: job.state, runId });
  }

  async _invokeWithTimeout(job, ctx) {
    if (!Number.isFinite(job.timeoutMs) || job.timeoutMs <= 0) {
      return job.handler(ctx);
    }
    let timer;
    let resolveTimeout;
    const timeoutPromise = new Promise((resolve, reject) => {
      resolveTimeout = resolve;
      timer = setTimeout(
        () => reject(new Error(`job ${job.id} timed out after ${job.timeoutMs}ms`)),
        job.timeoutMs,
      );
    });
    try {
      const handlerPromise = Promise.resolve().then(() => job.handler(ctx));
      // Swallow late handler rejections after a timeout so they don't surface
      // as unhandled rejections in node:test.
      handlerPromise.catch(() => {});
      return await Promise.race([handlerPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
      if (resolveTimeout) resolveTimeout();
    }
  }

  // ── Introspection ────────────────────────────────────────────────────────

  status() {
    const jobs = [...this.jobs.values()].map(j => j.toJSON());
    return {
      ownerToken: this.ownerToken,
      tickMs: this.tickMs,
      running: this._running,
      jobCount: jobs.length,
      now: this.now().toISOString(),
      jobs,
    };
  }
}

function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

module.exports = { Scheduler };
