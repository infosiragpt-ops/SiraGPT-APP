'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const health = require('../src/services/ai/provider-key-health');

beforeEach(() => health._reset());

test('fingerprint is stable, 12 hex chars, and non-reversible', () => {
    const fp = health.fingerprint('sk-secret-key-value');
    assert.match(fp, /^[0-9a-f]{12}$/);
    assert.equal(fp, health.fingerprint('sk-secret-key-value'));
    assert.notEqual(fp, health.fingerprint('sk-other-key'));
    assert.ok(!fp.includes('secret'));
});

test('recordFailure sets a reason-aware cooldown that expires', () => {
    health.recordFailure('k', 'auth', 1_000);
    assert.equal(health.isInCooldown('k', 1_000 + 299_999), true);  // 5 min default - 1ms
    assert.equal(health.isInCooldown('k', 1_000 + 300_000), false); // exactly expired
});

test('cooldown bases: rate_limit < default < auth < quota', () => {
    health.recordFailure('rl', 'rate_limit', 0);
    health.recordFailure('df', 'weird-unknown', 0);
    health.recordFailure('au', 'auth', 0);
    health.recordFailure('qu', 'quota', 0);
    const left = (id) => health.statusOf(id, 0).cooldownMsLeft;
    assert.ok(left('rl') < left('df'), 'rate_limit < default');
    assert.ok(left('df') < left('au'), 'default < auth');
    assert.ok(left('au') < left('qu'), 'auth < quota');
    assert.equal(left('rl'), 30_000);
    assert.equal(left('qu'), 1_800_000);
});

test('consecutive failures back off exponentially, capped at max', () => {
    // auth base 300_000; 2nd failure → *2
    health.recordFailure('k', 'auth', 0);
    health.recordFailure('k', 'auth', 0);
    assert.equal(health.statusOf('k', 0).cooldownMsLeft, 600_000);
    assert.equal(health.statusOf('k', 0).failures, 2);
    // many failures → capped at SIRAGPT_KEY_COOLDOWN_MAX_MS default 3_600_000
    for (let i = 0; i < 10; i++) health.recordFailure('k', 'auth', 0);
    assert.equal(health.statusOf('k', 0).cooldownMsLeft, 3_600_000);
});

test('recordSuccess clears a cooling key immediately', () => {
    health.recordFailure('k', 'auth', 0);
    assert.equal(health.isInCooldown('k', 1), true);
    health.recordSuccess('k');
    assert.equal(health.isInCooldown('k', 1), false);
    assert.equal(health.statusOf('k', 1).healthy, true);
});

test('statusOf reports healthy keys with zero cooldown', () => {
    const s = health.statusOf('never-seen', 0);
    assert.deepEqual(s, { id: 'never-seen', healthy: true, failures: 0, cooldownMsLeft: 0, lastReason: null });
});

test('orderProfiles puts healthy first, cooling at back (soonest-recover first)', () => {
    const A = { id: 'p:1', key: 'kA', fingerprint: 'fa' };
    const B = { id: 'p:2', key: 'kB', fingerprint: 'fb' };
    const C = { id: 'p:3', key: 'kC', fingerprint: 'fc' };
    // B cools down for 30s (rate_limit), C for 5min (auth) → B recovers before C
    health.recordFailure(B, 'rate_limit', 0);
    health.recordFailure(C, 'auth', 0);
    const ordered = health.orderProfiles([A, B, C], 1_000);
    assert.deepEqual(ordered.map(p => p.id), ['p:1', 'p:2', 'p:3'], 'A healthy, then B (recovers sooner), then C');
    // does not mutate input
    assert.deepEqual([A, B, C].map(p => p.id), ['p:1', 'p:2', 'p:3']);
});

test('orderProfiles is a no-op when all keys are healthy', () => {
    const pool = [{ id: 'a', fingerprint: 'a' }, { id: 'b', fingerprint: 'b' }];
    assert.deepEqual(health.orderProfiles(pool, 0).map(p => p.id), ['a', 'b']);
});

test('snapshot + prune reflect and clean expired cooldowns', () => {
    health.recordFailure('rl', 'rate_limit', 0);   // expires at 30_000
    health.recordFailure('au', 'auth', 0);          // expires at 300_000
    let snap = health.snapshot(0);
    assert.equal(snap.tracked, 2);
    assert.equal(snap.cooling, 2);
    // after 30s, rl is healthy again
    snap = health.snapshot(31_000);
    assert.equal(snap.cooling, 1);
    // prune drops the elapsed one
    assert.equal(health.prune(31_000), 1);
    assert.equal(health.snapshot(31_000).tracked, 1);
});

test('id resolution accepts profile objects (fingerprint) or raw ids', () => {
    health.recordFailure({ id: 'openai:1', key: 'kX', fingerprint: 'deadbeef0001' }, 'auth', 0);
    assert.equal(health.isInCooldown('deadbeef0001', 1), true);
    assert.equal(health.isInCooldown({ fingerprint: 'deadbeef0001' }, 1), true);
});
