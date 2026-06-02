'use strict';

/**
 * async-semaphore.js — bound the number of in-flight async operations.
 *
 * A counting semaphore with a FIFO waiter queue, plus a p-limit-style
 * `createLimiter` wrapper. Use it to cap fan-out that would otherwise hammer
 * a provider / DB / filesystem all at once (batch document processing,
 * parallel provider calls, etc.) — work still completes, but never more than
 * `max` at a time.
 *
 * Guarantees:
 *   - never more than `max` permits handed out concurrently,
 *   - FIFO fairness (waiters served in arrival order),
 *   - release is idempotent (double-release can't leak extra permits),
 *   - `run()` releases its permit even if the task throws.
 *
 * Pure, dependency-free, side-effect-free on require.
 *
 *   const sem = new Semaphore(4);
 *   const release = await sem.acquire(); try { ... } finally { release(); }
 *   await sem.run(() => doWork());                      // acquire+release for you
 *
 *   const limit = createLimiter(4);
 *   await Promise.all(items.map(it => limit(() => process(it))));
 */

function _assertPositiveInt(max, who) {
    if (!Number.isInteger(max) || max < 1) {
        throw new TypeError(`${who}: max must be a positive integer, got ${max}`);
    }
}

class Semaphore {
    constructor(max) {
        _assertPositiveInt(max, 'Semaphore');
        this._max = max;
        this._active = 0;
        this._queue = []; // FIFO of pending resolvers
    }

    get max() { return this._max; }
    get active() { return this._active; }
    get pending() { return this._queue.length; }
    get available() { return Math.max(0, this._max - this._active); }

    /**
     * Acquire a permit. Resolves with a one-shot release function. Awaiting
     * blocks (queues) when all permits are in use.
     * @returns {Promise<() => void>}
     */
    acquire() {
        return new Promise((resolve) => {
            const grant = () => {
                this._active += 1;
                let released = false;
                resolve(() => {
                    if (released) return;      // idempotent — no double-free
                    released = true;
                    this._active -= 1;
                    this._drain();
                });
            };
            if (this._active < this._max) {
                grant();
            } else {
                this._queue.push(grant);
            }
        });
    }

    _drain() {
        // Hand the freed permit to the next waiter, if any.
        if (this._queue.length > 0 && this._active < this._max) {
            const next = this._queue.shift();
            next();
        }
    }

    /**
     * Acquire, run `fn`, and release in a finally — returning fn's result or
     * rethrowing its error. The permit is always returned.
     */
    async run(fn) {
        if (typeof fn !== 'function') {
            throw new TypeError('Semaphore.run: fn must be a function');
        }
        const release = await this.acquire();
        try {
            return await fn();
        } finally {
            release();
        }
    }
}

/**
 * p-limit-style helper: returns `limit(fn)` that runs `fn` under a shared
 * Semaphore(max). Exposes `.active` / `.pending` / `.max` for observability.
 */
function createLimiter(max) {
    _assertPositiveInt(max, 'createLimiter');
    const sem = new Semaphore(max);
    const limit = (fn) => sem.run(fn);
    Object.defineProperties(limit, {
        active: { get: () => sem.active },
        pending: { get: () => sem.pending },
        available: { get: () => sem.available },
        max: { get: () => sem.max },
    });
    return limit;
}

module.exports = { Semaphore, createLimiter };
