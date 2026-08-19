/**
 * Tests for services/agents/budget.js — per-user token + RPM budgets.
 */

'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');

const {
  checkAllowed,
  record,
  getUsage,
  budgetMiddleware,
  _reset,
  DAILY_TOKENS,
  HOURLY_TOKENS,
  RPM,
  MAX_LEDGER_USERS,
  MAX_RPM_LOG_ENTRIES,
  MAX_USER_ID_LENGTH,
} = require('../src/services/agents/budget');

beforeEach(() => {
  _reset();
});

// ── exported defaults ──────────────────────────────────────────

describe('exported defaults', () => {
  it('DAILY_TOKENS / HOURLY_TOKENS / RPM are positive integers', () => {
    for (const v of [DAILY_TOKENS, HOURLY_TOKENS, RPM, MAX_LEDGER_USERS, MAX_RPM_LOG_ENTRIES, MAX_USER_ID_LENGTH]) {
      assert.equal(typeof v, 'number');
      assert.ok(v > 0);
      assert.ok(Number.isInteger(v));
    }
  });

  it('daily >= hourly (sanity check on the cap hierarchy)', () => {
    assert.ok(DAILY_TOKENS >= HOURLY_TOKENS);
  });
});

// ── checkAllowed / record ──────────────────────────────────────

describe('checkAllowed (fresh user)', () => {
  it('allows the first call', () => {
    assert.deepEqual(checkAllowed('u1'), { allowed: true });
  });

  it('allows when usage is under all caps', () => {
    record('u1', { tokens: 1000 });
    assert.deepEqual(checkAllowed('u1'), { allowed: true });
  });

  it('rejects invalid user ids before they become ledger keys', () => {
    assert.throws(() => checkAllowed(''), /budget userId/);
    assert.throws(() => checkAllowed(`u${'\n'}1`), /budget userId/);
    assert.throws(() => checkAllowed('u'.repeat(MAX_USER_ID_LENGTH + 1)), /budget userId/);
  });
});

describe('checkAllowed · daily cap', () => {
  it('rejects when daily budget exhausted', () => {
    record('u1', { tokens: DAILY_TOKENS });
    const out = checkAllowed('u1');
    assert.equal(out.allowed, false);
    assert.match(out.reason, /daily token budget/);
    assert.ok(out.retryAfterMs > 0);
  });

  it('honours custom daily cap', () => {
    record('u1', { tokens: 100 });
    const out = checkAllowed('u1', { caps: { daily: 50 } });
    assert.equal(out.allowed, false);
    assert.match(out.reason, /daily token budget \(50\)/);
  });

  it('treats a zero daily cap as an explicit hard stop', () => {
    const out = checkAllowed('u1', { caps: { daily: 0 } });
    assert.equal(out.allowed, false);
    assert.match(out.reason, /daily token budget \(0\)/);
    assert.ok(out.retryAfterMs > 0);
  });
});

describe('checkAllowed · hourly cap', () => {
  it('rejects when hourly cap exhausted (with daily still available)', () => {
    record('u1', { tokens: HOURLY_TOKENS });
    const out = checkAllowed('u1');
    assert.equal(out.allowed, false);
    assert.match(out.reason, /hourly token budget/);
    assert.ok(out.retryAfterMs > 0);
  });

  it('hourly cap independent of daily — custom override', () => {
    record('u1', { tokens: 5000 });
    const out = checkAllowed('u1', { caps: { daily: 1_000_000, hourly: 100 } });
    assert.equal(out.allowed, false);
    assert.match(out.reason, /hourly token budget \(100\)/);
  });

  it('invalid cap values fall back instead of poisoning checks with NaN', () => {
    record('u1', { tokens: 100 });
    const out = checkAllowed('u1', { caps: { daily: Number.NaN, hourly: -1, rpm: Number.POSITIVE_INFINITY } });
    assert.deepEqual(out, { allowed: true });
  });
});

describe('checkAllowed · RPM cap', () => {
  it('allows up to RPM requests in the rolling minute window', () => {
    for (let i = 0; i < RPM; i++) {
      record('u1', { tokens: 1 });
    }
    // RPM requests recorded, the next checkAllowed should reject.
    const out = checkAllowed('u1');
    assert.equal(out.allowed, false);
    assert.match(out.reason, /requests per minute exceeded/);
  });

  it('honours custom RPM cap', () => {
    for (let i = 0; i < 5; i++) record('u1', { tokens: 1 });
    const out = checkAllowed('u1', { caps: { rpm: 5 } });
    assert.equal(out.allowed, false);
    assert.match(out.reason, /5 requests per minute exceeded/);
  });

  it('retryAfterMs is at least 1000ms for RPM rejection', () => {
    for (let i = 0; i < 3; i++) record('u1', { tokens: 1 });
    const out = checkAllowed('u1', { caps: { rpm: 3 } });
    assert.ok(out.retryAfterMs >= 1000);
  });

  it('zero RPM rejects deterministically without reading a missing oldest timestamp', () => {
    const out = checkAllowed('u1', { caps: { rpm: 0 } });
    assert.equal(out.allowed, false);
    assert.match(out.reason, /0 requests per minute exceeded/);
    assert.equal(out.retryAfterMs, 60_000);
  });
});

// ── record ─────────────────────────────────────────────────────

