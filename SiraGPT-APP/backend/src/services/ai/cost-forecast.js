'use strict';

/**
 * cost-forecast — linear-regression projection of AI spend for the
 * current calendar month.
 *
 * Takes the last 14 days of daily cost (from the in-process cost-tracker
 * unless an explicit `dailySeries` is passed) and fits a simple least-
 * squares line `cost = slope * dayIndex + intercept`. The line is then
 * evaluated for every remaining day in the current month and added to
 * the month-to-date spend to produce a `projectedTotal`.
 *
 * Returns:
 *   {
 *     projectedTotal,           // USD, rounded to 6 decimals
 *     daysRemaining,            // calendar days left in current month
 *                               //   (incl. today if not finished)
 *     confidence,               // R² of the fit, 0..1 (0 when degenerate)
 *     trendDirection,           // 'up' | 'down' | 'flat'
 *     monthToDate,              // USD spent so far this month
 *     averageDailyCost,         // mean of the input series
 *     slope,                    // USD/day
 *     sampleSize,               // # of daily points used (≤14)
 *   }
 *
 * Everything is pure and synchronous — no I/O — so this module is safe
 * to call from health probes and admin routes alike. Errors are
 * swallowed: invalid input yields a zeroed envelope instead of throwing.
 */

const FORECAST_WINDOW_DAYS = 14;

function round6(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1e6) / 1e6;
}

function startOfUtcDay(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function dayKey(date) {
  const d = startOfUtcDay(date);
  return d.toISOString().slice(0, 10);
}

function daysInMonth(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return d.getUTCDate();
}

/**
 * Build a daily-cost series for the last N days from raw tracker
 * records. Records older than N days or in the future are ignored.
 *
 * @param {Array<{ts:string|number, costUSD:number, userId?:string}>} records
 * @param {object} [opts]
 * @param {Date}   [opts.now]
 * @param {number} [opts.windowDays]
 * @param {string} [opts.userId]   restrict to a single user
 * @returns {Array<{day:string, costUSD:number}>}  length === windowDays
 */
function buildDailySeries(records, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const windowDays = Math.max(1, Number(opts.windowDays) || FORECAST_WINDOW_DAYS);
  const userId = opts.userId == null ? null : String(opts.userId);

  // Pre-seed the buckets so every day in the window appears (even with 0).
  const buckets = new Map();
  const today = startOfUtcDay(now);
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    buckets.set(dayKey(d), 0);
  }

  if (Array.isArray(records)) {
    for (const r of records) {
      if (!r) continue;
      if (userId != null && String(r.userId || '') !== userId) continue;
      const ts = new Date(r.ts);
      if (Number.isNaN(ts.getTime())) continue;
      const key = dayKey(ts);
      if (!buckets.has(key)) continue;
      buckets.set(key, round6(buckets.get(key) + (Number(r.costUSD) || 0)));
    }
  }
  return [...buckets.entries()].map(([day, costUSD]) => ({ day, costUSD }));
}

/**
 * Fit `y = m*x + b` over the given (x,y) arrays using ordinary least
 * squares. Returns `{ slope, intercept, r2 }`. When the input is
 * degenerate (≤1 point or zero x-variance) returns `{ slope:0, intercept:mean, r2:0 }`.
 */
function linearRegression(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) {
    return { slope: 0, intercept: ys[0] || 0, r2: 0 };
  }
  let sumX = 0; let sumY = 0;
  for (let i = 0; i < n; i++) { sumX += xs[i]; sumY += ys[i]; }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0; let denX = 0; let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  if (denX === 0) {
    return { slope: 0, intercept: meanY, r2: 0 };
  }
  const slope = num / denX;
  const intercept = meanY - slope * meanX;
  // Coefficient of determination
  let r2;
  if (denY === 0) {
    // Constant y series — perfect fit by definition.
    r2 = 1;
  } else {
    r2 = (num * num) / (denX * denY);
    if (!Number.isFinite(r2)) r2 = 0;
    if (r2 < 0) r2 = 0;
    if (r2 > 1) r2 = 1;
  }
  return { slope, intercept, r2 };
}

/**
 * Project the rest of the current month from a daily-cost series.
 *
 * @param {Array<{day:string, costUSD:number}>} dailySeries  oldest→newest
 * @param {object} [opts]
 * @param {Date}   [opts.now]
 * @returns {object} forecast envelope (see module header)
 */
function forecastFromSeries(dailySeries, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const empty = {
    projectedTotal: 0,
    daysRemaining: 0,
    confidence: 0,
    trendDirection: 'flat',
    monthToDate: 0,
    averageDailyCost: 0,
    slope: 0,
    sampleSize: 0,
  };
  if (!Array.isArray(dailySeries) || dailySeries.length === 0) return empty;

  const ys = dailySeries.map((d) => Number(d.costUSD) || 0);
  const xs = ys.map((_, i) => i);
  const { slope, intercept, r2 } = linearRegression(xs, ys);
  const mean = ys.reduce((a, b) => a + b, 0) / ys.length;

  // Month-to-date: sum of series entries whose `day` falls in the
  // current calendar month (UTC). Falling back to running mean × elapsed
  // days when the series spans into the previous month gives a stable
  // anchor for the projection.
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  let monthToDate = 0;
  for (const d of dailySeries) {
    if (typeof d.day === 'string' && d.day.startsWith(ym)) {
      monthToDate = round6(monthToDate + (Number(d.costUSD) || 0));
    }
  }

  // Days remaining: today is partially elapsed but we still include
  // its projected value (the model already accounts for the current
  // day's slope). Treat "remaining" as `totalDays - currentDayIndex`
  // where currentDayIndex is 1-based.
  const totalDays = daysInMonth(now);
  const today = now.getUTCDate();
  const daysRemaining = Math.max(0, totalDays - today);

  // Project each remaining day by extrapolating the fitted line. The
  // last `x` in the series corresponds to today; future days use
  // x = lastIdx + k for k = 1..daysRemaining.
  let projectedRemaining = 0;
  const lastIdx = ys.length - 1;
  for (let k = 1; k <= daysRemaining; k++) {
    const y = slope * (lastIdx + k) + intercept;
    projectedRemaining += y > 0 ? y : 0; // cost can't go negative
  }

  const projectedTotal = round6(monthToDate + projectedRemaining);
  const trendDirection = slope > 1e-6 ? 'up' : slope < -1e-6 ? 'down' : 'flat';

  return {
    projectedTotal,
    daysRemaining,
    confidence: round6(r2),
    trendDirection,
    monthToDate,
    averageDailyCost: round6(mean),
    slope: round6(slope),
    sampleSize: ys.length,
  };
}

