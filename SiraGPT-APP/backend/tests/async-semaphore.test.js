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

// --- hardening: invalid capacity edge values -------------------------------

test('constructor / createLimiter reject NaN, Infinity and non-number max', () => {
    assert.throws(() => new Semaphore(NaN), /positive integer/);
    assert.throws(() => new Semaphore(Infinity), /positive integer/);
    assert.throws(() => new Semaphore(-Infinity), /positive integer/);
    assert.throws(() => new Semaphore('4'), /positive integer/);
    assert.throws(() => new Semaphore(undefined), /positive integer/);
    assert.throws(() => createLimiter(NaN), /positive integer/);
    assert.throws(() => createLimiter(Infinity), /positive integer/);
});

// --- hardening: synchronous throw still releases the permit ----------------

test('run releases the permit when the task throws synchronously', async () => {
    const sem = new Semaphore(1);
    await assert.rejects(sem.run(() => { throw new Error('sync-boom'); }), /sync-boom/);
    assert.equal(sem.active, 0, 'permit returned after a sync throw');
    assert.equal(sem.available, 1);
    // semaphore still usable afterwards
    assert.equal(await sem.run(() => 'still-alive'), 'still-alive');
});

// --- hardening: AbortSignal cancellation while queued -----------------------

test('acquire rejects immediately on an already-aborted signal — no permit consumed', async () => {
    const sem = new Semaphore(1);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(sem.acquire({ signal: controller.signal }), { name: 'AbortError' });
    assert.equal(sem.active, 0, 'no permit consumed');
    assert.equal(sem.pending, 0, 'nothing queued');
    // semaphore untouched and usable
    const release = await sem.acquire();
    assert.equal(sem.active, 1);
    release();
});

test('aborting a queued acquire dequeues the waiter and leaks no permit', async () => {
    const sem = new Semaphore(1);
    const r1 = await sem.acquire();
    const controller = new AbortController();
    const p2 = sem.acquire({ signal: controller.signal });
    p2.catch(() => {}); // observe early — rejection lands on abort below
    await tick();
    assert.equal(sem.pending, 1, 'waiter queued');

    controller.abort();
    await assert.rejects(p2, { name: 'AbortError' });
    assert.equal(sem.pending, 0, 'aborted waiter removed from the queue');
    assert.equal(sem.active, 1, 'holder unaffected');

    r1();
    assert.equal(sem.active, 0, 'no leaked permit after release');
    assert.equal(sem.available, 1, 'full capacity restored');
});

test('FIFO preserved across an aborted waiter — next waiter still gets the permit', async () => {
    const sem = new Semaphore(1);
    const r1 = await sem.acquire();
    const controller = new AbortController();
    const pAborted = sem.acquire({ signal: controller.signal });
    pAborted.catch(() => {});
    let granted = false;
    const pNext = sem.acquire().then((rel) => { granted = true; return rel; });
    await tick();
    assert.equal(sem.pending, 2);

    controller.abort();
    await assert.rejects(pAborted, { name: 'AbortError' });
    assert.equal(sem.pending, 1, 'only the aborted waiter was removed');
    assert.equal(granted, false, 'survivor still blocked while permit held');

    r1();
    const r2 = await pNext;
    assert.equal(granted, true, 'survivor granted after release, not starved');
    assert.equal(sem.active, 1);
    r2();
    assert.equal(sem.active, 0);
});

test('abort after the grant is a no-op — caller keeps the permit and can release', async () => {
    const sem = new Semaphore(1);
    const controller = new AbortController();
    const release = await sem.acquire({ signal: controller.signal });
    controller.abort();
    await tick();
    assert.equal(sem.active, 1, 'permit still held despite post-grant abort');
    release();
    assert.equal(sem.active, 0);
    assert.equal(sem.available, 1);
});

test('run(fn, { signal }) never invokes fn when aborted while queued', async () => {
    const sem = new Semaphore(1);
    const gate = defer();
    const holder = sem.run(() => gate.promise);
    await tick();

    const controller = new AbortController();
    let invoked = false;
    const p = sem.run(() => { invoked = true; return 'should-not-happen'; },
        { signal: controller.signal });
    p.catch(() => {});
    await tick();
    assert.equal(sem.pending, 1);

    controller.abort(new Error('caller-timeout'));
    await assert.rejects(p, /caller-timeout/); // signal.reason is propagated
    gate.resolve();
    await holder;
    await tick();
    assert.equal(invoked, false, 'fn must never run after a queued abort');
    assert.equal(sem.active, 0);
    assert.equal(sem.available, 1, 'no permit leaked');
    // still fully usable
    assert.equal(await sem.run(() => 'ok'), 'ok');
});

test('limiter forwards the signal — queued task cancellable, capacity intact', async () => {
    const limit = createLimiter(1);
    const gate = defer();
    const holder = limit(() => gate.promise);
    await tick();

    const controller = new AbortController();
    let invoked = false;
    const p = limit(() => { invoked = true; }, { signal: controller.signal });
    p.catch(() => {});
    await tick();
    assert.equal(limit.pending, 1);

    controller.abort();
    await assert.rejects(p, { name: 'AbortError' });
    assert.equal(limit.pending, 0);

    gate.resolve();
    await holder;
    assert.equal(invoked, false);
    assert.equal(limit.active, 0);
    assert.equal(limit.available, 1, 'limiter capacity fully restored');
});

test('acquire rejects a malformed options.signal with a TypeError', () => {
    const sem = new Semaphore(1);
    assert.throws(() => sem.acquire({ signal: 'not-a-signal' }), TypeError);
    assert.throws(() => sem.acquire({ signal: {} }), TypeError);
    assert.equal(sem.active, 0, 'no permit consumed by the failed call');
});
