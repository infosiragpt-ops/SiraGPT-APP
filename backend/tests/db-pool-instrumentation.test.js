'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');
const {
    instrumentPool,
    DEFAULT_POOL_MAX,
} = require('../src/db/pool-instrumentation');

// ── Fake Prisma client ─────────────────────────────────────────
//
// Captures the `$use` middleware so tests can drive synthetic
// queries through it without touching a real database.

function makeFakePrisma() {
    let middleware = null;
    return {
        $use(fn) { middleware = fn; },
        get _middleware() { return middleware; },
        async run(params, handler) {
            if (!middleware) return handler(params);
            return middleware(params, handler);
        },
    };
}

describe('pool-instrumentation', () => {
    it('refuses to attach without a client', () => {
        assert.throws(() => instrumentPool(null), /required/);
    });

    it('records counts on successful queries', async () => {
        const prisma = makeFakePrisma();
        const handle = instrumentPool(prisma, { poolMax: 4, poolMin: 1 });
        assert.equal(handle.installed, true);

        await prisma.run({ model: 'User', action: 'findMany' }, async () => 'ok');
        await prisma.run({ model: 'Chat', action: 'create' }, async () => 'ok');

        const snap = handle.snapshot();
        assert.equal(snap.total_queries, 2);
        assert.equal(snap.total_errors, 0);
        assert.equal(snap.queries_in_flight, 0);
        assert.equal(snap.connections_active, 0);
        assert.equal(snap.connections_idle, 4);
        assert.equal(snap.pool.max, 4);
        assert.equal(snap.pool.min, 1);
    });

    it('tracks queries_in_flight and peak', async () => {
        const prisma = makeFakePrisma();
        const handle = instrumentPool(prisma, { poolMax: 5 });

        const release1 = makeDeferred();
        const release2 = makeDeferred();

        const p1 = prisma.run({ action: 'findMany' }, () => release1.promise);
        const p2 = prisma.run({ action: 'findMany' }, () => release2.promise);

        await tick();
        const mid = handle.snapshot();
        assert.equal(mid.queries_in_flight, 2);
        assert.equal(mid.peak_in_flight, 2);
        assert.equal(mid.connections_active, 2);
        assert.equal(mid.connections_idle, 3);

        release1.resolve('a');
        release2.resolve('b');
        await Promise.all([p1, p2]);

        const after = handle.snapshot();
        assert.equal(after.queries_in_flight, 0);
        assert.equal(after.peak_in_flight, 2);
    });

    it('reports saturation states based on ratio', async () => {
        const prisma = makeFakePrisma();
        const handle = instrumentPool(prisma, { poolMax: 4 });

        const releases = [makeDeferred(), makeDeferred(), makeDeferred(), makeDeferred()];
        const promises = releases.map((d) => prisma.run({ action: 'findFirst' }, () => d.promise));

        await tick();
        const snap = handle.snapshot();
        assert.equal(snap.queries_in_flight, 4);
        assert.equal(snap.saturation, 'critical');
        assert.equal(snap.saturation_ratio, 1);

        for (const d of releases) d.resolve(null);
        await Promise.all(promises);

        const ok = handle.snapshot();
        assert.equal(ok.saturation, 'ok');
    });

    it('counts errors and treats P2024 as wait time', async () => {
        const prisma = makeFakePrisma();
        const handle = instrumentPool(prisma, { poolMax: 2 });

        await assert.rejects(
            prisma.run({ action: 'findMany' }, async () => {
                const e = new Error('pool timeout'); e.code = 'P2024'; throw e;
            }),
            /pool timeout/
        );
        await assert.rejects(
            prisma.run({ action: 'create' }, async () => { throw new Error('boom'); }),
            /boom/
        );

        const snap = handle.snapshot();
        assert.equal(snap.total_errors, 2);
        assert.equal(snap.total_queries, 2);
        assert.ok(snap.total_wait_ms >= 0);
        assert.equal(snap.queries_in_flight, 0);
    });

    it('produces healthcheck-shaped report', () => {
        const prisma = makeFakePrisma();
        const handle = instrumentPool(prisma, { poolMax: 8 });
        const hc = handle.toHealthCheck();
        assert.equal(hc.name, 'db.pool');
        assert.equal(hc.status, 'healthy');
        assert.equal(hc.critical, false);
        assert.equal(hc.details.pool.max, 8);
    });

    it('reports degraded healthcheck when warn threshold reached', async () => {
        const prisma = makeFakePrisma();
        const handle = instrumentPool(prisma, { poolMax: 5 });

        // 4/5 = 0.8 → warn
        const releases = Array.from({ length: 4 }, makeDeferred);
        const ps = releases.map((d) => prisma.run({ action: 'x' }, () => d.promise));
        await tick();
        const hc = handle.toHealthCheck();
        assert.equal(hc.status, 'degraded');
        for (const d of releases) d.resolve(null);
        await Promise.all(ps);
    });

    it('resets counters but preserves in-flight', async () => {
        const prisma = makeFakePrisma();
        const handle = instrumentPool(prisma, { poolMax: 3 });

        await prisma.run({ action: 'a' }, async () => null);
        await prisma.run({ action: 'b' }, async () => null);
        assert.equal(handle.snapshot().total_queries, 2);

        handle.reset();
        assert.equal(handle.snapshot().total_queries, 0);

        // start one in-flight, reset, ensure tracking continues
        const d = makeDeferred();
        const inflight = prisma.run({ action: 'c' }, () => d.promise);
        await tick();
        handle.reset();
        const mid = handle.snapshot();
        assert.equal(mid.queries_in_flight, 1, 'in-flight preserved across reset');
        d.resolve(null);
        await inflight;
        assert.equal(handle.snapshot().queries_in_flight, 0);
    });

    it('invokes onQuery callback for success and error', async () => {
        const prisma = makeFakePrisma();
        const events = [];
        const handle = instrumentPool(prisma, {
            poolMax: 2,
            onQuery: (ev) => events.push(ev),
        });

        await prisma.run({ model: 'X', action: 'find' }, async () => 'ok');
        await assert.rejects(
            prisma.run({ model: 'X', action: 'create' }, async () => { throw new Error('nope'); }),
            /nope/
        );
        assert.equal(events.length, 2);
        assert.equal(events[0].error, null);
        assert.ok(events[1].error instanceof Error);
        handle.dispose();
        assert.equal(handle.installed, false);
    });

    it('records retries via recordRetry()', () => {
        const prisma = makeFakePrisma();
        const handle = instrumentPool(prisma, { poolMax: 3 });
        handle.recordRetry();
        handle.recordRetry();
        assert.equal(handle.snapshot().total_retries, 2);
    });

    it('uses defaults when poolMax not provided', () => {
        const prisma = makeFakePrisma();
        const handle = instrumentPool(prisma);
        const snap = handle.snapshot();
        assert.equal(snap.pool.max, DEFAULT_POOL_MAX);
    });

    it('does not throw when client lacks $use', () => {
        const handle = instrumentPool({ /* no $use */ }, { poolMax: 4 });
        assert.equal(handle.installed, false);
        const snap = handle.snapshot();
        assert.equal(snap.installed, false);
        assert.equal(snap.pool.max, 4);
    });
});

// ── Helpers ───────────────────────────────────────────────────

function makeDeferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function tick() {
    return new Promise((r) => setImmediate(r));
}
