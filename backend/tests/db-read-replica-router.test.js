'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
    createReadReplicaRouter,
    createRouterFromEnv,
    classify,
    TARGET_PRIMARY,
    TARGET_REPLICA,
} = require('../src/db/read-replica-router');

function makeFakeClient(name) {
    return {
        name,
        calls: [],
        async query(sql) { this.calls.push(sql); return `${name}:${sql}`; },
        async $disconnect() { this.disconnected = true; },
    };
}

describe('read-replica-router / classify', () => {
    it('honors explicit readonly flag', () => {
        assert.deepEqual(classify({ readonly: true }), { readonly: true });
        assert.deepEqual(classify({ readOnly: true }), { readonly: true });
        assert.deepEqual(classify({ readonly: false }), { readonly: false });
    });

    it('infers readonly from Prisma actions', () => {
        for (const action of ['findMany', 'findUnique', 'findFirst', 'count', 'aggregate', 'groupBy']) {
            assert.equal(classify({ action }).readonly, true, `${action} should be readonly`);
        }
        for (const action of ['create', 'update', 'delete', 'upsert']) {
            assert.equal(classify({ action }).readonly, false, `${action} should be writable`);
        }
    });

    it('infers readonly from raw SQL prefix', () => {
        assert.equal(classify({ sql: 'SELECT 1' }).readonly, true);
        assert.equal(classify({ sql: '  select * from t' }).readonly, true);
        assert.equal(classify({ sql: 'SHOW search_path' }).readonly, true);
        assert.equal(classify({ sql: 'INSERT INTO t VALUES (1)' }).readonly, false);
        assert.equal(classify({ sql: 'UPDATE t SET x=1' }).readonly, false);
    });

    it('handles null/empty', () => {
        assert.equal(classify(null).readonly, false);
        assert.equal(classify(undefined).readonly, false);
        assert.equal(classify({}).readonly, false);
    });
});

describe('read-replica-router / pick', () => {
    it('throws without primary', () => {
        assert.throws(() => createReadReplicaRouter({}), /primary/);
    });

    it('routes readonly queries to replica when DATABASE_URL_RO is set', () => {
        const primary = makeFakeClient('p');
        const replica = makeFakeClient('r');
        const router = createReadReplicaRouter({
            primary, replica, replicaUrl: 'postgres://ro/db',
        });
        assert.equal(router.hasReplica, true);
        const r = router.pick({ readonly: true });
        assert.equal(r.target, TARGET_REPLICA);
        assert.equal(r.client, replica);
    });

    it('routes write queries to primary even with replica configured', () => {
        const primary = makeFakeClient('p');
        const replica = makeFakeClient('r');
        const router = createReadReplicaRouter({
            primary, replica, replicaUrl: 'postgres://ro/db',
        });
        const r = router.pick({ readonly: false, action: 'create' });
        assert.equal(r.target, TARGET_PRIMARY);
        assert.equal(r.client, primary);
    });

    it('falls back to primary when replica is not configured', () => {
        const primary = makeFakeClient('p');
        const router = createReadReplicaRouter({ primary });
        assert.equal(router.hasReplica, false);
        const r = router.pick({ readonly: true });
        assert.equal(r.target, TARGET_PRIMARY);
        const snap = router.snapshot();
        assert.equal(snap.readonly_on_primary, 1);
        assert.equal(snap.replicaUrlConfigured, false);
    });

    it('treats empty replicaUrl as disabled even if a client is provided', () => {
        const primary = makeFakeClient('p');
        const replica = makeFakeClient('r');
        const router = createReadReplicaRouter({ primary, replica, replicaUrl: '' });
        assert.equal(router.hasReplica, false);
        assert.equal(router.replica, null);
        assert.equal(router.pick({ readonly: true }).client, primary);
    });
});

