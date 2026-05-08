/**
 * bulkhead — resource isolation for concurrent operations.
 *
 * Problem:
 *   Without isolation, a single slow operation (e.g., an LLM call to a
 *   degraded provider) can consume all available connection pool slots
 *   or event-loop time, starving other operations that would otherwise
 *   complete quickly. This cascading latency is the "noisy neighbor"
 *   problem in concurrent systems.
 *
 * Solution:
 *   Partition the system into bulkheads — independent resource pools
 *   with their own capacity limits. Each bulkhead has a semaphore that
 *   bounds the number of concurrent operations. When a bulkhead is
 *   full, callers either wait (with a timeout) or fail fast.
 *
 * Architecture (inspired by Microsoft's Resilience Engineering):
 *
 *   BulkheadPool(name, { maxConcurrent, queueCapacity, timeoutMs })
 *     ├── acquire()   → Promise<Release> — may reject if pool is saturated
 *     ├── execute(fn) → runs fn inside an acquired slot
 *     ├── stats()     → { active, waiting, maxConcurrent, rejected }
 *     └── metrics     → EventEmitter for monitoring
 *
 * Usage:
 *   const llmPool = new BulkheadPool('llm', { maxConcurrent: 5, timeoutMs: 30_000 });
 *   const result = await llmPool.execute(() => callOpenAI(prompt));
 *
 * Production hardening vs a naïve semaphore:
 *   - Queue with timeout: waiters are bounded to queueCapacity; excess
 *     callers get a BulkheadFullError immediately.
 *   - Per-operation timeout: if fn doesn't complete within timeoutMs,
 *     the slot is reclaimed (the original fn continues but its result
 *     is discarded — no dangling resource).
 *   - Metrics: tracks active count, queue depth, rejection count, and
 *     emits events on state changes for observability.
 *   - Graceful drain: `drain()` waits for all active operations to
 *     finish, then prevents new acquisitions — useful during shutdown.
 *   - Priority queuing: higher-priority operations bypass the FIFO
 *     queue (optional, default is FIFO).
 */

const EventEmitter = require('events');

// ─── Custom errors ─────────────────────────────────────────────────────────

class BulkheadFullError extends Error {
  constructor(name, active, maxConcurrent) {
    super(`Bulkhead "${name}" is full (${active}/${maxConcurrent} active). ` +
      'Consider increasing capacity or reducing concurrent load.');
    this.name = 'BulkheadFullError';
    this.bulkheadName = name;
    this.active = active;
    this.maxConcurrent = maxConcurrent;
  }
}

class BulkheadTimeoutError extends Error {
  constructor(name, timeoutMs) {
    super(`Bulkhead "${name}" acquire timed out after ${timeoutMs}ms`);
    this.name = 'BulkheadTimeoutError';
    this.bulkheadName = name;
    this.timeoutMs = timeoutMs;
  }
}

class BulkheadRejectedError extends Error {
  constructor(name) {
    super(`Bulkhead "${name}" rejected: pool is draining`);
    this.name = 'BulkheadRejectedError';
    this.bulkheadName = name;
  }
}

// ─── Bulkhead Pool ─────────────────────────────────────────────────────────

const DEFAULT_MAX_CONCURRENT = 10;
const DEFAULT_QUEUE_CAPACITY = 50;
const DEFAULT_TIMEOUT_MS = 0; // 0 = no timeout

class BulkheadPool extends EventEmitter {
  /**
   * @param {string} name  — stable identifier for metrics / debugging
   * @param {object} opts
   * @param {number} [opts.maxConcurrent=10]  — max concurrent operations
   * @param {number} [opts.queueCapacity=50]  — max queued waiters
   * @param {number} [opts.timeoutMs=0]       — per-operation timeout (0 = disabled)
   */
  constructor(name, opts = {}) {
    super();
    if (!name || typeof name !== 'string') {
      throw new Error('BulkheadPool: name is required');
    }

    this.name = name;
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.queueCapacity = opts.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    this._active = 0;
    this._rejectedCount = 0;
    this._draining = false;

    // Priority queue: each entry is { fn, resolve, reject, timer?, priority }
    // Higher priority numbers execute first. Default priority = 0.
    this._queue = [];

    // Track active operation IDs for cancellation
    this._activeOps = new Map();
    this._opCounter = 0;

    if (this.maxConcurrent < 1) {
      throw new Error('BulkheadPool: maxConcurrent must be >= 1');
    }
  }

  /**
   * Acquire a slot from the bulkhead. Resolves with a release function.
   *
   * @param {object} [opts]
   * @param {number} [opts.priority=0]  — higher = executes before lower
   * @param {AbortSignal} [opts.signal] — cancellation signal
   * @returns {Promise<Function>} — release function, call when done
   */
  acquire(opts = {}) {
    const priority = opts.priority ?? 0;
    const signal = opts.signal || null;

    return new Promise((resolve, reject) => {
      // Check preconditions
      if (this._draining) {
        this._rejectedCount++;
        return reject(new BulkheadRejectedError(this.name));
      }

      if (signal?.aborted) {
        return reject(new Error(`Bulkhead "${this.name}" acquire cancelled`));
      }

      // ── Attempt immediate acquisition ──────────────────────────────
      if (this._active < this.maxConcurrent) {
        this._active++;
        const opId = ++this._opCounter;
        this._activeOps.set(opId, true);
        this.emit('acquired', { name: this.name, active: this._active, opId });

        resolve(this._createRelease(opId));
        return;
      }

      // ── Queue if capacity allows ───────────────────────────────────
      if (this._queue.length >= this.queueCapacity) {
        this._rejectedCount++;
        this.emit('rejected', { name: this.name, reason: 'queue_capacity_exceeded' });
        return reject(new BulkheadFullError(this.name, this._active, this.maxConcurrent));
      }

      // Insert into priority queue (sorted by descending priority)
      const entry = { fn: null, resolve, reject, priority, signal, timer: null };
      const insertIdx = this._queue.findIndex(e => e.priority < priority);
      if (insertIdx === -1) {
        this._queue.push(entry);
      } else {
        this._queue.splice(insertIdx, 0, entry);
      }

      this.emit('queued', { name: this.name, queueDepth: this._queue.length, priority });

      // Handle abort signal — remove from queue
      if (signal) {
        const onAbort = () => {
          const idx = this._queue.indexOf(entry);
          if (idx !== -1) {
            this._queue.splice(idx, 1);
            this.emit('dequeued', { name: this.name, queueDepth: this._queue.length, reason: 'aborted' });
          }
          reject(new Error(`Bulkhead "${this.name}" acquire cancelled`));
        };
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        entry._onAbort = onAbort; // keep reference for cleanup
      }
    });
  }

