'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { EventEmitter } = require('node:events');

const {
  createSkillsSnapshotCache,
  DEFAULT_INVALIDATE_EVENTS,
} = require('../src/services/skills/snapshot-cache');

describe('skills/snapshot-cache', () => {
  test('source is required', () => {
    assert.throws(() => createSkillsSnapshotCache({}), /source function is required/);
  });

  test('first get() rebuilds; subsequent gets are cached', () => {
    let n = 0;
    const cache = createSkillsSnapshotCache({ source: () => ({ rev: ++n }) });
    assert.deepEqual(cache.get(), { rev: 1 });
    assert.deepEqual(cache.get(), { rev: 1 });
    assert.deepEqual(cache.get(), { rev: 1 });
    assert.equal(cache.stats().hits, 2);
    assert.equal(cache.stats().misses, 1);
  });

  test('invalidate() forces a rebuild on next get()', () => {
    let n = 0;
    const cache = createSkillsSnapshotCache({ source: () => ({ rev: ++n }) });
    cache.get();
    const had = cache.invalidate('manual');
    assert.equal(had, true);
    assert.deepEqual(cache.get(), { rev: 2 });
    assert.equal(cache.stats().lastReason, 'manual');
    assert.equal(cache.stats().invalidations, 1);
  });

  test('invalidate() returns false when there is no cached value', () => {
    const cache = createSkillsSnapshotCache({ source: () => ({}) });
    assert.equal(cache.invalidate('boot'), false);
  });

  test('event bus invalidates on session.new and sessions.reset by default', () => {
    let n = 0;
    const bus = new EventEmitter();
    const cache = createSkillsSnapshotCache({ source: () => ({ rev: ++n }), eventBus: bus });
    cache.get();
    bus.emit('session.new');
    assert.deepEqual(cache.get(), { rev: 2 });
    bus.emit('sessions.reset');
    assert.deepEqual(cache.get(), { rev: 3 });
    bus.emit('skills.changed');
    assert.deepEqual(cache.get(), { rev: 4 });
  });

  test('events not in invalidateOn list are ignored', () => {
    let n = 0;
    const bus = new EventEmitter();
    const cache = createSkillsSnapshotCache({
      source: () => ({ rev: ++n }),
      eventBus: bus,
      invalidateOn: ['skills.changed'],
    });
    cache.get();
    bus.emit('session.new'); // not in the custom list
    assert.deepEqual(cache.get(), { rev: 1 });
    bus.emit('skills.changed');
    assert.deepEqual(cache.get(), { rev: 2 });
  });

  test('onInvalidate fires with the invalidation reason', () => {
    const reasons = [];
    const bus = new EventEmitter();
    const cache = createSkillsSnapshotCache({ source: () => ({}), eventBus: bus });
    cache.get();
    cache.onInvalidate((r) => reasons.push(r));
    bus.emit('sessions.reset');
    cache.invalidate('explicit');
    assert.deepEqual(reasons, ['sessions.reset', 'explicit']);
  });

  test('listener errors do not break the cache', () => {
    const bus = new EventEmitter();
    const cache = createSkillsSnapshotCache({ source: () => ({}), eventBus: bus });
    cache.get();
    cache.onInvalidate(() => { throw new Error('boom'); });
    cache.invalidate('x'); // must not throw
    assert.deepEqual(cache.get(), {}); // still works
  });

  test('detach unwires the bus and stops invalidations', () => {
    let n = 0;
    const bus = new EventEmitter();
    const cache = createSkillsSnapshotCache({ source: () => ({ rev: ++n }), eventBus: bus });
    cache.get();
    cache.detach();
    bus.emit('session.new');
    assert.deepEqual(cache.get(), { rev: 1 });
  });

  test('TTL forces a rebuild after expiry', () => {
    let t = 0;
    let n = 0;
    const cache = createSkillsSnapshotCache({
      source: () => ({ rev: ++n }),
      ttlMs: 1000,
      now: () => t,
    });
    cache.get();
    t = 500;
    assert.deepEqual(cache.get(), { rev: 1 });
    t = 1500;
    assert.deepEqual(cache.get(), { rev: 2 });
    assert.equal(cache.stats().lastReason, 'ttl_expired');
  });

  test('default invalidate events match the documented list', () => {
    assert.deepEqual([...DEFAULT_INVALIDATE_EVENTS], ['session.new', 'sessions.reset', 'skills.changed']);
  });

  test('throwing source propagates to caller', () => {
    const cache = createSkillsSnapshotCache({ source: () => { throw new Error('source bad'); } });
    assert.throws(() => cache.get(), /source bad/);
  });

  test('stats() snapshot reflects cache state', () => {
    const cache = createSkillsSnapshotCache({ source: () => ({}) });
    let s = cache.stats();
    assert.equal(s.cached, false);
    cache.get();
    s = cache.stats();
    assert.equal(s.cached, true);
    assert.ok(s.cachedAt >= 0);
  });
});
