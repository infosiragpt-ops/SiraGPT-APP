'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');
const {
    instrumentPool,
    DEFAULT_POOL_MAX,
    DEFAULT_POOL_MIN,
    MAX_POOL_SIZE,
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

function makeFakeExtensionPrisma() {
    let extension = null;
    const extended = { kind: 'extended-prisma-client' };
    const subscriptions = [];
    const base = {
        $on(event, listener) {
            subscriptions.push({ receiver: this, event, listener });
            return this;
        },
        $extends(definition) {
            extension = definition;
            return extended;
        },
        get _extension() { return extension; },
        get _subscriptions() { return subscriptions; },
    };
    return { base, extended };
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
        assert.equal(snap.estimated_connections_active, 0);
        assert.equal(snap.estimated_connections_idle, 4);
        assert.equal(Object.hasOwn(snap, 'connections_active'), false);
        assert.equal(Object.hasOwn(snap, 'connections_idle'), false);
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
        assert.equal(mid.estimated_connections_active, 2);
        assert.equal(mid.estimated_connections_idle, 3);

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
        assert.equal(snap.estimated_saturation, 'critical');
        assert.equal(snap.estimated_saturation_ratio, 1);
        assert.equal(Object.hasOwn(snap, 'saturation'), false);
        assert.equal(Object.hasOwn(snap, 'saturation_ratio'), false);

        for (const d of releases) d.resolve(null);
        await Promise.all(promises);

        const ok = handle.snapshot();
        assert.equal(ok.estimated_saturation, 'ok');
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

    it('keeps direct callers on positive bounded integer pool sizes', () => {
        const invalid = instrumentPool(makeFakePrisma(), {
            poolMax: 0,
            poolMin: Number.POSITIVE_INFINITY,
        }).snapshot();
        assert.equal(invalid.pool.max, DEFAULT_POOL_MAX);
        assert.equal(invalid.pool.min, DEFAULT_POOL_MIN);

        const oversized = instrumentPool(makeFakePrisma(), {
            poolMax: MAX_POOL_SIZE * 100,
            poolMin: MAX_POOL_SIZE * 100,
        }).snapshot();
        assert.equal(oversized.pool.max, MAX_POOL_SIZE);
        assert.equal(oversized.pool.min, MAX_POOL_SIZE);
        assert.equal(Number.isInteger(oversized.pool.max), true);
    });

    it('uses a query extension when Prisma no longer exposes $use middleware', async () => {
        const prisma = makeFakeExtensionPrisma();
        const events = [];
        const handle = instrumentPool(prisma.base, {
            poolMax: 4,
            onQuery: (event) => events.push(event),
        });

        assert.equal(handle.client, prisma.extended);
        assert.equal(typeof handle.client.$on, 'function');
        assert.equal(handle.installed, true);
        assert.equal(handle.snapshot().instrumentation, 'query_extension');
        const listener = () => {};
        const onResult = handle.client.$on('query', listener);
        assert.equal(onResult, prisma.base);
        assert.deepEqual(prisma.base._subscriptions, [{
            receiver: prisma.base,
            event: 'query',
            listener,
        }]);
        const operation = prisma.base._extension.query.$allOperations;
        const result = await operation({
            model: 'User',
            operation: 'findMany',
            args: { where: { active: true } },
            query: async (args) => {
                assert.deepEqual(args, { where: { active: true } });
                return ['ok'];
            },
        });

        assert.deepEqual(result, ['ok']);
        assert.equal(handle.snapshot().total_queries, 1);
        assert.equal(events[0].model, 'User');
        assert.equal(events[0].action, 'findMany');
    });

    it('does not throw when client lacks both instrumentation APIs', () => {
        const client = { /* no $use or $extends */ };
        const handle = instrumentPool(client, { poolMax: 4 });
        assert.equal(handle.installed, false);
        assert.equal(handle.client, client);
        const snap = handle.snapshot();
        assert.equal(snap.installed, false);
        assert.equal(snap.instrumentation, 'none');
        assert.equal(snap.pool.max, 4);
    });

    it('marks remote datasource capacity unobservable without fabricating pool estimates', () => {
        const handle = instrumentPool(makeFakePrisma(), {
            poolMax: 25,
            poolMin: 5,
            capacityObservable: false,
            capacityReason: 'remote_prisma_datasource',
        });
        const snap = handle.snapshot();

        assert.deepEqual(snap.capacity, {
            observable: false,
            reason: 'remote_prisma_datasource',
        });
        assert.equal(snap.pool, null);
        assert.equal(snap.estimated_connections_active, null);
        assert.equal(snap.estimated_connections_idle, null);
        assert.equal(snap.estimated_saturation_ratio, null);
        assert.equal(snap.estimated_saturation, 'unobservable');
        assert.equal(handle.toHealthCheck().status, 'skipped');
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