describe('read-replica-router / execute', () => {
    it('runs handler against the chosen client and counts routes', async () => {
        const primary = makeFakeClient('p');
        const replica = makeFakeClient('r');
        const router = createReadReplicaRouter({
            primary, replica, replicaUrl: 'postgres://ro/db',
        });

        const r1 = await router.execute({ readonly: true, name: 'list' }, async (c) => c.query('SELECT 1'));
        const r2 = await router.execute({ action: 'create' }, async (c) => c.query('INSERT'));

        assert.equal(r1, 'r:SELECT 1');
        assert.equal(r2, 'p:INSERT');
        const snap = router.snapshot();
        assert.equal(snap.replica_queries, 1);
        assert.equal(snap.primary_queries, 1);
        assert.ok(snap.last_route_at > 0);
    });

    it('falls back to primary when replica throws (default)', async () => {
        const primary = makeFakeClient('p');
        const replica = {
            async query() { throw new Error('replica down'); },
        };
        const logs = [];
        const router = createReadReplicaRouter({
            primary, replica, replicaUrl: 'ro',
            logger: (lvl, msg, meta) => logs.push({ lvl, msg, meta }),
        });
        const out = await router.execute({ readonly: true, name: 'q' }, async (c) => c.query('SELECT'));
        assert.equal(out, 'p:SELECT');
        const snap = router.snapshot();
        assert.equal(snap.replica_errors, 1);
        assert.equal(snap.replica_fallbacks, 1);
        assert.equal(snap.primary_queries, 1);
        assert.equal(snap.replica_queries, 1);
        assert.ok(logs.some((l) => l.lvl === 'warn'));
    });

    it('propagates replica errors when fallbackOnError=false', async () => {
        const primary = makeFakeClient('p');
        const replica = { async query() { throw new Error('boom'); } };
        const router = createReadReplicaRouter({
            primary, replica, replicaUrl: 'ro', fallbackOnError: false,
        });
        await assert.rejects(
            router.execute({ readonly: true }, async (c) => c.query('SELECT')),
            /boom/
        );
        const snap = router.snapshot();
        assert.equal(snap.replica_errors, 1);
        assert.equal(snap.replica_fallbacks, 0);
    });

    it('rejects non-function handler', async () => {
        const router = createReadReplicaRouter({ primary: makeFakeClient('p') });
        await assert.rejects(router.execute({}, null), /handler/);
    });

    it('reset() zeroes counters', async () => {
        const router = createReadReplicaRouter({
            primary: makeFakeClient('p'),
            replica: makeFakeClient('r'),
            replicaUrl: 'ro',
        });
        await router.execute({ readonly: true }, async (c) => c.query('SELECT'));
        router.reset();
        const snap = router.snapshot();
        assert.equal(snap.replica_queries, 0);
        assert.equal(snap.primary_queries, 0);
    });

    it('dispose() disconnects both clients', async () => {
        const primary = makeFakeClient('p');
        const replica = makeFakeClient('r');
        const router = createReadReplicaRouter({ primary, replica, replicaUrl: 'ro' });
        await router.dispose();
        assert.equal(primary.disconnected, true);
        assert.equal(replica.disconnected, true);
    });
});

describe('read-replica-router / createRouterFromEnv', () => {
    it('builds primary only when DATABASE_URL_RO is missing', () => {
        const built = [];
        const router = createRouterFromEnv({
            env: { DATABASE_URL: 'postgres://primary/db' },
            makeClient: (url, role) => {
                built.push({ url, role });
                return makeFakeClient(role);
            },
        });
        assert.equal(router.hasReplica, false);
        assert.equal(built.length, 1);
        assert.equal(built[0].role, TARGET_PRIMARY);
    });

    it('builds replica when DATABASE_URL_RO is present', () => {
        const built = [];
        const router = createRouterFromEnv({
            env: {
                DATABASE_URL: 'postgres://primary/db',
                DATABASE_URL_RO: 'postgres://replica/db',
            },
            makeClient: (url, role) => {
                built.push({ url, role });
                return makeFakeClient(role);
            },
        });
        assert.equal(router.hasReplica, true);
        assert.equal(built.length, 2);
        assert.equal(built[1].role, TARGET_REPLICA);
        assert.equal(built[1].url, 'postgres://replica/db');
    });

    it('throws when neither DATABASE_URL nor primaryUrl is set', () => {
        assert.throws(() => createRouterFromEnv({
            env: {},
            makeClient: () => makeFakeClient('p'),
        }), /DATABASE_URL/);
    });

    it('requires makeClient', () => {
        assert.throws(() => createRouterFromEnv({
            env: { DATABASE_URL: 'x' },
        }), /makeClient/);
    });
});