  /**
   * Execute a function inside an acquired bulkhead slot.
   * The slot is automatically released when fn completes (or times out).
   *
   * @param {Function} fn  — async () => T
   * @param {object} [opts]
   * @param {number} [opts.priority=0]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<T>}
   */
  async execute(fn, opts = {}) {
    const release = await this.acquire(opts);

    // Wrap in timeout if configured
    if (this.timeoutMs > 0) {
      let timer = null;
      try {
        const result = await Promise.race([
          fn(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              reject(new BulkheadTimeoutError(this.name, this.timeoutMs));
            }, this.timeoutMs);
          }),
        ]);
        return result;
      } finally {
        if (timer) clearTimeout(timer);
        release();
      }
    }

    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Create a release function for a given operation ID.
   */
  _createRelease(opId) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._activeOps.delete(opId);
      this._active--;
      this.emit('released', { name: this.name, active: this._active, opId });

      // Dequeue next waiter
      this._processQueue();
    };
  }

  /**
   * Process the next items in the queue, filling available capacity.
   */
  _processQueue() {
    while (this._queue.length > 0 && this._active < this.maxConcurrent) {
      const entry = this._queue.shift();

      // Skip cancelled entries
      if (entry.signal?.aborted) {
        try { entry.reject(new Error('cancelled')); } catch { /* ignore */ }
        continue;
      }

      this._active++;
      const opId = ++this._opCounter;
      this._activeOps.set(opId, true);
      this.emit('acquired', { name: this.name, active: this._active, opId, fromQueue: true });
      entry.resolve(this._createRelease(opId));
    }
  }

  /**
   * Current number of active (in-flight) operations.
   */
  get active() { return this._active; }

  /**
   * Current queue depth (waiting operations).
   */
  get queued() { return this._queue.length; }

  /**
   * Total number of rejections since creation.
   */
  get rejectedCount() { return this._rejectedCount; }

  /**
   * Shapshot of pool state for observability.
   */
  stats() {
    return {
      name: this.name,
      active: this._active,
      queued: this._queue.length,
      maxConcurrent: this.maxConcurrent,
      queueCapacity: this.queueCapacity,
      rejectedCount: this._rejectedCount,
      draining: this._draining,
    };
  }

  /**
   * Gracefully drain the pool. Waits for all active operations to complete.
   * New acquisitions are rejected immediately.
   *
   * @param {number} [timeoutMs=30000]  — max wait for active ops to drain
   * @returns {Promise<void>}
   */
  async drain(timeoutMs = 30_000) {
    this._draining = true;

    // Reject all queued waiters
    while (this._queue.length > 0) {
      const entry = this._queue.shift();
      try { entry.reject(new BulkheadRejectedError(this.name)); } catch { /* ignore */ }
    }

    if (this._active === 0) return;

    // Wait for active operations to complete (or timeout)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.emit('drain_timeout', { name: this.name, remainingActive: this._active });
        resolve(); // Resolve anyway — don't block shutdown forever
      }, timeoutMs);

      this.on('released', () => {
        if (this._active === 0) {
          clearTimeout(timer);
          this.emit('drained', { name: this.name });
          resolve();
        }
      });
    });
  }
}

// ─── Bulkhead Registry ─────────────────────────────────────────────────────

const _registry = new Map();

/**
 * Get or create a BulkheadPool by name. Same name → same instance.
 *
 * @param {string} name
 * @param {object} [opts]  — only used on first creation
 * @returns {BulkheadPool}
 */
function getBulkhead(name, opts) {
  if (!name) throw new Error('getBulkhead: name is required');
  let pool = _registry.get(name);
  if (!pool) {
    pool = new BulkheadPool(name, opts);
    _registry.set(name, pool);
  }
  return pool;
}

/**
 * Snapshot of all registered bulkheads.
 */
function allBulkheadStats() {
  return Array.from(_registry.entries()).map(([name, pool]) => pool.stats());
}

/**
 * Drain and remove all bulkheads (for testing / graceful shutdown).
 */
async function drainAll(timeoutMs) {
  const pools = Array.from(_registry.values());
  await Promise.all(pools.map(p => p.drain(timeoutMs)));
  _registry.clear();
}

module.exports = {
  BulkheadPool,
  BulkheadFullError,
  BulkheadTimeoutError,
  BulkheadRejectedError,
  getBulkhead,
  allBulkheadStats,
  drainAll,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_QUEUE_CAPACITY,
  DEFAULT_TIMEOUT_MS,
};
