/**
 * Tests for computer-use-safety.js — middleware for the /api/agent/
 * computer-use route family.
 *
 * Pieces under test:
 *   1. computerUseSafetyCheck — body validation + harmful-keyword
 *      filter + 500-char cap.
 *   2. computerUseRateLimiter — in-memory 5-req-per-minute limiter.
 *   3. cleanupExpiredSessions — best-effort sweep (must not throw
 *      when routes/computer-use is unavailable).
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

// Mute the module's console logs (it logs at "cleanup" boundaries).
const _origLog = console.log;
const _origError = console.error;
function muteLog() {
  console.log = () => {};
  console.error = () => {};
}
function restoreLog() {
  console.log = _origLog;
  console.error = _origError;
}

muteLog();
const {
  computerUseSafetyCheck,
  computerUseRateLimiter,
  cleanupExpiredSessions,
} = require('../src/middleware/computer-use-safety');
restoreLog();

function mockRes() {
  const state = { statusCode: 200, body: null, headers: {} };
  return {
    state,
    status(code) { state.statusCode = code; return this; },
    json(obj) { state.body = obj; return this; },
    setHeader(k, v) { state.headers[k] = v; },
  };
}

// Helper to call a middleware synchronously (these aren't async).
function runMiddleware(mw, req) {
  const res = mockRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

// ─── computerUseSafetyCheck ───────────────────────────────────────

describe('computerUseSafetyCheck · body validation', () => {
  it('rejects when body has no task', () => {
    const { res, nextCalled } = runMiddleware(computerUseSafetyCheck, { body: {} });
    assert.equal(res.state.statusCode, 400);
    assert.equal(res.state.body.success, false);
    assert.match(res.state.body.error, /required/);
    assert.equal(nextCalled, false);
  });

  it('rejects when task is the empty string', () => {
    const { res, nextCalled } = runMiddleware(computerUseSafetyCheck, { body: { task: '' } });
    assert.equal(res.state.statusCode, 400);
    assert.equal(nextCalled, false);
  });

  it('calls next() on a clean task', () => {
    const { nextCalled } = runMiddleware(computerUseSafetyCheck, {
      body: { task: 'summarize the news headlines for me' },
    });
    assert.equal(nextCalled, true);
  });

  it('rejects task longer than 500 chars', () => {
    const long = 'a'.repeat(501);
    const { res, nextCalled } = runMiddleware(computerUseSafetyCheck, { body: { task: long } });
    assert.equal(res.state.statusCode, 400);
    assert.match(res.state.body.error, /too long/);
    assert.equal(nextCalled, false);
  });

  it('accepts task of exactly 500 chars', () => {
    const exact = 'a'.repeat(500);
    const { nextCalled } = runMiddleware(computerUseSafetyCheck, { body: { task: exact } });
    assert.equal(nextCalled, true);
  });
});

describe('computerUseSafetyCheck · harmful-keyword filter', () => {
  const harmful = [
    'delete', 'remove', 'format', 'destroy', 'hack', 'crack', 'password',
    'personal information', 'credit card', 'bank account', 'social security',
    'captcha', 'checkout', 'place order', 'send email', 'post tweet', 'login',
    'comprar', 'pagar', 'transferir dinero', 'enviar correo', 'publicar',
    'iniciar sesión',
  ];

  for (const kw of harmful) {
    it(`rejects a task containing "${kw}"`, () => {
      const { res, nextCalled } = runMiddleware(computerUseSafetyCheck, {
        body: { task: `please ${kw} this file` },
      });
      assert.equal(res.state.statusCode, 403);
      assert.equal(res.state.body.safetyViolation, true);
      assert.equal(nextCalled, false);
    });
  }

  it('keyword match is case-insensitive', () => {
    const { res, nextCalled } = runMiddleware(computerUseSafetyCheck, {
      body: { task: 'PLEASE DELETE THIS' },
    });
    assert.equal(res.state.statusCode, 403);
    assert.equal(nextCalled, false);
  });

  it('keyword match is substring-based (not word-boundary)', () => {
    // "renounce" contains "remove"... actually no it doesn't. But
    // "Removeable" does contain "remove". Pin the substring behavior.
    const { res, nextCalled } = runMiddleware(computerUseSafetyCheck, {
      body: { task: 'check the removeable media folder' },
    });
    assert.equal(res.state.statusCode, 403);
    assert.equal(nextCalled, false);
  });

  it('clean tasks pass even when they contain harmless substrings', () => {
    // "card" alone is NOT in the harmful list — "credit card" is the
    // two-word phrase. Verify that "trump card" passes.
    const { nextCalled } = runMiddleware(computerUseSafetyCheck, {
      body: { task: 'mention trump card in the analysis' },
    });
    assert.equal(nextCalled, true);
  });
});

// ─── computerUseRateLimiter ────────────────────────────────────────

describe('computerUseRateLimiter', () => {
  // Each test uses a unique IP so the module-level state map doesn't
  // bleed between tests.
  let counter = 0;
  function uniqueIp() {
    counter += 1;
    return `10.10.${Math.floor(counter / 250)}.${counter % 250}`;
  }

  it('lets the first request from a new IP pass', () => {
    const { nextCalled, res } = runMiddleware(computerUseRateLimiter, { ip: uniqueIp() });
    assert.equal(nextCalled, true);
    assert.equal(res.state.statusCode, 200);
  });

  it('lets up to 5 requests in a single window', () => {
    const ip = uniqueIp();
    for (let i = 0; i < 5; i++) {
      const { nextCalled } = runMiddleware(computerUseRateLimiter, { ip });
      assert.equal(nextCalled, true, `request ${i + 1} blocked unexpectedly`);
    }
  });

  it('blocks the 6th request in a window with 429', () => {
    const ip = uniqueIp();
    for (let i = 0; i < 5; i++) {
      runMiddleware(computerUseRateLimiter, { ip });
    }
    const { res, nextCalled } = runMiddleware(computerUseRateLimiter, { ip });
    assert.equal(res.state.statusCode, 429);
    assert.equal(res.state.body.success, false);
    assert.equal(nextCalled, false);
    assert.ok(typeof res.state.body.retryAfter === 'number');
    assert.ok(res.state.body.retryAfter > 0);
  });

  it('falls back to req.connection.remoteAddress when req.ip absent', () => {
    const req = { connection: { remoteAddress: uniqueIp() } };
    const { nextCalled } = runMiddleware(computerUseRateLimiter, req);
    assert.equal(nextCalled, true);
  });
});

// ─── cleanupExpiredSessions ────────────────────────────────────────

describe('cleanupExpiredSessions', () => {
  it('does not throw when activeSessions is unavailable', () => {
    // This is the path taken in tests where routes/computer-use may
    // never have been required (or its activeSessions Map is missing).
    // The function logs and returns; should not propagate.
    muteLog();
    assert.doesNotThrow(() => cleanupExpiredSessions());
    restoreLog();
  });

  it('handles a thrown require() error gracefully', () => {
    // The require('../routes/computer-use') itself may throw if the
    // module has a side-effect bug. The middleware swallows that.
    muteLog();
    let threw = null;
    try {
      cleanupExpiredSessions();
    } catch (e) {
      threw = e;
    }
    restoreLog();
    assert.equal(threw, null);
  });
});

// ─── module surface ───────────────────────────────────────────────

describe('module exports', () => {
  it('exports exactly the documented surface', () => {
    const exports_ = require('../src/middleware/computer-use-safety');
    const keys = Object.keys(exports_).sort();
    assert.deepEqual(keys, [
      'cleanupExpiredSessions',
      'computerUseRateLimiter',
      'computerUseSafetyCheck',
    ]);
  });
});
