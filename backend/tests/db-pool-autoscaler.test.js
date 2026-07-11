'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');
const {
    createPoolAutoscaler,
    decide,
    DEFAULT_MIN_LIMIT,
    DEFAULT_MAX_LIMIT,
} = require('../src/db/pool-autoscaler');

function makeMetrics(initial) {
    let snap = { ...initial };
    return {
        snapshot: () => ({
            pool: { min: 1, max: snap.max, idleTimeoutMs: 60000 },
            capacity: { observable: true, reason: 'direct_postgres_datasource' },
            estimated_saturation_ratio: snap.estimated_saturation_ratio || 0,
            queries_in_flight: snap.queries_in_flight || 0,
            pool_timeout_count: snap.pool_timeout_count || 0,
            last_pool_timeout_at: snap.last_pool_timeout_at || null,
        }),
        set(next) { snap = { ...snap, ...next }; },
    };
}

function makeFakeScheduler() {
    const handlers = new Map();
    let nextId = 1;
    return {
        setInterval(fn, ms) {
            const id = nextId++;
            handlers.set(id, { fn, ms });
            return id;
        },
        clearInterval(id) { handlers.delete(id); },
        async fire(id) {
            const h = handlers.get(id);
            if (h) await h.fn();
        },
        get size() { return handlers.size; },
        get handlers() { return handlers; },
    };
}

describe('pool-autoscaler / decide()', () => {
    const cfg = {
        minLimit: 2,
        maxLimit: 20,
        scaleUpRatio: 0.8,
        scaleDownRatio: 0.3,
        scaleUpStep: 2,
        scaleDownStep: 1,
        cooldownMs: 0,
    };

    it('holds when within band', () => {
        const d = decide({ pool: { max: 10 }, estimated_saturation_ratio: 0.5, queries_in_flight: 5 }, cfg);
        assert.equal(d.action, 'hold');
    });

    it('scales up on high saturation', () => {
        const d = decide({ pool: { max: 10 }, estimated_saturation_ratio: 0.85, queries_in_flight: 9 }, cfg);
        assert.equal(d.action, 'scale_up');
        assert.equal(d.from, 10);
        assert.equal(d.to, 12);
    });

    it('scales up faster only when the sample contains new pool timeout events', () => {
        const d = decide({
            pool: { max: 10 },
            estimated_saturation_ratio: 0.6,
            queries_in_flight: 6,
            new_pool_timeout_events: 1,
        }, cfg);
        assert.equal(d.action, 'scale_up');
        assert.equal(d.to, 14);
        assert.match(d.reason, /new pool timeout/i);
    });

    it('ignores legacy cumulative wait telemetry as a scale signal', () => {
        const d = decide({
            pool: { max: 10 },
            estimated_saturation_ratio: 0.6,
            avg_wait_ms: 9999,
            queries_in_flight: 6,
        }, cfg);
        assert.deepEqual(d, { action: 'hold', reason: 'within_band' });
    });

    it('scales down on low saturation', () => {
        const d = decide({ pool: { max: 10 }, estimated_saturation_ratio: 0.1, queries_in_flight: 1 }, cfg);
        assert.equal(d.action, 'scale_down');
        assert.equal(d.to, 9);
        assert.equal(d.cold, true);
    });

    it('does not scale below min', () => {
        const d = decide({ pool: { max: 2 }, estimated_saturation_ratio: 0.0, queries_in_flight: 0 }, cfg);
        assert.equal(d.action, 'hold');
    });

    it('does not scale above max', () => {
        const d = decide({ pool: { max: 20 }, estimated_saturation_ratio: 1.0, queries_in_flight: 25 }, cfg);
        assert.equal(d.action, 'hold');
    });

    it('caps scale_up to maxLimit', () => {
        const d = decide({ pool: { max: 19 }, estimated_saturation_ratio: 0.95, queries_in_flight: 18 }, cfg);
        assert.equal(d.action, 'scale_up');
        assert.equal(d.to, 20);
    });

    it('recommends the nearest hard bound when the actual pool is outside policy range', () => {
        const above = decide(
            { pool: { max: 80 }, estimated_saturation_ratio: 0.5, queries_in_flight: 40 },
            cfg
        );
        assert.deepEqual(above, {
            action: 'scale_down',
            from: 80,
            to: 20,
            reason: 'actual limit 80 > policy maximum 20',
        });

        const below = decide(
            { pool: { max: 1 }, estimated_saturation_ratio: 0.5, queries_in_flight: 1 },
            cfg
        );
        assert.deepEqual(below, {
            action: 'scale_up',
            from: 1,
            to: 2,
            reason: 'actual limit 1 < policy minimum 2',
        });
    });
});

