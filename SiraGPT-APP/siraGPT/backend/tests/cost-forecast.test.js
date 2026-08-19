'use strict';

/**
 * Ratchet 45 — cost-forecast linear-regression projection tests.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDailySeries,
  linearRegression,
  forecastFromSeries,
  forecastAll,
  FORECAST_WINDOW_DAYS,
} = require('../src/services/ai/cost-forecast');

function utc(y, m, d, h = 0) {
  return new Date(Date.UTC(y, m - 1, d, h));
}

describe('cost-forecast · linearRegression', () => {
  test('fits a perfect line with R²≈1', () => {
    const xs = [0, 1, 2, 3, 4];
    const ys = [1, 3, 5, 7, 9]; // y = 2x + 1
    const { slope, intercept, r2 } = linearRegression(xs, ys);
    assert.equal(Math.round(slope * 1e4) / 1e4, 2);
    assert.equal(Math.round(intercept * 1e4) / 1e4, 1);
    assert.equal(Math.round(r2 * 1e6) / 1e6, 1);
  });

  test('returns zero slope for constant series', () => {
    const { slope, r2 } = linearRegression([0, 1, 2, 3], [5, 5, 5, 5]);
    assert.equal(slope, 0);
    // Constant y → r2 = 1 by definition (the constant mean explains all variance).
    assert.equal(r2, 1);
  });

  test('handles degenerate input (≤1 sample)', () => {
    const r = linearRegression([0], [42]);
    assert.equal(r.slope, 0);
    assert.equal(r.intercept, 42);
    assert.equal(r.r2, 0);
  });

  test('detects negative trend', () => {
    const { slope } = linearRegression([0, 1, 2, 3], [10, 7, 4, 1]);
    assert.ok(slope < 0);
  });
});

describe('cost-forecast · buildDailySeries', () => {
  test('seeds every day in the window with zero, fills from records', () => {
    const now = utc(2026, 5, 15);
    const records = [
      { ts: utc(2026, 5, 14, 10).toISOString(), costUSD: 1.5 },
      { ts: utc(2026, 5, 13, 5).toISOString(), costUSD: 2.0 },
      { ts: utc(2026, 5, 14, 23).toISOString(), costUSD: 0.5 },
    ];
    const series = buildDailySeries(records, { now, windowDays: 5 });
    assert.equal(series.length, 5);
    assert.equal(series[series.length - 1].day, '2026-05-15');
    assert.equal(series[series.length - 2].day, '2026-05-14');
    assert.equal(series[series.length - 2].costUSD, 2); // 1.5 + 0.5
    assert.equal(series[series.length - 3].costUSD, 2);
  });

  test('filters by userId', () => {
    const now = utc(2026, 5, 15);
    const records = [
      { ts: utc(2026, 5, 15).toISOString(), costUSD: 1, userId: 'a' },
      { ts: utc(2026, 5, 15).toISOString(), costUSD: 9, userId: 'b' },
    ];
    const series = buildDailySeries(records, { now, windowDays: 1, userId: 'a' });
    assert.equal(series[0].costUSD, 1);
  });

  test('ignores out-of-window records', () => {
    const now = utc(2026, 5, 15);
    const records = [
      { ts: utc(2026, 1, 1).toISOString(), costUSD: 100 }, // way too old
    ];
    const series = buildDailySeries(records, { now, windowDays: 3 });
    assert.equal(series.reduce((a, b) => a + b.costUSD, 0), 0);
  });
});

describe('cost-forecast · forecastFromSeries', () => {
  test('projects a flat series as constant cost', () => {
    // 14 days of $1/day. Run "now" near mid-month so daysRemaining > 0.
    const now = utc(2026, 5, 14);
    const series = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(now); d.setUTCDate(d.getUTCDate() - (13 - i));
      series.push({ day: d.toISOString().slice(0, 10), costUSD: 1 });
    }
    const r = forecastFromSeries(series, { now });
    assert.equal(r.trendDirection, 'flat');
    assert.equal(r.sampleSize, 14);
    // 14 days into May (1..14) at $1 + 17 remaining days × ~$1 → ~$31.
    assert.ok(r.projectedTotal >= 30 && r.projectedTotal <= 32, `projected=${r.projectedTotal}`);
    assert.equal(r.daysRemaining, 31 - 14);
    // monthToDate should sum the 14 days within May.
    assert.equal(r.monthToDate, 14);
  });

  test('detects rising trend', () => {
    const now = utc(2026, 5, 14);
    const series = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(now); d.setUTCDate(d.getUTCDate() - (13 - i));
      series.push({ day: d.toISOString().slice(0, 10), costUSD: i + 1 });
    }
    const r = forecastFromSeries(series, { now });
    assert.equal(r.trendDirection, 'up');
    assert.ok(r.slope > 0);
    assert.ok(r.confidence > 0.9);
    // Each remaining day projects > 14 (line keeps climbing), so total
    // dwarfs monthToDate.
    assert.ok(r.projectedTotal > r.monthToDate);
  });

  test('clips negative projections to zero', () => {
    const now = utc(2026, 5, 14);
    const series = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(now); d.setUTCDate(d.getUTCDate() - (13 - i));
      series.push({ day: d.toISOString().slice(0, 10), costUSD: Math.max(0, 14 - i * 2) });
    }
    const r = forecastFromSeries(series, { now });
    assert.equal(r.trendDirection, 'down');
    // Projection can extrapolate below zero; the implementation clamps.
    assert.ok(r.projectedTotal >= r.monthToDate);
  });

  test('empty/invalid input returns zeroed envelope', () => {
    const r = forecastFromSeries(null);
    assert.equal(r.projectedTotal, 0);
    assert.equal(r.confidence, 0);
    assert.equal(r.trendDirection, 'flat');
    assert.equal(r.sampleSize, 0);
  });

  test('FORECAST_WINDOW_DAYS exported as 14', () => {
    assert.equal(FORECAST_WINDOW_DAYS, 14);
  });
});

describe('cost-forecast · forecastAll', () => {
  test('aggregates per-user records via injected tracker', () => {
    const now = utc(2026, 5, 14);
    const records = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(now); d.setUTCDate(d.getUTCDate() - (13 - i));
      records.push({ ts: d.toISOString(), costUSD: 1, userId: 'u1' });
      records.push({ ts: d.toISOString(), costUSD: 2, userId: 'u2' });
    }
    const tracker = { _peekRecords: () => records };
    const r = forecastAll({ tracker, now });
    assert.equal(r.perUser.length, 2);
    // perUser sorted desc by projectedTotal → u2 first.
    assert.equal(r.perUser[0].userId, 'u2');
    assert.ok(r.perUser[0].projectedTotal > r.perUser[1].projectedTotal);
    assert.ok(r.totals.projectedTotal >= r.perUser[0].projectedTotal);
    assert.deepEqual(r.perOrg, []);
  });

  test('rolls per-user forecasts up to orgs via memberships', () => {
    const now = utc(2026, 5, 14);
    const records = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(now); d.setUTCDate(d.getUTCDate() - (13 - i));
      records.push({ ts: d.toISOString(), costUSD: 1, userId: 'u1' });
      records.push({ ts: d.toISOString(), costUSD: 2, userId: 'u2' });
    }
    const tracker = { _peekRecords: () => records };
    const memberships = [
      { userId: 'u1', orgId: 'org-A', organization: { id: 'org-A', name: 'Alpha', slug: 'alpha' } },
      { userId: 'u2', orgId: 'org-A', organization: { id: 'org-A', name: 'Alpha', slug: 'alpha' } },
    ];
    const r = forecastAll({ tracker, memberships, now });
    assert.equal(r.perOrg.length, 1);
    assert.equal(r.perOrg[0].orgId, 'org-A');
    assert.equal(r.perOrg[0].users, 2);
    assert.ok(r.perOrg[0].projectedTotal > 0);
  });

  test('multi-org user contributes to each org bucket', () => {
    const now = utc(2026, 5, 14);
    const records = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(now); d.setUTCDate(d.getUTCDate() - (13 - i));
      records.push({ ts: d.toISOString(), costUSD: 5, userId: 'u1' });
    }
    const tracker = { _peekRecords: () => records };
    const memberships = [
      { userId: 'u1', orgId: 'org-A', organization: { id: 'org-A', name: 'A', slug: 'a' } },
      { userId: 'u1', orgId: 'org-B', organization: { id: 'org-B', name: 'B', slug: 'b' } },
    ];
    const r = forecastAll({ tracker, memberships, now });
    assert.equal(r.perOrg.length, 2);
    for (const b of r.perOrg) assert.equal(b.users, 1);
  });

  test('empty records produces empty perUser / zero totals', () => {
    const r = forecastAll({ tracker: { _peekRecords: () => [] } });
    assert.deepEqual(r.perUser, []);
    assert.deepEqual(r.perOrg, []);
    assert.equal(r.totals.projectedTotal, 0);
  });
});
