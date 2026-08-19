'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  parseCron,
  matches,
  nextRun,
  isValidExpression,
  CronError,
} = require('../src/utils/cron-expression');

describe('parseCron', () => {
  test('all-stars expands to full ranges', () => {
    const p = parseCron('* * * * *');
    assert.equal(p.fields[0].size, 60);
    assert.equal(p.fields[1].size, 24);
    assert.equal(p.fields[2].size, 31);
    assert.equal(p.fields[3].size, 12);
    assert.equal(p.fields[4].size, 7);
  });

  test('single value, list, range, step', () => {
    assert.deepEqual([...parseCron('5 * * * *').fields[0]], [5]);
    assert.deepEqual([...parseCron('1,3,5 * * * *').fields[0]].sort((a, b) => a - b), [1, 3, 5]);
    assert.deepEqual([...parseCron('10-12 * * * *').fields[0]].sort((a, b) => a - b), [10, 11, 12]);
    assert.deepEqual([...parseCron('*/15 * * * *').fields[0]].sort((a, b) => a - b), [0, 15, 30, 45]);
  });

  test('bare-number step "N/S" expands N..max by S (not a single value)', () => {
    // Regression: '5/15' used to collapse to just {5}.
    assert.deepEqual([...parseCron('5/15 * * * *').fields[0]].sort((a, b) => a - b), [5, 20, 35, 50]);
    assert.deepEqual([...parseCron('2/10 * * * *').fields[0]].sort((a, b) => a - b), [2, 12, 22, 32, 42, 52]);
    // No step → still a single value.
    assert.deepEqual([...parseCron('7 * * * *').fields[0]], [7]);
  });

  test('DOW=7 normalized to 0 (Sunday)', () => {
    const p = parseCron('* * * * 7');
    assert.equal(p.fields[4].has(0), true);
    assert.equal(p.fields[4].has(7), false);
  });

  test('rejects bad expressions', () => {
    assert.throws(() => parseCron(''), CronError);
    assert.throws(() => parseCron('* * * *'), CronError);
    assert.throws(() => parseCron('99 * * * *'), CronError);
    assert.throws(() => parseCron('5-3 * * * *'), CronError);
    assert.throws(() => parseCron('*/0 * * * *'), CronError);
  });
});

describe('matches + nextRun — common patterns', () => {
  test('every minute matches any timestamp', () => {
    const p = parseCron('* * * * *');
    assert.equal(matches(p, new Date('2026-05-09T12:34:00')), true);
  });

  test('"0 9 * * 1-5": 9am Mon-Fri', () => {
    const p = parseCron('0 9 * * 1-5');
    assert.equal(matches(p, new Date('2026-05-11T09:00:00')), true); // Monday
    assert.equal(matches(p, new Date('2026-05-09T09:00:00')), false); // Saturday
    assert.equal(matches(p, new Date('2026-05-11T09:01:00')), false); // wrong minute
  });

  test('nextRun returns strictly greater minute', () => {
    const p = parseCron('*/15 * * * *');
    const nx = nextRun(p, new Date('2026-05-09T12:14:30'));
    assert.equal(nx.getMinutes(), 15);
    assert.equal(nx.getHours(), 12);
  });

  test('nextRun for "0 0 1 1 *" (Jan 1 00:00)', () => {
    const p = parseCron('0 0 1 1 *');
    const nx = nextRun(p, new Date('2026-05-09T00:00:00'));
    assert.equal(nx.getFullYear(), 2027);
    assert.equal(nx.getMonth(), 0);
    assert.equal(nx.getDate(), 1);
  });

  test('OR semantics for DOM/DOW when both restricted', () => {
    // Fire on the 1st of any month OR on Sunday.
    const p = parseCron('0 0 1 * 0');
    // 2026-05-03 is a Sunday and not the 1st → should match (DOW).
    assert.equal(matches(p, new Date('2026-05-03T00:00:00')), true);
    // 2026-06-01 is a Monday but is the 1st → should match (DOM).
    assert.equal(matches(p, new Date('2026-06-01T00:00:00')), true);
    // 2026-05-12 is a Tuesday and not the 1st → should NOT match.
    assert.equal(matches(p, new Date('2026-05-12T00:00:00')), false);
  });
});

describe('isValidExpression', () => {
  test('happy strings → true', () => {
    assert.equal(isValidExpression('* * * * *'), true);
    assert.equal(isValidExpression('0 9 * * 1-5'), true);
  });
  test('bad strings → false', () => {
    assert.equal(isValidExpression('99 * * * *'), false);
    assert.equal(isValidExpression(''), false);
  });
});

describe('matches — month + dom edge cases', () => {
  test('respects month restriction', () => {
    const p = parseCron('0 0 1 6 *');
    assert.equal(matches(p, new Date('2026-06-01T00:00:00')), true);
    assert.equal(matches(p, new Date('2026-05-01T00:00:00')), false);
  });
});
