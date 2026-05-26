/**
 * Unit tests for services/ai/anomaly-detector.js.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const ad = require('../src/services/ai/anomaly-detector');

beforeEach(() => ad._reset());

test('stats returns zeros for empty input', () => {
  const { mean, stddev, n } = ad.stats([]);
  assert.equal(mean, 0);
  assert.equal(stddev, 0);
  assert.equal(n, 0);
});

test('stats computes mean and stddev correctly', () => {
  const { mean, stddev } = ad.stats([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(mean, 5);
  // Population stddev of this textbook example is exactly 2.
  assert.equal(Math.round(stddev * 1000), 2000);
});

test('check returns insufficient-history when < minDatapoints', () => {
  ad.record('u1', 1000);
  const result = ad.check('u1', 999_999);
  assert.equal(result.flagged, false);
  assert.equal(result.reason, 'insufficient-history');
});

test('check does not flag when below 3-sigma threshold', () => {
  // Vary daily usage so stddev > 0 — mean ≈ 1000, stddev ≈ 200.
  const samples = [800, 900, 1000, 1100, 1200, 950, 1050];
  for (let i = 0; i < samples.length; i++) {
    ad.record('u1', samples[i], new Date(2025, 0, i + 1));
  }
  // 1200 is within mean + 3σ (~1600) so it should NOT be flagged.
  const result = ad.check('u1', 1200);
  assert.equal(result.flagged, false);
});

test('check flags requests far above the rolling mean+3sigma', () => {
  for (let i = 0; i < 10; i++) {
    ad.record('u1', 1000, new Date(2025, 0, i + 1));
  }
  // mean ≈ 1000, stddev ≈ 0 → threshold ≈ 1000. 100k tokens > threshold.
  const result = ad.check('u1', 100_000);
  assert.equal(result.flagged, true);
});

test('check respects the env BLOCK_ANOMALOUS_USAGE flag', () => {
  for (let i = 0; i < 10; i++) ad.record('u1', 1000, new Date(2025, 0, i + 1));
  const prior = process.env.BLOCK_ANOMALOUS_USAGE;
  try {
    process.env.BLOCK_ANOMALOUS_USAGE = '1';
    const result = ad.check('u1', 100_000);
    assert.equal(result.flagged, true);
    assert.equal(result.block, true);
  } finally {
    if (prior === undefined) delete process.env.BLOCK_ANOMALOUS_USAGE;
    else process.env.BLOCK_ANOMALOUS_USAGE = prior;
  }
});

test('configure overrides sigma', () => {
  ad.configure({ sigma: 1, minDatapoints: 5 });
  for (let i = 0; i < 6; i++) ad.record('u1', 1000, new Date(2025, 0, i + 1));
  // With sigma=1 and stddev=0, any value > mean flags.
  const result = ad.check('u1', 1500);
  assert.equal(result.flagged, true);
});

test('record accumulates same-day usage', () => {
  const ts = new Date('2025-06-15T10:00:00Z');
  ad.record('u1', 100, ts);
  ad.record('u1', 200, ts);
  const peek = ad._peek('u1');
  assert.equal(peek['2025-06-15'], 300);
});

test('dayKey is UTC-stable', () => {
  const k1 = ad.dayKey(new Date('2025-01-15T23:59:59Z'));
  const k2 = ad.dayKey(new Date('2025-01-15T00:00:01Z'));
  assert.equal(k1, '2025-01-15');
  assert.equal(k2, '2025-01-15');
});
