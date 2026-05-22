'use strict';

/**
 * worker-pool — Simple round-robin worker_threads pool for CPU-bound jobs.
 *
 * Spawns up to `size` workers (default `min(4, os.cpus().length)`), each
 * loaded from `workerPath`. Jobs are submitted via `pool.run(type, payload,
 * opts)` and resolve with the worker's reply (or reject on worker error /
 * timeout / pool shutdown). The pool reuses workers across jobs and recycles
 * a worker if it crashes mid-flight.
 *
 * Message protocol matches `src/workers/heavy-analysis.worker.js`:
 *   to worker:   { id, type, payload }
 *   from worker: { id, ok, result | error }
 */

const { Worker } = require('node:worker_threads');
const os = require('node:os');
const path = require('node:path');

function defaultSize() {
  const cpus = (os.cpus() || []).length || 1;
  return Math.max(1, Math.min(4, cpus));
}

class WorkerPool {
  constructor(opts = {}) {
    this.workerPath = opts.workerPath
      || path.join(__dirname, '..', 'workers', 'heavy-analysis.worker.js');
    this.size = Number.isFinite(opts.size) ? opts.size : defaultSize();
    this.defaultTimeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 30_000;
    this.workers = [];
    this.pending = new Map(); // id -> { resolve, reject, timer, workerId }
    this.cursor = 0;
    this.nextId = 1;
    this.closed = false;
    for (let i = 0; i < this.size; i++) this._spawn(i);
  }

  _spawn(idx) {
    const worker = new Worker(this.workerPath);
    const slot = { worker, idx, inflight: new Set() };
    worker.on('message', (msg) => {
      const { id } = msg || {};
      const job = this.pending.get(id);
      if (!job) return;
      this.pending.delete(id);
      slot.inflight.delete(id);
      clearTimeout(job.timer);
      if (msg.ok) job.resolve(msg.result);
      else job.reject(new Error(msg.error?.message || 'worker error'));
    });
    worker.on('error', (err) => {
      this._rejectInflight(slot, err);
      // Replace the crashed worker if the pool is still open
      if (!this.closed) this._replace(idx);
    });
    worker.on('exit', () => {
      // If unexpected exit (pool not closed), the 'error' handler usually
      // fires first; otherwise rejected/cleaned via close()
      if (!this.closed && this.workers[idx] === slot) {
        this._rejectInflight(slot, new Error('worker exited'));
        this._replace(idx);
      }
    });
    this.workers[idx] = slot;
  }

  _rejectInflight(slot, err) {
    for (const id of slot.inflight) {
      const job = this.pending.get(id);
      if (job) {
        clearTimeout(job.timer);
        this.pending.delete(id);
        job.reject(err);
      }
    }
    slot.inflight.clear();
  }

  _replace(idx) {
    try { this.workers[idx]?.worker?.terminate?.(); } catch (_) { /* ignore */ }
    this._spawn(idx);
  }

  run(type, payload, opts = {}) {
    if (this.closed) return Promise.reject(new Error('worker-pool closed'));
    const id = this.nextId++;
    const slot = this.workers[this.cursor];
    this.cursor = (this.cursor + 1) % this.workers.length;
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : this.defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          slot.inflight.delete(id);
          reject(new Error(`worker-pool: job ${type} timed out after ${timeoutMs}ms`));

          // A timeout usually means the worker thread is blocked inside a
          // CPU-bound operation (for example a pathological regex). Recycle it
          // immediately so the next queued job does not inherit the stuck
          // thread. Any other in-flight work assigned to the same worker cannot
          // make forward progress either, so fail those jobs explicitly.
          this._rejectInflight(slot, new Error('worker-pool: worker recycled after job timeout'));
          if (!this.closed) this._replace(slot.idx);
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, workerId: slot.idx });
      slot.inflight.add(id);
      try {
        slot.worker.postMessage({ id, type, payload });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        slot.inflight.delete(id);
        reject(err);
      }
    });
  }

  stats() {
    return {
      size: this.size,
      workers: this.workers.length,
      pending: this.pending.size,
      closed: this.closed,
    };
  }

  async close() {
    this.closed = true;
    // Reject all inflight
    for (const [id, job] of this.pending) {
      clearTimeout(job.timer);
      job.reject(new Error('worker-pool closed'));
      this.pending.delete(id);
    }
    await Promise.all(this.workers.map(async (slot) => {
      try { await slot.worker.terminate(); } catch (_) { /* ignore */ }
    }));
    this.workers = [];
  }
}

let _shared = null;
function getSharedPool(opts) {
  if (!_shared) _shared = new WorkerPool(opts);
  return _shared;
}
function resetSharedPool() {
  if (_shared) { _shared.close().catch(() => {}); _shared = null; }
}

module.exports = {
  WorkerPool,
  getSharedPool,
  resetSharedPool,
  defaultSize,
};
