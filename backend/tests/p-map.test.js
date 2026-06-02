'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { pMap } = require('../src/utils/p-map');

const tick = () => new Promise((r) => setImmediate(r));
function defer() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

test('preserves input order in results', async () => {
    const out = await pMap([10, 20, 30], async (x) => x * 2);
    assert.deepEqual(out, [20, 40, 60]);
});

test('mapper receives (item, index)', async () => {
    const out = await pMap(['a', 'b', 'c'], async (x, i) => `${x}${i}`);
    assert.deepEqual(out, ['a0', 'b1', 'c2']);
});

test('empty iterable resolves to []', async () => {
    assert.deepEqual(await pMap([], async (x) => x), []);
});

test('rejects on non-function mapper / bad concurrency', async () => {
    await assert.rejects(() => pMap([1], null), /mapper must be a function/);
    await assert.rejects(() => pMap([1], async (x) => x, { concurrency: 0 }), /positive integer or Infinity/);
    await assert.rejects(() => pMap([1], async (x) => x, { concurrency: 2.5 }), /positive integer or Infinity/);
});

test('bounds concurrency to the configured limit', async () => {
    let live = 0, peak = 0;
    const defers = Array.from({ length: 6 }, () => defer());
    const all = pMap(defers, async (d) => {
        live += 1; peak = Math.max(peak, live);
        await d.promise;
        live -= 1;
        return 'ok';
    }, { concurrency: 2 });
    await tick();
    assert.equal(live, 2, 'only `concurrency` tasks run at once');
    for (const d of defers) { d.resolve(); await tick(); }
    const out = await all;
    assert.ok(peak <= 2, `peak ${peak} <= 2`);
    assert.equal(out.length, 6);
});

test('stopOnError (default) rejects with the first error', async () => {
    await assert.rejects(
        pMap([1, 2, 3], async (x) => { if (x === 2) throw new Error('bad-2'); return x; }, { concurrency: 1 }),
        /bad-2/,
    );
});

test('stopOnError:false runs all and throws an AggregateError of failures', async () => {
    let ran = 0;
    await assert.rejects(
        pMap([1, 2, 3, 4], async (x) => {
            ran += 1;
            if (x % 2 === 0) throw new Error(`even-${x}`);
            return x;
        }, { concurrency: 2, stopOnError: false }),
        (err) => {
            assert.ok(err instanceof AggregateError);
            assert.equal(err.errors.length, 2);
            const msgs = err.errors.map((e) => e.message).sort();
            assert.deepEqual(msgs, ['even-2', 'even-4']);
            return true;
        },
    );
    assert.equal(ran, 4, 'all tasks ran despite failures');
});

test('Infinity concurrency runs everything at once', async () => {
    let live = 0, peak = 0;
    const defers = Array.from({ length: 5 }, () => defer());
    const all = pMap(defers, async (d) => { live += 1; peak = Math.max(peak, live); await d.promise; live -= 1; });
    await tick();
    assert.equal(peak, 5, 'no cap → all 5 in flight');
    for (const d of defers) d.resolve();
    await all;
});