describe('pool-autoscaler / runtime', () => {
    it('rejects without metrics', () => {
        assert.throws(() => createPoolAutoscaler({}), /required/);
    });

    it('starts and stops via fake scheduler', () => {
        const metrics = makeMetrics({ max: 10 });
        const sched = makeFakeScheduler();
        const a = createPoolAutoscaler({
            metrics,
            scheduler: sched,
            intervalMs: 1000,
            minLimit: 2,
            maxLimit: 20,
        });
        assert.equal(a.running, false);
        a.start();
        assert.equal(a.running, true);
        assert.equal(sched.size, 1);
        a.start();
        assert.equal(sched.size, 1);
        a.stop();
        assert.equal(a.running, false);
        assert.equal(sched.size, 0);
    });

    it('invokes apply() and updates currentLimit on scale up', async () => {
        const metrics = makeMetrics({ max: 10, estimated_saturation_ratio: 0.9, queries_in_flight: 9 });
        const calls = [];
        const a = createPoolAutoscaler({
            metrics,
            apply: async (limit, ctx) => { calls.push({ limit, ctx }); },
            minLimit: 2,
            maxLimit: 20,
            cooldownMs: 0,
        });
        const entry = await a.tick();
        assert.equal(entry.decision, 'scale_up');
        assert.equal(entry.applied, true);
        assert.equal(a.currentLimit, 12);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].limit, 12);
    });

    it('dry-run exposes an advisory recommendation without changing the live limit', async () => {
        const metrics = makeMetrics({ max: 10, estimated_saturation_ratio: 0.9, queries_in_flight: 9 });
        const a = createPoolAutoscaler({
            metrics,
            minLimit: 2,
            maxLimit: 20,
            cooldownMs: 0,
        });

        const entry = await a.tick();
        const state = a.getState();

        assert.equal(entry.decision, 'scale_up');
        assert.equal(entry.advisory, true);
        assert.equal(entry.applied, false);
        assert.equal(entry.current, 10);
        assert.equal(entry.recommendedLimit, 12);
        assert.equal(a.currentLimit, 10, 'dry-run must not pretend Prisma changed');
        assert.equal(state.mode, 'advisory');
        assert.equal(state.currentLimit, 10);
        assert.equal(state.recommendedLimit, 12);
        assert.equal(state.lastAction, 'hold');
        assert.equal(state.lastRecommendation, 'scale_up');
        assert.equal(state.stats.recommendations, 1);
        assert.equal(state.stats.appliedChanges, 0);
        assert.equal(state.history.length, 1);
        assert.equal(state.history[0].advisory, true);
    });

    it('dry-run recommendations retain cooldown while the actual limit stays unchanged', async () => {
        const metrics = makeMetrics({ max: 10, estimated_saturation_ratio: 0.95, queries_in_flight: 10 });
        let t = 1000;
        const a = createPoolAutoscaler({
            metrics,
            minLimit: 2,
            maxLimit: 20,
            cooldownMs: 5000,
            now: () => t,
        });

        await a.tick();
        t += 1000;
        const cooldown = await a.tick();

        assert.equal(cooldown.cooldown, true);
        assert.equal(cooldown.applied, false);
        assert.equal(a.currentLimit, 10);
        assert.equal(a.getState().recommendedLimit, 12);
        assert.equal(a.getState().stats.recommendations, 1);

        t += 5000;
        const afterCooldown = await a.tick();
        assert.equal(afterCooldown.cooldown, false);
        assert.equal(afterCooldown.recommendedLimit, 12);
        assert.equal(a.currentLimit, 10);
        assert.equal(a.getState().stats.recommendations, 2);
    });

    it('latches a timeout observed during advisory cooldown until a scale-up recommendation is recorded', async () => {
        const metrics = makeMetrics({
            max: 10,
            estimated_saturation_ratio: 0.95,
            queries_in_flight: 10,
        });
        let t = 1_000;
        const a = createPoolAutoscaler({
            metrics,
            minLimit: 2,
            maxLimit: 20,
            cooldownMs: 5_000,
            now: () => t,
        });

        await a.tick(); // Establish recommendation cooldown from saturation.
        metrics.set({
            estimated_saturation_ratio: 0.5,
            queries_in_flight: 5,
            pool_timeout_count: 1,
            last_pool_timeout_at: 2_000,
        });
        t = 2_000;
        const cooldown = await a.tick();

        assert.equal(cooldown.cooldown, true);
        assert.equal(cooldown.new_pool_timeout_events, 1);
        const cooldownState = a.getState();

        t = 6_000;
        const afterCooldown = await a.tick();

        assert.equal(afterCooldown.cooldown, false);
        assert.equal(afterCooldown.decision, 'scale_up');
        assert.equal(afterCooldown.new_pool_timeout_events, 1);
        assert.equal(afterCooldown.recommendedLimit, 14);
        assert.match(afterCooldown.reason, /new pool timeout/i);
        assert.deepEqual(cooldownState.poolTimeoutEvents, {
            seen: 1,
            acknowledged: 0,
            pending: 1,
        });
        assert.deepEqual(a.getState().poolTimeoutEvents, {
            seen: 1,
            acknowledged: 1,
            pending: 0,
        });
    });

    it('uses a cumulative P2024 counter only when a new timeout is observed', async () => {
        const metrics = makeMetrics({
            max: 10,
            estimated_saturation_ratio: 0.5,
            queries_in_flight: 5,
            pool_timeout_count: 7,
            last_pool_timeout_at: 1_000,
        });
        const a = createPoolAutoscaler({
            metrics,
            minLimit: 2,
            maxLimit: 20,
            cooldownMs: 0,
        });

        const baseline = await a.tick();
        assert.equal(baseline.decision, 'hold');
        assert.equal(baseline.new_pool_timeout_events, 0);

        metrics.set({ pool_timeout_count: 8, last_pool_timeout_at: 2_000 });
        const timeout = await a.tick();
        assert.equal(timeout.decision, 'scale_up');
        assert.equal(timeout.recommendedLimit, 14);
        assert.equal(timeout.new_pool_timeout_events, 1);

        const unchanged = await a.tick();
        assert.equal(unchanged.decision, 'hold');
        assert.equal(unchanged.new_pool_timeout_events, 0);
        assert.equal(Object.hasOwn(unchanged, 'avg_wait_ms'), false);
    });

    it('detects a new timeout after the instrumentation counter resets', async () => {
        const metrics = makeMetrics({
            max: 10,
            estimated_saturation_ratio: 0.5,
            queries_in_flight: 5,
            pool_timeout_count: 4,
            last_pool_timeout_at: 1_000,
        });
        const a = createPoolAutoscaler({
            metrics,
            minLimit: 2,
            maxLimit: 20,
            cooldownMs: 0,
        });

        metrics.set({ pool_timeout_count: 0, last_pool_timeout_at: null });
        assert.equal((await a.tick()).decision, 'hold');

        metrics.set({ pool_timeout_count: 1, last_pool_timeout_at: 2_000 });
        const timeout = await a.tick();
        assert.equal(timeout.decision, 'scale_up');
        assert.equal(timeout.new_pool_timeout_events, 1);
    });

    it('retries an unacknowledged timeout after apply failure and acknowledges it only after success', async () => {
        const metrics = makeMetrics({
            max: 10,
            estimated_saturation_ratio: 0.5,
            queries_in_flight: 5,
        });
        let attempts = 0;
        const a = createPoolAutoscaler({
            metrics,
            apply: async () => {
                attempts += 1;
                if (attempts === 1) throw new Error('temporary resize failure');
            },
            minLimit: 2,
            maxLimit: 20,
            cooldownMs: 0,
        });

        metrics.set({
            pool_timeout_count: 1,
            last_pool_timeout_at: 2_000,
        });
        const failed = await a.tick();

        assert.equal(failed.decision, 'scale_up');
        assert.equal(failed.applied, false);
        assert.equal(failed.new_pool_timeout_events, 1);
        const failedState = a.getState();

        const applied = await a.tick();

        assert.equal(attempts, 2);
        assert.equal(applied.decision, 'scale_up');
        assert.equal(applied.applied, true);
        assert.equal(applied.new_pool_timeout_events, 1);
        assert.equal(a.currentLimit, 14);
        assert.deepEqual(failedState.poolTimeoutEvents, {
            seen: 1,
            acknowledged: 0,
            pending: 1,
        });
        assert.deepEqual(a.getState().poolTimeoutEvents, {
            seen: 1,
            acknowledged: 1,
            pending: 0,
        });
    });

    it('requires three consecutive cold samples by default before scale-down', async () => {
        const metrics = makeMetrics({
            max: 10,
            estimated_saturation_ratio: 0.1,
            queries_in_flight: 1,
        });
        const a = createPoolAutoscaler({
            metrics,
            minLimit: 2,
            maxLimit: 20,
            cooldownMs: 0,
        });

        const first = await a.tick();
        const second = await a.tick();
        assert.equal(first.decision, 'hold');
        assert.equal(first.coldSamples, 1);
        assert.equal(second.decision, 'hold');
        assert.equal(second.coldSamples, 2);
        assert.equal(a.getState().stats.recommendations, 0);

        const third = await a.tick();
        assert.equal(third.decision, 'scale_down');
        assert.equal(third.coldSamples, 3);
        assert.equal(third.recommendedLimit, 9);
        assert.equal(a.getState().stats.recommendationDowns, 1);
    });

    it('resets the consecutive cold-sample streak after one warm sample', async () => {
        const metrics = makeMetrics({
            max: 10,
            estimated_saturation_ratio: 0.1,
            queries_in_flight: 1,
        });
        const a = createPoolAutoscaler({
            metrics,
            minLimit: 2,
            maxLimit: 20,
            cooldownMs: 0,
        });

        await a.tick();
        metrics.set({ estimated_saturation_ratio: 0.5, queries_in_flight: 5 });
        const warm = await a.tick();
        assert.equal(warm.coldSamples, 0);
        metrics.set({ estimated_saturation_ratio: 0.1, queries_in_flight: 1 });
        const coldAgain = await a.tick();
        assert.equal(coldAgain.decision, 'hold');
        assert.equal(coldAgain.coldSamples, 1);
    });

    it('tracks decision and recommendation timestamps independently during cooldown', async () => {
        const metrics = makeMetrics({
            max: 10,
            estimated_saturation_ratio: 0.95,
            queries_in_flight: 10,
        });
        let t = 1_000;
        const a = createPoolAutoscaler({
            metrics,
            minLimit: 2,
            maxLimit: 20,
            cooldownMs: 5_000,
            now: () => t,
        });

        await a.tick();
        t = 2_000;
        await a.tick();
        const state = a.getState();
        assert.equal(state.lastDecisionAt, 2_000);
        assert.equal(state.lastRecommendationAt, 1_000);
        assert.equal(state.lastAppliedAt, null);
    });

    it('advisory currentLimit follows the latest instrumentation snapshot', async () => {
        const metrics = makeMetrics({ max: 10, estimated_saturation_ratio: 0.5, queries_in_flight: 5 });
        const a = createPoolAutoscaler({
            metrics,
            minLimit: 2,
            maxLimit: 20,
            cooldownMs: 0,
        });

        metrics.set({ max: 8, estimated_saturation_ratio: 0.5, queries_in_flight: 4 });
        const entry = await a.tick();

        assert.equal(entry.decision, 'hold');
        assert.equal(entry.current, 8);
        assert.equal(a.currentLimit, 8);
        assert.equal(a.getState().recommendedLimit, 8);
    });

    it('never clamps the reported actual limit to the advisory policy range', async () => {
        const metrics = makeMetrics({ max: 80, estimated_saturation_ratio: 0.5, queries_in_flight: 40 });
        const a = createPoolAutoscaler({
            metrics,
            minLimit: 2,
            maxLimit: 50,
            cooldownMs: 0,
        });

        assert.equal(a.currentLimit, 80);
        const entry = await a.tick();

        assert.equal(entry.current, 80);
        assert.equal(entry.decision, 'scale_down');
        assert.equal(entry.recommendedLimit, 50);
        assert.equal(a.getState().currentLimit, 80);
        assert.equal(a.getState().recommendedLimit, 50);
    });

    it('respects cooldown after a scale event', async () => {
        const metrics = makeMetrics({ max: 10, estimated_saturation_ratio: 0.9, queries_in_flight: 9 });
        let t = 1000;
        const a = createPoolAutoscaler({
            metrics,
            apply: async () => {},
            minLimit: 2,
            maxLimit: 20,
            cooldownMs: 5000,
            now: () => t,
        });
        await a.tick();
        assert.equal(a.currentLimit, 12);
        // simulate metrics still hot, but within cooldown window
        t += 1000;
        metrics.set({ max: 12, estimated_saturation_ratio: 0.9, queries_in_flight: 12 });
        const entry = await a.tick();
        assert.equal(entry.cooldown, true);
        assert.equal(a.currentLimit, 12);
        // after cooldown, new decision allowed
        t += 5000;
        const entry2 = await a.tick();
        assert.equal(entry2.cooldown, false);
        assert.equal(entry2.decision, 'scale_up');
        assert.equal(a.currentLimit, 14);
    });

    it('records apply errors in stats and history', async () => {
        const metrics = makeMetrics({ max: 10, estimated_saturation_ratio: 0.95, queries_in_flight: 10 });
        const a = createPoolAutoscaler({
            metrics,
            apply: async () => { throw new Error('boom'); },
            minLimit: 2,
            maxLimit: 20,
            cooldownMs: 0,
        });
        const entry = await a.tick();
        assert.equal(entry.applied, false);
        assert.equal(entry.error, 'boom');
        const state = a.getState();
        assert.equal(state.stats.applyErrors, 1);
        assert.equal(state.stats.lastError, 'boom');
        // currentLimit unchanged when apply throws
        assert.equal(a.currentLimit, 10);
    });

    it('caps policy limits and sampling intervals and clamps inverted ranges', () => {
        const metrics = makeMetrics({ max: 100 });
        const inverted = createPoolAutoscaler({
            metrics,
            minLimit: 10,
            maxLimit: 5, // inverted
        });
        assert.equal(inverted.getState().minLimit, 10);
        assert.equal(inverted.getState().maxLimit, 10);

        const oversized = createPoolAutoscaler({
            metrics,
            minLimit: 9999,
            maxLimit: 9999,
            intervalMs: 1,
        }).getState();
        assert.equal(oversized.minLimit, 100);
        assert.equal(oversized.maxLimit, 100);
        assert.equal(oversized.intervalMs, 1000);
    });

    it('strictly parses integer controls and bounds the cold-sample requirement', () => {
        const metrics = makeMetrics({ max: 10 });
        const malformed = createPoolAutoscaler({
            metrics,
            intervalMs: '1000oops',
            minLimit: '4oops',
            maxLimit: '12oops',
            scaleUpStep: '7oops',
            coldSamplesRequired: '2oops',
        }).getState();
        assert.equal(malformed.intervalMs, 30_000);
        assert.equal(malformed.minLimit, 2);
        assert.equal(malformed.maxLimit, 50);
        assert.equal(malformed.config.scaleUpStep, 2);
        assert.equal(malformed.config.coldSamplesRequired, 3);

        const bounded = createPoolAutoscaler({
            metrics,
            coldSamplesRequired: 999,
        }).getState();
        assert.equal(bounded.config.coldSamplesRequired, 20);
    });

    it('refuses to recommend limits when datasource capacity is unobservable', () => {
        const metrics = {
            snapshot: () => ({
                capacity: { observable: false, reason: 'remote_prisma_datasource' },
                pool: null,
                estimated_saturation_ratio: null,
                queries_in_flight: 0,
            }),
        };
        assert.throws(
            () => createPoolAutoscaler({ metrics }),
            /capacity is unobservable/i,
        );
    });

    it('runs scheduled tick via fake scheduler', async () => {
        const metrics = makeMetrics({ max: 10, estimated_saturation_ratio: 0.9, queries_in_flight: 9 });
        const sched = makeFakeScheduler();
        const a = createPoolAutoscaler({
            metrics,
            scheduler: sched,
            apply: async () => {},
            minLimit: 2,
            maxLimit: 20,
            cooldownMs: 0,
            intervalMs: 30000,
        });
        a.start();
        const [id] = sched.handlers.keys();
        await sched.fire(id);
        // give the scheduled async callback a chance to settle
        await new Promise((r) => setImmediate(r));
        assert.equal(a.currentLimit, 12);
        a.stop();
    });

    it('stats track ticks/holds/scaleUps/scaleDowns', async () => {
        const metrics = makeMetrics({ max: 10, estimated_saturation_ratio: 0.5, queries_in_flight: 5 });
        const a = createPoolAutoscaler({
            metrics,
            apply: async () => {},
            minLimit: 2,
            maxLimit: 20,
            cooldownMs: 0,
            coldSamplesRequired: 1,
        });
        await a.tick(); // hold
        metrics.set({ estimated_saturation_ratio: 0.9, queries_in_flight: 9 });
        await a.tick(); // up → max becomes 12 in metrics? No: caller updates externally.
        metrics.set({ max: 12, estimated_saturation_ratio: 0.05, queries_in_flight: 0 });
        await a.tick(); // down
        const s = a.getState();
        assert.equal(s.stats.ticks, 3);
        assert.equal(s.stats.scaleUps, 1);
        assert.equal(s.stats.scaleDowns, 1);
        assert.equal(s.stats.holds, 1);
    });

    it('exposes default env caps', () => {
        assert.ok(DEFAULT_MIN_LIMIT >= 1);
        assert.ok(DEFAULT_MAX_LIMIT >= DEFAULT_MIN_LIMIT);
    });
});
