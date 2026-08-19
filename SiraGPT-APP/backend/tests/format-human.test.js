'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  formatBytes,
  formatDuration,
  formatNumber,
  parseDuration,
} = require('../src/utils/format-human');

describe('formatBytes — binary (default)', () => {
  test('B / KiB / MiB / GiB', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1024), '1.0 KiB');
    assert.equal(formatBytes(1024 * 1024), '1.0 MiB');
    assert.equal(formatBytes(1024 ** 3), '1.0 GiB');
  });

  test('decimals option', () => {
    assert.equal(formatBytes(1500, { decimals: 2 }), '1.46 KiB');
  });

  test('negative bytes show sign', () => {
    assert.equal(formatBytes(-2048), '-2.0 KiB');
  });

  test('NaN safe-fallback', () => {
    assert.equal(formatBytes(NaN), 'NaN B');
  });
});

describe('formatBytes — decimal', () => {
  test('1000 = 1.0 KB in decimal mode', () => {
    assert.equal(formatBytes(1000, { binary: false }), '1.0 KB');
  });
});

describe('formatDuration', () => {
  test('< 1s shows ms', () => {
    assert.equal(formatDuration(450), '450ms');
    assert.equal(formatDuration(0), '0ms');
  });

  test('seconds with optional ms tail', () => {
    assert.equal(formatDuration(2300), '2s 300ms');
    assert.equal(formatDuration(5000), '5s');
  });

  test('minutes with optional seconds tail', () => {
    assert.equal(formatDuration(83_000), '1m 23s');
    assert.equal(formatDuration(60_000), '1m');
  });

  test('hours / days', () => {
    assert.equal(formatDuration(3_600_000), '1h');
    assert.equal(formatDuration(3_660_000), '1h 1m');
    assert.equal(formatDuration(86_400_000), '1d');
    assert.equal(formatDuration(90_000_000), '1d 1h');
  });

  test('compact mode drops the space', () => {
    assert.equal(formatDuration(83_000, { compact: true }), '1m23s');
  });

  test('negative duration shows minus', () => {
    assert.equal(formatDuration(-2300), '-2s 300ms');
  });

  test('NaN-safe', () => {
    assert.equal(formatDuration(NaN), 'NaN');
  });
});

describe('formatNumber', () => {
  test('< 1000 unchanged', () => {
    assert.equal(formatNumber(0), '0');
    assert.equal(formatNumber(42), '42');
    assert.equal(formatNumber(999), '999');
  });

  test('SI suffixes', () => {
    assert.equal(formatNumber(1500), '1.5k');
    assert.equal(formatNumber(2_400_000), '2.4M');
    assert.equal(formatNumber(7_500_000_000), '7.5B');
  });

  test('NaN-safe', () => {
    assert.equal(formatNumber(NaN), 'NaN');
  });
});

describe('parseDuration', () => {
  test('single units', () => {
    assert.equal(parseDuration('500ms'), 500);
    assert.equal(parseDuration('5s'), 5000);
    assert.equal(parseDuration('2m'), 120_000);
    assert.equal(parseDuration('1h'), 3_600_000);
    assert.equal(parseDuration('1d'), 86_400_000);
  });

  test('composite duration sums parts', () => {
    assert.equal(parseDuration('1h 30m'), 5_400_000);
    assert.equal(parseDuration('2h30m15s'), 2 * 3_600_000 + 30 * 60_000 + 15 * 1000);
  });

  test('plain number returns number-as-ms', () => {
    assert.equal(parseDuration('1500'), 1500);
  });

  test('null / unparseable → 0', () => {
    assert.equal(parseDuration(null), 0);
    assert.equal(parseDuration('garbage'), 0);
  });
});

describe('round-trip formatDuration ↔ parseDuration', () => {
  test('formatDuration output is parseable back', () => {
    // Tolerance scales with the dropped sub-unit: ms→s rounds to 1s,
    // s→m rounds to 1m, m→h rounds to 1h, h→d rounds to 1d.
    const cases = [
      [1500, 1000],            // s level, drops ms after s
      [90_000, 1000],
      [3_660_000, 60_000],     // h level, drops s
      [86_460_000, 3_600_000], // d level, drops m / h
    ];
    for (const [ms, tol] of cases) {
      const formatted = formatDuration(ms, { compact: true });
      const parsed = parseDuration(formatted);
      assert.ok(Math.abs(parsed - ms) <= tol, `${formatted} → ${parsed} (target ${ms})`);
    }
  });
});