describe('record', () => {
  it('increments hour + day token counters', () => {
    record('u1', { tokens: 100 });
    record('u1', { tokens: 200 });
    const u = getUsage('u1');
    assert.equal(u.hourTokens, 300);
    assert.equal(u.dayTokens, 300);
  });

  it('increments request counters', () => {
    record('u1', { tokens: 1 });
    record('u1', { tokens: 1 });
    record('u1', { tokens: 1 });
    const u = getUsage('u1');
    assert.equal(u.hourRequests, 3);
    assert.equal(u.dayRequests, 3);
  });

  it('default tokens=0 when not supplied', () => {
    record('u1');
    const u = getUsage('u1');
    assert.equal(u.hourTokens, 0);
    assert.equal(u.hourRequests, 1);
  });

  it('ignores negative, infinite and NaN token deltas', () => {
    record('u1', { tokens: -100 });
    record('u1', { tokens: Number.NaN });
    record('u1', { tokens: Number.POSITIVE_INFINITY });
    const u = getUsage('u1');
    assert.equal(u.hourTokens, 0);
    assert.equal(u.dayTokens, 0);
    assert.equal(u.hourRequests, 3);
  });

  it('floors fractional token deltas before recording', () => {
    record('u1', { tokens: 10.9 });
    const u = getUsage('u1');
    assert.equal(u.hourTokens, 10);
    assert.equal(u.dayTokens, 10);
  });

  it('isolates per-user state', () => {
    record('u1', { tokens: 100 });
    record('u2', { tokens: 200 });
    assert.equal(getUsage('u1').hourTokens, 100);
    assert.equal(getUsage('u2').hourTokens, 200);
  });
});

// ── getUsage ───────────────────────────────────────────────────

describe('getUsage', () => {
  it('returns zeros for unknown user', () => {
    assert.deepEqual(getUsage('nobody'), {
      dayTokens: 0,
      hourTokens: 0,
      dayRequests: 0,
      hourRequests: 0,
    });
  });

  it('returns zeros for invalid user ids', () => {
    assert.deepEqual(getUsage(null), {
      dayTokens: 0,
      hourTokens: 0,
      dayRequests: 0,
      hourRequests: 0,
    });
  });

  it('returns current usage for known user', () => {
    record('u1', { tokens: 100 });
    const u = getUsage('u1');
    assert.equal(u.hourTokens, 100);
    assert.equal(u.dayTokens, 100);
    assert.equal(u.hourRequests, 1);
    assert.equal(u.dayRequests, 1);
  });
});

// ── budgetMiddleware ──────────────────────────────────────────

describe('budgetMiddleware', () => {
  function mockRes() {
    const state = { statusCode: 200, body: null, headers: {} };
    return {
      state,
      status(code) { state.statusCode = code; return this; },
      json(obj) { state.body = obj; return this; },
      setHeader(k, v) { state.headers[k] = v; },
    };
  }

  it('returns a function (express middleware)', () => {
    const mw = budgetMiddleware();
    assert.equal(typeof mw, 'function');
  });

  it('calls next() and skips check when req.user.id is absent', () => {
    let nextCalled = false;
    const mw = budgetMiddleware();
    mw({}, mockRes(), () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  it('calls next() when under cap', () => {
    let nextCalled = false;
    const mw = budgetMiddleware();
    mw({ user: { id: 'u1' } }, mockRes(), () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  it('returns 429 with Retry-After header when over cap', () => {
    record('u1', { tokens: DAILY_TOKENS });
    let nextCalled = false;
    const res = mockRes();
    const mw = budgetMiddleware();
    mw({ user: { id: 'u1' }, requestId: 'req_budget_1' }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.state.statusCode, 429);
    assert.equal(res.state.body.ok, false);
    assert.equal(res.state.body.error, 'rate_limited');
    assert.equal(res.state.body.code, 'agent_budget_limited');
    assert.match(res.state.body.reason, /daily token budget/);
    assert.equal(typeof res.state.body.retryAfterSec, 'number');
    assert.equal(res.state.body.requestId, 'req_budget_1');
    assert.ok(res.state.headers['Retry-After']);
    assert.equal(res.state.headers['Cache-Control'], 'no-store');
    assert.equal(res.state.headers['X-Content-Type-Options'], 'nosniff');
  });

  it('Retry-After header is in seconds (Math.ceil of retryAfterMs/1000)', () => {
    record('u1', { tokens: DAILY_TOKENS });
    const res = mockRes();
    const mw = budgetMiddleware();
    mw({ user: { id: 'u1' } }, res, () => {});
    const retry = Number(res.state.headers['Retry-After']);
    assert.ok(retry > 0 && Number.isInteger(retry));
  });

  it('forwards caps argument to checkAllowed', () => {
    record('u1', { tokens: 200 });
    let nextCalled = false;
    const res = mockRes();
    const mw = budgetMiddleware({ daily: 100 });
    mw({ user: { id: 'u1' } }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.state.statusCode, 429);
  });
});

// ── _reset ─────────────────────────────────────────────────────

describe('_reset', () => {
  it('clears all per-user ledgers', () => {
    record('u1', { tokens: 100 });
    record('u2', { tokens: 200 });
    _reset();
    assert.equal(getUsage('u1').hourTokens, 0);
    assert.equal(getUsage('u2').hourTokens, 0);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/agents/budget');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, [
      'DAILY_TOKENS',
      'HOURLY_TOKENS',
      'MAX_LEDGER_USERS',
      'MAX_RPM_LOG_ENTRIES',
      'MAX_USER_ID_LENGTH',
      'RPM',
      '_reset',
      'budgetMiddleware',
      'checkAllowed',
      'getUsage',
      'record',
    ]);
  });
});
