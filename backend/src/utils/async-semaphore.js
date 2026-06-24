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
 *   - `run()` releases its permit even if the task throws (sync or async),
 *   - an `AbortSignal`-cancelled queued waiter is removed from the queue and
 *     never consumes a permit (no leak); abort after the grant is a no-op —
 *     the caller already holds the release function.
 *
 * Pure, dependency-free, side-effect-free on require.
 *
 *   const sem = new Semaphore(4);
 *   const release = await sem.acquire(); try { ... } finally { release(); }
 *   await sem.run(() => doWork());                      // acquire+release for you
 *   await sem.run(() => doWork(), { signal });          // cancellable while queued
 *
 *   const limit = createLimiter(4);
 *   await Promise.all(items.map(it => limit(() => process(it))));
 */

function _assertPositiveInt(max, who) {
    if (!Number.isInteger(max) || max < 1) {
        throw new TypeError(`${who}: max must be a positive integer, got ${max}`);
    }
}

function _validateSignal(signal, who) {
    if (signal === undefined || signal === null) return null;
    if (typeof signal !== 'object' || typeof signal.addEventListener !== 'function'
        || typeof signal.removeEventListener !== 'function') {
        throw new TypeError(`${who}: options.signal must be an AbortSignal`);
    }
    return signal;
}

function _abortError(signal) {
    // Prefer the caller-supplied abort reason; fall back to a standard AbortError.
    if (signal && signal.reason !== undefined && signal.reason !== null) {
        return signal.reason;
    }
    const err = new Error('aborted before a semaphore permit was granted');
    err.name = 'AbortError';
    return err;
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
     *
     * @param {{ signal?: AbortSignal }} [options] — optional AbortSignal: an
     *   already-aborted signal rejects immediately; aborting while queued
     *   removes the waiter (no permit is ever consumed); aborting after the
     *   grant is ignored — the caller holds the release function by then.
     * @returns {Promise<() => void>}
     */
    acquire(options) {
        const signal = _validateSignal(options && options.signal, 'Semaphore.acquire');
        if (signal && signal.aborted) {
            return Promise.reject(_abortError(signal));
        }
        return new Promise((resolve, reject) => {
            let onAbort = null;
            const grant = () => {
                if (signal && onAbort) signal.removeEventListener('abort', onAbort);
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
                return;
            }
            this._queue.push(grant);
            if (signal) {
                onAbort = () => {
                    const idx = this._queue.indexOf(grant);
                    if (idx === -1) return;    // already granted — abort is a no-op
                    this._queue.splice(idx, 1); // dequeue: never consumes a permit
                    reject(_abortError(signal));
                };
                signal.addEventListener('abort', onAbort, { once: true });
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
     * rethrowing its error (sync throw or async rejection alike). The permit
     * is always returned.
     *
     * @param {() => any} fn
     * @param {{ signal?: AbortSignal }} [options] — forwarded to acquire();
     *   if aborted while queued, `fn` is never invoked and no permit is used.
     */
    async run(fn, options) {
        if (typeof fn !== 'function') {
            throw new TypeError('Semaphore.run: fn must be a function');
        }
        const release = await this.acquire(options);
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
    const limit = (fn, options) => sem.run(fn, options);
    Object.defineProperties(limit, {
        active: { get: () => sem.active },
        pending: { get: () => sem.pending },
        available: { get: () => sem.available },
        max: { get: () => sem.max },
    });
    return limit;
}

module.exports = { Semaphore, createLimiter };
