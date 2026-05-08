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
            saturation_ratio: snap.saturation_ratio || 0,
            avg_wait_ms: snap.avg_wait_ms || 0,
            queries_in_flight: snap.queries_in_flight || 0,
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
        waitMsThreshold: 50,
        cooldownMs: 0,
    };

    it('holds when within band', () => {
        const d = decide({ pool: { max: 10 }, saturation_ratio: 0.5, avg_wait_ms: 0, queries_in_flight: 5 }, cfg);
        assert.equal(d.action, 'hold');
    });

    it('scales up on high saturation', () => {
        const d = decide({ pool: { max: 10 }, saturation_ratio: 0.85, avg_wait_ms: 0, queries_in_flight: 9 }, cfg);
        assert.equal(d.action, 'scale_up');
        assert.equal(d.from, 10);
        assert.equal(d.to, 12);
    });

    it('scales up faster when wait time is high', () => {
        const d = decide({ pool: { max: 10 }, saturation_ratio: 0.6, avg_wait_ms: 120, queries_in_flight: 6 }, cfg);
        assert.equal(d.action, 'scale_up');
        // queueing → step doubled
        assert.equal(d.to, 14);
    });

    it('scales down on low saturation', () => {
        const d = decide({ pool: { max: 10 }, saturation_ratio: 0.1, avg_wait_ms: 0, queries_in_flight: 1 }, cfg);
        assert.equal(d.action, 'scale_down');
        assert.equal(d.to, 9);
    });

    it('does not scale below min', () => {
        const d = decide({ pool: { max: 2 }, saturation_ratio: 0.0, avg_wait_ms: 0, queries_in_flight: 0 }, cfg);
        assert.equal(d.action, 'hold');
    });

    it('does not scale above max', () => {
        const d = decide({ pool: { max: 20 }, saturation_ratio: 1.0, avg_wait_ms: 200, queries_in_flight: 25 }, cfg);
        assert.equal(d.action, 'hold');
    });

    it('caps scale_up to maxLimit', () => {
        const d = decide({ pool: { max: 19 }, saturation_ratio: 0.95, avg_wait_ms: 0, queries_in_flight: 18 }, cfg);
        assert.equal(d.action, 'scale_up');
        assert.equal(d.to, 20);
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
        const metrics = makeMetrics({ max: 10, saturation_ratio: 0.9, queries_in_flight: 9 });
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

    it('respects cooldown after a scale event', async () => {
        const metrics = makeMetrics({ max: 10, saturation_ratio: 0.9, queries_in_flight: 9 });
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
        metrics.set({ max: 12, saturation_ratio: 0.9, queries_in_flight: 12 });
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
        const metrics = makeMetrics({ max: 10, saturation_ratio: 0.95, queries_in_flight: 10 });
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

    it('caps minLimit/maxLimit and clamps inverted ranges', () => {
        const metrics = makeMetrics({ max: 100 });
        const a = createPoolAutoscaler({
            metrics,
            minLimit: 10,
            maxLimit: 5, // inverted
        });
        const s = a.getState();
        assert.equal(s.minLimit, 10);
        assert.equal(s.maxLimit, 10);
    });

    it('runs scheduled tick via fake scheduler', async () => {
        const metrics = makeMetrics({ max: 10, saturation_ratio: 0.9, queries_in_flight: 9 });
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
        const metrics = makeMetrics({ max: 10, saturation_ratio: 0.5, queries_in_flight: 5 });
        const a = createPoolAutoscaler({
            metrics,
            apply: async () => {},
            minLimit: 2,
            maxLimit: 20,
            cooldownMs: 0,
        });
        await a.tick(); // hold
        metrics.set({ saturation_ratio: 0.9, queries_in_flight: 9 });
        await a.tick(); // up → max becomes 12 in metrics? No: caller updates externally.
        metrics.set({ max: 12, saturation_ratio: 0.05, queries_in_flight: 0, avg_wait_ms: 0 });
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
