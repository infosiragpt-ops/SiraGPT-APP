'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { Semaphore, createLimiter } = require('../src/utils/async-semaphore');

const tick = () => new Promise((r) => setImmediate(r));
function defer() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

test('constructor / createLimiter reject a non-positive-int max', () => {
    assert.throws(() => new Semaphore(0), /positive integer/);
    assert.throws(() => new Semaphore(-1), /positive integer/);
    assert.throws(() => new Semaphore(1.5), /positive integer/);
    assert.throws(() => createLimiter(0), /positive integer/);
});

test('run returns the task result and releases the permit', async () => {
    const sem = new Semaphore(1);
    assert.equal(await sem.run(async () => 42), 42);
    assert.equal(sem.active, 0);
    assert.equal(sem.available, 1);
});

test('run releases the permit even when the task throws', async () => {
    const sem = new Semaphore(1);
    await assert.rejects(sem.run(async () => { throw new Error('boom'); }), /boom/);
    assert.equal(sem.active, 0, 'permit returned after failure');
    // semaphore is still usable
    assert.equal(await sem.run(async () => 'ok'), 'ok');
});

test('never grants more than max permits concurrently (FIFO queue)', async () => {
    const sem = new Semaphore(2);
    let live = 0, peak = 0;
    const order = [];
    const defers = Array.from({ length: 5 }, () => defer());
    const tasks = defers.map((d, i) => sem.run(async () => {
        live += 1; peak = Math.max(peak, live); order.push(i);
        await d.promise;
        live -= 1;
        return i;
    }));

    await tick(); // let the first batch of bodies start
    assert.equal(sem.active, 2, 'exactly max active');
    assert.equal(sem.pending, 3, 'the rest are queued');
    assert.equal(live, 2);

    for (const d of defers) { d.resolve(); await tick(); }
    const out = await Promise.all(tasks);

    assert.ok(peak <= 2, `peak concurrency ${peak} must not exceed max 2`);
    assert.equal(live, 0);
    assert.equal(sem.active, 0);
    assert.deepEqual(out, [0, 1, 2, 3, 4]);
    assert.deepEqual(order, [0, 1, 2, 3, 4], 'FIFO execution order');
});

test('max=1 fully serializes work', async () => {
    const sem = new Semaphore(1);
    let live = 0, peak = 0;
    await Promise.all([1, 2, 3, 4].map(() => sem.run(async () => {
        live += 1; peak = Math.max(peak, live);
        await tick();
        live -= 1;
    })));
    assert.equal(peak, 1);
});

test('manual acquire/release with idempotent release', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    assert.equal(sem.active, 1);
    assert.equal(sem.available, 0);
    release();
    release(); // double release must NOT leak a second permit
    assert.equal(sem.active, 0);
    assert.equal(sem.available, 1, 'available never exceeds max');
    // still grants exactly one
    const r2 = await sem.acquire();
    assert.equal(sem.active, 1);
    r2();
});

test('a queued acquire is granted as soon as a permit frees', async () => {
    const sem = new Semaphore(1);
    const r1 = await sem.acquire();
    let granted = false;
    const p2 = sem.acquire().then((rel) => { granted = true; return rel; });
    await tick();
    assert.equal(granted, false, 'second waiter blocks while permit held');
    assert.equal(sem.pending, 1);
    r1();
    const r2 = await p2;
    assert.equal(granted, true);
    r2();
});

test('createLimiter caps concurrency across a Promise.all fan-out', async () => {
    const limit = createLimiter(3);
    let live = 0, peak = 0;
    const defers = Array.from({ length: 10 }, () => defer());
    const all = Promise.all(defers.map((d) => limit(async () => {
        live += 1; peak = Math.max(peak, live);
        await d.promise;
        live -= 1;
    })));
    await tick();
    assert.equal(limit.active, 3);
    assert.equal(limit.pending, 7);
    assert.equal(limit.max, 3);
    for (const d of defers) { d.resolve(); await tick(); }
    await all;
    assert.ok(peak <= 3, `peak ${peak} <= 3`);
    assert.equal(limit.active, 0);
});
