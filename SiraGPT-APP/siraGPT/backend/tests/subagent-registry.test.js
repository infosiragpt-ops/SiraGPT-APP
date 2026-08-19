'use strict';

/**
 * subagent-registry — TTL/GC behavior. Mirrors the openclaw v2026.5.7
 * fix that made archiveAfterMinutes config-driven instead of hardcoded.
 */

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createSubagentRegistry,
  resolveArchiveMs,
  DEFAULT_ARCHIVE_AFTER_MINUTES,
} = require('../src/services/agents/subagent-registry');

describe('resolveArchiveMs', () => {
  test('positive minutes → minutes * 60_000', () => {
    assert.equal(resolveArchiveMs(5), 5 * 60_000);
    assert.equal(resolveArchiveMs(120), 120 * 60_000);
  });
  test('zero / null / undefined / bad → default', () => {
    const def = DEFAULT_ARCHIVE_AFTER_MINUTES * 60_000;
    assert.equal(resolveArchiveMs(0), def);
    assert.equal(resolveArchiveMs(null), def);
    assert.equal(resolveArchiveMs(undefined), def);
    assert.equal(resolveArchiveMs('banana'), def);
    assert.equal(resolveArchiveMs(-3), def);
  });
  test('"never" / Infinity → Infinity', () => {
    assert.equal(resolveArchiveMs('never'), Infinity);
    assert.equal(resolveArchiveMs(Infinity), Infinity);
  });
  test('floors fractional minutes', () => {
    assert.equal(resolveArchiveMs(2.7), 2 * 60_000);
  });
});

describe('createSubagentRegistry — record/complete/get/list', () => {
  test('record stores active row with createdAt = now()', () => {
    let t = 1_000_000;
    const reg = createSubagentRegistry({ now: () => t });
    const row = reg.record({ id: 's1', parentId: 'p1', model: 'gpt-4o' });
    assert.equal(row.id, 's1');
    assert.equal(row.parentId, 'p1');
    assert.equal(row.model, 'gpt-4o');
    assert.equal(row.status, 'active');
    assert.equal(row.createdAt, 1_000_000);
    assert.equal(row.completedAt, null);
  });

  test('complete sets terminal status and completedAt', () => {
    let t = 0;
    const reg = createSubagentRegistry({ now: () => t });
    reg.record({ id: 's1' });
    t = 5_000;
    const row = reg.complete('s1', { status: 'completed' });
    assert.equal(row.status, 'completed');
    assert.equal(row.completedAt, 5_000);
  });

  test('complete on unknown id returns null', () => {
    const reg = createSubagentRegistry();
    assert.equal(reg.complete('nope'), null);
  });

  test('list filters by status and parentId', () => {
    const reg = createSubagentRegistry();
    reg.record({ id: 'a', parentId: 'p1' });
    reg.record({ id: 'b', parentId: 'p1' });
    reg.record({ id: 'c', parentId: 'p2' });
    reg.complete('a');
    assert.equal(reg.list({ status: 'completed' }).length, 1);
    assert.equal(reg.list({ parentId: 'p1' }).length, 2);
    assert.equal(reg.list({ status: 'active', parentId: 'p1' }).length, 1);
  });

  test('record rejects bad status', () => {
    const reg = createSubagentRegistry();
    assert.throws(() => reg.record({ id: 's', status: 'gibberish' }));
  });

  test('record rejects empty id', () => {
    const reg = createSubagentRegistry();
    assert.throws(() => reg.record({ id: '' }));
  });
});

describe('createSubagentRegistry — gc respects configured TTL', () => {
  test('prunes terminal rows older than archiveAfterMinutes', () => {
    let t = 0;
    const reg = createSubagentRegistry({ archiveAfterMinutes: 10, now: () => t });
    reg.record({ id: 'old' });
    reg.record({ id: 'fresh' });
    reg.complete('old');
    reg.complete('fresh');
    // Move time forward 11 minutes → only 'old' is past TTL? both are
    // terminal at t=0, so both age together. Move fresh later instead.
    t = 5 * 60_000;
    reg.complete('fresh'); // bump completedAt
    t = 11 * 60_000;
    const pruned = reg.gc();
    assert.equal(pruned, 1);
    assert.equal(reg.get('old'), null);
    assert.ok(reg.get('fresh'));
  });

  test('never prunes active rows even when arbitrarily old', () => {
    let t = 0;
    const reg = createSubagentRegistry({ archiveAfterMinutes: 1, now: () => t });
    reg.record({ id: 'long-runner' });
    t = 365 * 24 * 60 * 60_000; // a year
    assert.equal(reg.gc(), 0);
    assert.ok(reg.get('long-runner'));
  });

  test('archiveAfterMinutes="never" disables GC entirely', () => {
    let t = 0;
    const reg = createSubagentRegistry({ archiveAfterMinutes: 'never', now: () => t });
    reg.record({ id: 's' });
    reg.complete('s');
    t = Number.MAX_SAFE_INTEGER;
    assert.equal(reg.gc(), 0);
    assert.ok(reg.get('s'));
  });

  test('uses DEFAULT_ARCHIVE_AFTER_MINUTES when config omitted', () => {
    const reg = createSubagentRegistry();
    assert.equal(reg.archiveAfterMs(), DEFAULT_ARCHIVE_AFTER_MINUTES * 60_000);
  });
});

describe('createSubagentRegistry — startGcLoop', () => {
  test('returns a no-op stop when TTL is "never"', () => {
    const reg = createSubagentRegistry({ archiveAfterMinutes: 'never' });
    const stop = reg.startGcLoop();
    assert.equal(typeof stop, 'function');
    stop(); // must not throw
  });

  test('returns a stop function that clears the interval', () => {
    const reg = createSubagentRegistry({ archiveAfterMinutes: 60, gcIntervalMs: 1_000_000 });
    const stop = reg.startGcLoop();
    assert.equal(typeof stop, 'function');
    stop();
  });
});
