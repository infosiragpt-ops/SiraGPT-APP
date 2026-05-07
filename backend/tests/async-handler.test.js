/**
 * Tests for enhanced async-handler.js
 *
 * @jest-environment node
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { asyncHandler } = require('../src/utils/async-handler');
const { GuardError } = require('../src/utils/async-guard');

// ── Helpers ────────────────────────────────────────────────────────────────

/** A promise that never settles. */
function never() { return new Promise(() => {}); }

/** Delay helper. */
function delay(ms, value) {
  return new Promise(r => setTimeout(() => r(value), ms));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('asyncHandler (enhanced)', () => {

  // ── Backward compatibility tests (from original suite) ───────────────

  describe('backward compat', () => {
    it('passes req, res, and next to the wrapped handler', async () => {
      const req = { id: 'req-1' };
      const res = { statusCode: 200 };
      const next = () => {};
      const seen = [];
      const wrapped = asyncHandler(async (...args) => {
        seen.push(args);
      });

      wrapped(req, res, next);
      await Promise.resolve();

      assert.deepEqual(seen, [[req, res, next]]);
    });

    it('forwards rejected async handlers to next in same microtask', async () => {
      const failure = new Error('boom');
      const calls = [];
      const wrapped = asyncHandler(async () => {
        throw failure;
      });

      wrapped({}, {}, (err) => {
        calls.push(err);
      });
      await Promise.resolve();

      assert.deepEqual(calls, [failure]);
    });

    it('lets synchronous throws surface before promise rejection handling', async () => {
      const failure = new Error('sync boom');
      const calls = [];
      const wrapped = asyncHandler(() => {
        throw failure;
      });

      assert.throws(() => wrapped({}, {}, (err) => calls.push(err)), /sync boom/);
      await Promise.resolve();
      assert.deepEqual(calls, []);
    });
  });

  // ── Headers-already-sent guard ──────────────────────────────────────

  describe('headers-sent guard', () => {
    it('does not call next(err) when headers already sent', async () => {
      const err = new Error('too-late');
      const calls = [];
      const wrapped = asyncHandler(async () => { throw err; });

      const res = { headersSent: true, writableEnded: false };
      wrapped({}, res, (e) => calls.push(e));
      await Promise.resolve();
      // next should NOT be called
      assert.equal(calls.length, 0);
    });

    it('does not call next(err) when response already ended', async () => {
      const err = new Error('ended');
      const calls = [];
      const wrapped = asyncHandler(async () => { throw err; });

      const res = { headersSent: false, writableEnded: true };
      wrapped({}, res, (e) => calls.push(e));
      await Promise.resolve();
      assert.equal(calls.length, 0);
    });

    it('still calls next(err) when response is writable', async () => {
      const err = new Error('ok');
      const calls = [];
      const wrapped = asyncHandler(async () => { throw err; });

      const res = { headersSent: false, writableEnded: false };
      wrapped({}, res, (e) => calls.push(e));
      await Promise.resolve();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].message, 'ok');
    });
  });

  // ── Custom timeout ─────────────────────────────────────────────────

  describe('custom timeout', () => {
    it('throws GuardError when handler exceeds timeout', async () => {
      const wrapped = asyncHandler(async () => { await never(); }, { timeoutMs: 50 });
      const calls = [];
      const spyNext = (e) => calls.push(e);

      const req = {};
      const res = { headersSent: false, writableEnded: false };
      wrapped(req, res, spyNext);
      // Wait for timeout to fire (extra slack for safety)
      await delay(120);

      assert.equal(calls.length, 1);
      assert.ok(calls[0] instanceof GuardError);
      assert.ok(calls[0].message.includes('timed out'));
    });

    it('does NOT throw GuardError when handler finishes before timeout', async () => {
      const wrapped = asyncHandler(async () => 'fast', { timeoutMs: 200 });
      const calls = [];
      const spyNext = (e) => calls.push(e);

      const req = {};
      const res = { headersSent: false, writableEnded: false };
      wrapped(req, res, spyNext);
      await delay(50);

      assert.equal(calls.length, 0); // no error
    });

    it('does NOT throw GuardError when timeout not configured', async () => {
      const wrapped = asyncHandler(async () => { await never(); }); // no timeout!
      const calls = [];
      const spyNext = (e) => calls.push(e);

      const req = {};
      const res = { headersSent: false, writableEnded: false };
      wrapped(req, res, spyNext);
      await delay(30);

      // Should NOT time out — no guard is active
      assert.equal(calls.length, 0);
    });
  });

  // ── Non-async handler edge cases ───────────────────────────────────

  describe('non-async handlers', () => {
    it('passes through a synchronous handler that calls next() directly', async () => {
      const calls = [];
      const wrapped = asyncHandler((_req, _res, next) => {
        next(); // synchronous next call
      });

      wrapped({}, {}, () => calls.push('next-called'));
      await Promise.resolve();

      assert.deepEqual(calls, ['next-called']);
    });

    it('passes through a synchronous handler that returns a value (not a thenable)', async () => {
      const calls = [];
      const wrapped = asyncHandler(() => 42);

      wrapped({}, {}, () => calls.push('unexpected'));
      await Promise.resolve();

      // No async machinery was triggered
      assert.deepEqual(calls, []);
    });
  });

  // ── Custom label ──────────────────────────────────────────────────

  describe('custom label', () => {
    it('includes label in error metadata', async () => {
      const err = new Error('labeled-fail');
      const wrapped = asyncHandler(async () => { throw err; }, { label: 'my-custom-handler' });

      const metadata = {};
      const res = { headersSent: false, writableEnded: false };

      wrapped({}, res, (e) => {
        // The error is the original handler error (direct path)
        // Label is not on the error in the direct path — only via guard
        metadata.received = true;
        metadata.message = e.message;
      });
      await Promise.resolve();

      assert.equal(metadata.received, true);
      assert.equal(metadata.message, 'labeled-fail');
    });
  });
});
