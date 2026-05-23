/**
 * job.js — Scheduler Job descriptor.
 *
 * States: idle | running | ok | error | skipped | disabled
 *
 * idle     → known, never run yet (or pending next tick)
 * running  → currently executing
 * ok       → last run succeeded
 * error    → last run failed (after retries exhausted)
 * skipped  → tick fired while still running (overlap prevented)
 * disabled → enabled=false; scheduler will not tick it
 */

'use strict';

const { parseSchedule, nextAfter } = require('./cron');

const STATE = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  OK: 'ok',
  ERROR: 'error',
  SKIPPED: 'skipped',
  DISABLED: 'disabled',
});

class Job {
  /**
   * @param {object} cfg
   * @param {string} cfg.id                   — stable job identifier
   * @param {string} [cfg.name]
   * @param {string} cfg.schedule             — cron expr or "every Ns"
   * @param {Function} cfg.handler            — async (ctx) => any
   * @param {boolean} [cfg.enabled=true]
   * @param {number} [cfg.timeoutMs=60_000]
   * @param {number} [cfg.maxRetries=0]       — extra attempts after first failure
   * @param {number} [cfg.backoffMs=1000]     — base backoff
   * @param {number} [cfg.backoffFactor=2]
   * @param {number} [cfg.maxBackoffMs=60_000]
   */
  constructor(cfg) {
    if (!cfg || !cfg.id) throw new Error('Job requires id');
    if (!cfg.schedule) throw new Error('Job requires schedule');
    if (typeof cfg.handler !== 'function') throw new Error('Job requires handler function');

    this.id = String(cfg.id);
    this.name = cfg.name || this.id;
    this.scheduleExpr = String(cfg.schedule);
    this.parsed = parseSchedule(this.scheduleExpr);
    this.handler = cfg.handler;
    this.enabled = cfg.enabled !== false;

    this.timeoutMs = Number.isFinite(cfg.timeoutMs) ? cfg.timeoutMs : 60_000;
    this.maxRetries = Number.isFinite(cfg.maxRetries) ? cfg.maxRetries : 0;
    this.backoffMs = Number.isFinite(cfg.backoffMs) ? cfg.backoffMs : 1000;
    this.backoffFactor = Number.isFinite(cfg.backoffFactor) ? cfg.backoffFactor : 2;
    this.maxBackoffMs = Number.isFinite(cfg.maxBackoffMs) ? cfg.maxBackoffMs : 60_000;

    // Mutable runtime state
    this.state = this.enabled ? STATE.IDLE : STATE.DISABLED;
    this.nextRunAt = null;
    this.lastRunAt = null;
    this.lastFinishedAt = null;
    this.lastDurationMs = null;
    this.lastError = null;
    this.runCount = 0;
    this.successCount = 0;
    this.failureCount = 0;
    this.skippedCount = 0;
    this.currentRunId = null;
  }

  computeNextRun(from = new Date()) {
    if (!this.enabled) {
      this.nextRunAt = null;
      return null;
    }
    this.nextRunAt = nextAfter(this.parsed, from);
    return this.nextRunAt;
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (!this.enabled) {
      this.state = STATE.DISABLED;
      this.nextRunAt = null;
    } else if (this.state === STATE.DISABLED) {
      this.state = STATE.IDLE;
    }
  }

  computeBackoff(attempt) {
    const exp = Math.min(this.maxBackoffMs, this.backoffMs * (this.backoffFactor ** attempt));
    // 0–25% jitter
    const jitter = Math.random() * 0.25 * exp;
    return Math.floor(exp + jitter);
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      schedule: this.scheduleExpr,
      enabled: this.enabled,
      state: this.state,
      nextRunAt: this.nextRunAt ? this.nextRunAt.toISOString() : null,
      lastRunAt: this.lastRunAt ? this.lastRunAt.toISOString() : null,
      lastFinishedAt: this.lastFinishedAt ? this.lastFinishedAt.toISOString() : null,
      lastDurationMs: this.lastDurationMs,
      lastError: this.lastError ? { message: this.lastError.message, name: this.lastError.name } : null,
      runCount: this.runCount,
      successCount: this.successCount,
      failureCount: this.failureCount,
      skippedCount: this.skippedCount,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
    };
  }
}

module.exports = { Job, STATE };
