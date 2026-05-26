/**
 * Tests for scheduler/cron.js — schedule parsing and nextAfter().
 * Uses node:test (matches the existing backend test harness).
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  parseSchedule,
  parseCron,
  parseInterval,
  nextAfter,
  CronParseError,
} = require('../src/scheduler/cron');

describe('parseInterval', () => {
  it('parses every Ns', () => {
    assert.deepStrictEqual(parseInterval('every 30s'), { kind: 'interval', expr: 'every 30s', intervalMs: 30_000 });
  });
  it('parses every Nm/h/d', () => {
    assert.strictEqual(parseInterval('every 5m').intervalMs, 300_000);
    assert.strictEqual(parseInterval('every 2h').intervalMs, 7_200_000);
    assert.strictEqual(parseInterval('every 1d').intervalMs, 86_400_000);
  });
  it('rejects garbage', () => {
    assert.throws(() => parseInterval('every abc'), CronParseError);
    assert.throws(() => parseInterval('every 0s'), CronParseError);
  });
});

describe('parseCron', () => {
  it('parses standard 5-field expression', () => {
    const p = parseCron('0 9 * * 1-5');
    assert.ok(p.minute.has(0));
    assert.ok(p.hour.has(9));
    assert.ok(p.dow.has(1) && p.dow.has(5));
    assert.ok(!p.dow.has(0));
  });
  it('handles step values', () => {
    const p = parseCron('*/15 * * * *');
    assert.deepStrictEqual([...p.minute].sort((a, b) => a - b), [0, 15, 30, 45]);
  });
  it('handles lists and ranges', () => {
    const p = parseCron('5,10 0-2 * * *');
    assert.deepStrictEqual([...p.minute].sort((a, b) => a - b), [5, 10]);
    assert.deepStrictEqual([...p.hour].sort((a, b) => a - b), [0, 1, 2]);
  });
  it('rejects out-of-range values', () => {
    assert.throws(() => parseCron('60 0 * * *'), CronParseError);
    assert.throws(() => parseCron('0 24 * * *'), CronParseError);
  });
  it('rejects wrong arity', () => {
    assert.throws(() => parseCron('* * * *'), CronParseError);
  });
});

describe('nextAfter (interval)', () => {
  it('adds the interval to from', () => {
    const p = parseSchedule('every 30s');
    const from = new Date('2026-01-01T00:00:00.000Z');
    const next = nextAfter(p, from);
    assert.strictEqual(next.getTime(), from.getTime() + 30_000);
  });
});

describe('nextAfter (cron)', () => {
  it('finds next minute match', () => {
    const p = parseCron('*/5 * * * *');
    const from = new Date('2026-05-08T10:02:30.000Z');
    const next = nextAfter(p, from);
    // Next */5 minute after 10:02:30 is 10:05:00.
    assert.strictEqual(next.getUTCMinutes(), 5);
    assert.strictEqual(next.getUTCSeconds(), 0);
  });

  it('skips disallowed hours', () => {
    const p = parseCron('0 9 * * *');
    const from = new Date('2026-05-08T10:00:00.000Z');
    const next = nextAfter(p, from);
    // Use local-time semantics: hour() === 9 in the runner's tz.
    assert.strictEqual(next.getHours(), 9);
    assert.strictEqual(next.getMinutes(), 0);
    assert.ok(next.getTime() > from.getTime());
  });

  it('honors weekday filter (1-5 mon-fri)', () => {
    const p = parseCron('0 8 * * 1-5');
    // Saturday 2026-05-09 (using local time context).
    const sat = new Date(2026, 4, 9, 10, 0, 0);
    const next = nextAfter(p, sat);
    const dow = next.getDay();
    assert.ok(dow >= 1 && dow <= 5, `expected weekday, got ${dow}`);
    assert.strictEqual(next.getHours(), 8);
  });

  it('returns a strictly future timestamp', () => {
    const p = parseCron('* * * * *');
    const from = new Date();
    const next = nextAfter(p, from);
    assert.ok(next.getTime() > from.getTime());
  });
});
