'use strict';

/**
 * p-map.js — map over an iterable with bounded concurrency.
 *
 * `Promise.all(items.map(fn))` runs everything at once; for I/O-bound fan-out
 * (provider calls, file processing, DB writes) that floods the downstream.
 * pMap caps the in-flight count via the shared Semaphore primitive while
 * preserving input order in the results array.
 *
 *   const out = await pMap(urls, (url, i) => fetchJson(url), { concurrency: 5 });
 *
 * Options:
 *   concurrency   number >=1 or Infinity (default Infinity = no cap)
 *   stopOnError   default true  → reject on the first error (Promise.all-like)
 *                 false         → run all, then throw an AggregateError of every
 *                                 failure (successful slots keep their values)
 *
 * Pure, dependency-free, side-effect-free on require.
 */

const { Semaphore } = require('./async-semaphore');

async function pMap(iterable, mapper, opts = {}) {
    if (typeof mapper !== 'function') {
        throw new TypeError('pMap: mapper must be a function');
    }
    const items = Array.from(iterable);
    const concurrency = opts.concurrency === undefined ? Infinity : opts.concurrency;
    if (concurrency !== Infinity && (!Number.isInteger(concurrency) || concurrency < 1)) {
        throw new TypeError(`pMap: concurrency must be a positive integer or Infinity, got ${concurrency}`);
    }
    const stopOnError = opts.stopOnError !== false;
    const results = new Array(items.length);
    if (items.length === 0) return results;

    const max = concurrency === Infinity ? items.length : Math.min(concurrency, items.length);
    const sem = new Semaphore(max);
    const errors = [];
    let aborted = false;

    const tasks = items.map((item, index) => sem.run(async () => {
        if (aborted) return; // a stopOnError failure already happened — don't start new work
        try {
            results[index] = await mapper(item, index);
        } catch (err) {
            if (stopOnError) { aborted = true; throw err; }
            errors.push(err);
        }
    }));

    if (stopOnError) {
        await Promise.all(tasks); // first rejection propagates
        return results;
    }

    await Promise.allSettled(tasks);
    if (errors.length > 0) {
        throw new AggregateError(errors, `pMap: ${errors.length} of ${items.length} tasks failed`);
    }
    return results;
}

module.exports = { pMap };