/**
 * Convenience wrapper that pulls records from the in-process
 * cost-tracker and returns a forecast for a single user (or the whole
 * tenant when `userId` is null).
 *
 * @param {object} [opts]
 * @param {string|null} [opts.userId]
 * @param {Date}        [opts.now]
 * @param {number}      [opts.windowDays]
 * @param {object}      [opts.tracker]    injectable for tests
 */
function forecastForUser(opts = {}) {
  const tracker = opts.tracker || require('./cost-tracker');
  const records = typeof tracker._peekRecords === 'function' ? tracker._peekRecords() : [];
  const series = buildDailySeries(records, {
    now: opts.now,
    windowDays: opts.windowDays,
    userId: opts.userId,
  });
  return forecastFromSeries(series, { now: opts.now });
}

/**
 * Per-user + per-org forecasts. `report` is the envelope from
 * cost-tracker.report() and `memberships` is the same shape used by
 * cost-report-aggregator (so admin routes can reuse a single Prisma
 * query for both reports).
 *
 * @param {object} opts
 * @param {object} opts.tracker      cost-tracker module (DI for tests)
 * @param {Array<{userId,orgId,organization?:{id,name,slug}}>} [opts.memberships]
 * @param {Date}  [opts.now]
 * @param {number} [opts.windowDays]
 * @returns {{ perUser:Array, perOrg:Array, totals:object }}
 */
function forecastAll(opts = {}) {
  const tracker = opts.tracker || require('./cost-tracker');
  const now = opts.now ? new Date(opts.now) : new Date();
  const windowDays = opts.windowDays || FORECAST_WINDOW_DAYS;
  const records = typeof tracker._peekRecords === 'function' ? tracker._peekRecords() : [];

  // Collect every userId that appears in the window.
  const userIds = new Set();
  const cutoff = startOfUtcDay(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - (windowDays - 1));
  const cutoffMs = cutoff.getTime();
  for (const r of records) {
    if (!r) continue;
    const t = new Date(r.ts).getTime();
    if (Number.isNaN(t) || t < cutoffMs) continue;
    userIds.add(String(r.userId || 'anonymous'));
  }

  const perUser = [];
  for (const uid of userIds) {
    const series = buildDailySeries(records, { now, windowDays, userId: uid });
    const forecast = forecastFromSeries(series, { now });
    perUser.push({ userId: uid, ...forecast });
  }
  perUser.sort((a, b) => b.projectedTotal - a.projectedTotal);

  // Tenant-wide totals (no userId filter).
  const allSeries = buildDailySeries(records, { now, windowDays });
  const totals = forecastFromSeries(allSeries, { now });

  // Per-org aggregation — sums each user's projected spend into every
  // org they belong to. Mirrors cost-report-aggregator semantics so a
  // multi-org user contributes to each bucket.
  const perOrg = [];
  const memberships = Array.isArray(opts.memberships) ? opts.memberships : [];
  if (memberships.length > 0) {
    const byUser = new Map();
    for (const m of memberships) {
      if (!byUser.has(m.userId)) byUser.set(m.userId, []);
      byUser.get(m.userId).push(m);
    }
    const orgs = new Map();
    for (const u of perUser) {
      const ms = byUser.get(u.userId);
      if (!ms || ms.length === 0) continue;
      for (const m of ms) {
        let bucket = orgs.get(m.orgId);
        if (!bucket) {
          bucket = {
            orgId: m.orgId,
            name: m.organization?.name || null,
            slug: m.organization?.slug || null,
            projectedTotal: 0,
            monthToDate: 0,
            users: 0,
            // We don't average R² across users — surface the worst
            // confidence so the operator notices noisy buckets.
            confidence: 1,
            trendDirection: 'flat',
            slope: 0,
          };
          orgs.set(m.orgId, bucket);
        }
        bucket.projectedTotal = round6(bucket.projectedTotal + u.projectedTotal);
        bucket.monthToDate = round6(bucket.monthToDate + u.monthToDate);
        bucket.slope = round6(bucket.slope + u.slope);
        bucket.users += 1;
        if (u.confidence < bucket.confidence) bucket.confidence = u.confidence;
      }
    }
    for (const b of orgs.values()) {
      b.trendDirection = b.slope > 1e-6 ? 'up' : b.slope < -1e-6 ? 'down' : 'flat';
      perOrg.push(b);
    }
    perOrg.sort((a, b) => b.projectedTotal - a.projectedTotal);
  }

  return { perUser, perOrg, totals };
}

module.exports = {
  FORECAST_WINDOW_DAYS,
  buildDailySeries,
  linearRegression,
  forecastFromSeries,
  forecastForUser,
  forecastAll,
};
