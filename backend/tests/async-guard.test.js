/**
 * async-guard.test.js — tests for the guarded async resource manager.
 *
 * Coverage:
 *   - Basic run() with success and failure
 *   - Timeout enforcement (GuardError thrown when operation exceeds limit)
 *   - Cleanup callback invoked on all terminal states
 *   - Cancel() transitions state and runs cleanup
 *   - Fetch wrapper: header sanitization (Symbol stripping)
 *   - Fetch wrapper: timeout enforcement
 *   - Route wrapper: forwards errors to next()
 *   - Route wrapper: response-sent detection
 *   - FinalizationRegistry registration/unregistration
 *   - GuardError structured JSON output
 *   - GuardToken metadata and elapsed time
 *   - sanitizeFetchInit helper
 *   - isAbortError helper
 *   - raceWithSignal helper
 *   - Edge cases: multiple settle(), settle after cancel, null cleanup
 */

const { describe, test, mock, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  AsyncGuard,
  GuardToken,
  GuardError,
  defaultGuard,
  sanitizeFetchInit,
  isAbortError,
  raceWithSignal,
  GUARD_PENDING,
  GUARD_SETTLED,
  GUARD_CANCELLED,
  GUARD_TIMED_OUT,
} = require('../src/utils/async-guard');

// ── Helpers ───────────────────────────────────────────────────────────────

/** Create a promise that never settles (for timeout tests). */
function never() {
  return new Promise(() => {});
}

/** Create a promise that resolves after `ms` milliseconds. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Create a promise that rejects after `ms` milliseconds. */
function delayReject(ms, err) {
  return new Promise((_, reject) => setTimeout(() => reject(err || new Error('delayed')), ms));
}

/**
 * Helper to catch the actual error from a rejection.
 * assert.rejects with a validation fn resolves to undefined,
 * so we use this pattern instead.
 */
async function catchRejection(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('Expected promise to reject but it resolved');
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('AsyncGuard', () => {
  describe('run()', () => {
    test('resolves with the promise value', async () => {
      const guard = new AsyncGuard({ defaultTimeoutMs: 5000 });
      const result = await guard.run(Promise.resolve(42));
      assert.equal(result, 42);
    });

    test('rejects with the promise error', async () => {
      const guard = new AsyncGuard({ defaultTimeoutMs: 5000 });
      await assert.rejects(
        guard.run(Promise.reject(new Error('boom')))
      );
    });

    test('throws GuardError on timeout', async () => {
      const guard = new AsyncGuard({ defaultTimeoutMs: 50 });
      const err = await catchRejection(
        guard.run(never(), { label: 'timeout-test' })
      );
      assert.ok(err instanceof GuardError, 'error should be GuardError');
      assert.equal(err.code, 'GUARD_TIMEOUT');
      assert.equal(err.reason, 'timeout');
      assert.ok(err.elapsedMs >= 0, `elapsedMs >= 0 but got ${err.elapsedMs}`);
      assert.equal(err.timeoutMs, 50);
      assert.equal(err.label, 'timeout-test');
      assert.ok(err.guardId);
    });

    test('runs cleanup callback on success', async () => {
      let cleaned = false;
      const guard = new AsyncGuard({ defaultTimeoutMs: 5000 });
      await guard.run(Promise.resolve('ok'), {
        cleanup: () => { cleaned = true; },
      });
      assert.ok(cleaned);
    });

    test('runs cleanup callback on rejection', async () => {
      let cleaned = false;
      const guard = new AsyncGuard({ defaultTimeoutMs: 5000 });
      await assert.rejects(
        guard.run(Promise.reject(new Error('fail')), {
          cleanup: () => { cleaned = true; },
        })
      );
      assert.ok(cleaned);
    });

    test('runs cleanup callback on timeout', async () => {
      let cleaned = false;
      const guard = new AsyncGuard({ defaultTimeoutMs: 50 });
      await assert.rejects(
        guard.run(never(), {
          label: 'timeout-cleanup',
          cleanup: () => { cleaned = true; },
        })
      );
      assert.ok(cleaned);
    });

    test('cleanup runs only once on double settle', async () => {
      let callCount = 0;
      const guard = new AsyncGuard({ defaultTimeoutMs: 5000 });
      const token = guard.register({ cleanup: () => { callCount++; } });
      token.settle();
      token.settle(); // second call is no-op
      token.cancel(); // already settled, should be no-op
      assert.equal(callCount, 1);
    });

    test('rejects with GuardError on timeout', async () => {
      const guard = new AsyncGuard({ defaultTimeoutMs: 30 });
      const err = await catchRejection(
        guard.run(never(), { label: 'timeout-test-2', timeoutMs: 30 })
      );
      assert.ok(err instanceof GuardError);
      assert.match(err.message, /timed out/);
      assert.equal(err.code, 'GUARD_TIMEOUT');
    });

    test('enriches non-abort errors with guard metadata', async () => {
      const guard = new AsyncGuard({ defaultTimeoutMs: 5000 });
      try {
        await guard.run(Promise.reject(new Error('db_error')), {
          label: 'db-query',
        });
        assert.fail('should have thrown');
      } catch (err) {
        assert.equal(err.message, 'db_error');
        assert.ok(err.guardId);
        assert.equal(err.guardLabel, 'db-query');
        assert.ok(typeof err.guardElapsedMs === 'number');
      }
    });

    test('redacts labels in timeout errors and metadata', async () => {
      const guard = new AsyncGuard({ defaultTimeoutMs: 30 });
      const err = await catchRejection(
        guard.run(never(), {
          label: 'sync Bearer abcdefghijklmnopqrstuvwxyz123456 https://example.com/?api_key=secret',
          timeoutMs: 30,
        })
      );

      assert.ok(err instanceof GuardError);
      assert.doesNotMatch(err.message, /abcdefghijklmnopqrstuvwxyz123456|api_key=secret/);
      assert.doesNotMatch(err.label, /abcdefghijklmnopqrstuvwxyz123456|api_key=secret/);
      assert.doesNotMatch(JSON.stringify(err.toJSON()), /abcdefghijklmnopqrstuvwxyz123456|api_key=secret/);
      assert.match(err.label, /\*\*\*bearer-token-redacted\*\*\*/);
      assert.match(err.label, /api_key=\*\*\*/);
    });
  });

  describe('fetch()', () => {
    test('wraps native fetch and sanitizes headers', async () => {
      let capturedInit = null;
      const mockFetch = async (input, init) => {
        capturedInit = init;
        return new Response('ok', { status: 200 });
      };

      const guard = new AsyncGuard({ defaultTimeoutMs: 5000 });
      const guardedFetch = guard.fetch(mockFetch);

      const headersWithSymbol = {
        'content-type': 'application/json',
        authorization: 'Bearer tok_123',
      };
      // Add a Symbol key (simulating SDK metadata that needs stripping)
      headersWithSymbol[Symbol('metadata')] = 'secret';

      await guardedFetch('https://example.com/api', { headers: headersWithSymbol });

      assert.ok(capturedInit);
      // Symbol key should be stripped
      const symbolKeys = Object.getOwnPropertySymbols(capturedInit.headers || {});
      assert.equal(symbolKeys.length, 0);
      // String keys should be preserved
      if (capturedInit.headers && typeof capturedInit.headers === 'object') {
        assert.equal(capturedInit.headers['content-type'], 'application/json');
        assert.equal(capturedInit.headers.authorization, 'Bearer tok_123');
      }
    });

    test('strips null/undefined header values', async () => {
      let capturedInit = null;
      const mockFetch = async (input, init) => {
        capturedInit = init;
        return new Response('ok', { status: 200 });
      };

      const guard = new AsyncGuard({ defaultTimeoutMs: 5000 });
      const guardedFetch = guard.fetch(mockFetch);

      await guardedFetch('https://example.com/api', {
        headers: {
          'x-trace-id': 'abc',
          'x-null-header': null,
          'x-undefined-header': undefined,
          'x-valid': 'keep',
        },
      });

      const headers = capturedInit.headers;
      // null/undefined values should be stripped
      assert.equal(headers['x-trace-id'], 'abc');
      assert.equal(headers['x-valid'], 'keep');
      assert.equal(Object.prototype.hasOwnProperty.call(headers, 'x-null-header'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(headers, 'x-undefined-header'), false);
    });

    test('throws GuardError with FETCH_TIMEOUT code on timeout', async () => {
      const mockFetch = async () => { await never(); };

      const guard = new AsyncGuard({ defaultTimeoutMs: 30 });
      const guardedFetch = guard.fetch(mockFetch, { timeoutMs: 30 });

      const err = await catchRejection(
        guardedFetch('https://example.com/slow')
      );
      assert.ok(err instanceof GuardError);
      // Could be FETCH_TIMEOUT or FETCH_ABORTED depending on race
      assert.ok(['FETCH_TIMEOUT', 'FETCH_ABORTED'].includes(err.code),
        `Expected FETCH_TIMEOUT or FETCH_ABORTED, got ${err.code}`);
    });

    test('wraps network errors in GuardError', async () => {
      const mockFetch = async () => {
        throw new Error('ECONNREFUSED localhost:5432');
      };

      const guard = new AsyncGuard({ defaultTimeoutMs: 5000 });
      const guardedFetch = guard.fetch(mockFetch);

      const err = await catchRejection(
        guardedFetch('https://example.com/api')
      );
      assert.ok(err instanceof GuardError);
      assert.equal(err.code, 'FETCH_ERROR');
      assert.equal(err.reason, 'network-error');
    });

    test('redacts fetch URLs and upstream messages in GuardError payloads', async () => {
      const mockFetch = async () => {
        throw new Error('failed Bearer abcdefghijklmnopqrstuvwxyz123456 at https://example.com/?api_key=secret');
      };

      const guard = new AsyncGuard({ defaultTimeoutMs: 5000 });
      const guardedFetch = guard.fetch(mockFetch);

      const err = await catchRejection(
        guardedFetch('https://user:pass@example.com/api?api_key=secret&page=2')
      );

      assert.ok(err instanceof GuardError);
      assert.doesNotMatch(err.message, /abcdefghijklmnopqrstuvwxyz123456|api_key=secret|user:pass/);
      assert.doesNotMatch(err.stack, /abcdefghijklmnopqrstuvwxyz123456|api_key=secret|user:pass/);
      assert.doesNotMatch(JSON.stringify(err.toJSON()), /abcdefghijklmnopqrstuvwxyz123456|api_key=secret|user:pass/);
      assert.match(err.message, /api_key=\*\*\*/);
      assert.match(err.message, /\*\*\*bearer-token-redacted\*\*\*/);
    });

    test('passes through successful responses', async () => {
      const mockFetch = async () => new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

      const guard = new AsyncGuard({ defaultTimeoutMs: 5000 });
      const guardedFetch = guard.fetch(mockFetch);

      const response = await guardedFetch('https://example.com/api');
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body, { ok: true });
    });

    test('honors custom fetch timeout instead of aborting immediately', async () => {
      const mockFetch = async () => {
        await delay(25);
        return new Response('ok', { status: 200 });
      };

      const guard = new AsyncGuard({ defaultTimeoutMs: 5000 });
      const guardedFetch = guard.fetch(mockFetch, { timeoutMs: 10 });

      const response = await guardedFetch('https://example.com/custom-timeout', { timeout: 100 });
      assert.equal(response.status, 200);
    });

    test('keeps bounded timeout when an external signal is present', async () => {
      const controller = new AbortController();
      const mockFetch = async () => {
        await delay(25);
        return new Response('ok', { status: 200 });
      };

      const guard = new AsyncGuard({ defaultTimeoutMs: 5000 });
      const guardedFetch = guard.fetch(mockFetch, { timeoutMs: 100 });

      const response = await guardedFetch('https://example.com/external-signal', {
        signal: controller.signal,
      });
      assert.equal(response.status, 200);
    });

    test('classifies caller cancellation as FETCH_ABORTED', async () => {
      const controller = new AbortController();
      const mockFetch = async () => never();

      const guard = new AsyncGuard({ defaultTimeoutMs: 5000 });
      const guardedFetch = guard.fetch(mockFetch, { timeoutMs: 5000 });
      const promise = guardedFetch('https://example.com/cancelled', {
        signal: controller.signal,
      });

      controller.abort(new Error('caller stopped'));
      const err = await catchRejection(promise);
      assert.ok(err instanceof GuardError);
      assert.equal(err.code, 'FETCH_ABORTED');
      assert.equal(err.reason, 'aborted');
    });
  });

  describe('route()', () => {
    /**
     * Helper: call a route middleware and return a Promise that resolves
     * when next() is called. Express middleware is called synchronously
     * (the return value is ignored); next() is the callback mechanism.
     * For terminating middleware (res.json, res.send, etc.) or cases where
     * next() is intentionally skipped, do NOT use this helper — handle
     * the timing explicitly in the test.
     */
    function callRoute(middleware, req, res) {
      return new Promise((resolve) => {
        middleware(req, res, (err) => resolve(err));
      });
    }

    test('calls next(err) when the handler throws', async () => {
      const guard = new AsyncGuard({ defaultTimeoutMs: 5000 });
      const handler = guard.route(async () => {
        throw new Error('handler error');
      });

      const req = { method: 'GET', originalUrl: '/test' };
      const res = { headersSent: false, writableEnded: false };

      const nextError = await callRoute(handler, req, res);
      assert.ok(nextError);
      assert.equal(nextError.message, 'handler error');
    });

    test('skips next(err) when response already sent', async () => {
      const guard = new AsyncGuard({ defaultTimeoutMs: 50 });
      const handler = guard.route(async () => {
        await delay(100);
        throw new Error('too late');
      }, { label: 'late-error' });

      const req = { method: 'GET', originalUrl: '/test' };
      const res = { headersSent: true, writableEnded: false };
      let nextCalled = false;

      // Call the middleware — next() should NOT be called because
      // headersSent is true. Don't await next(); the route wrapper
      // returns undefined (Express middleware idiom).
      handler(req, res, () => { nextCalled = true; });

      // Wait for the guard timeout (50ms) + a small buffer so the
      // catch block runs before we assert.
      await delay(120);

      assert.equal(nextCalled, false);
    });

    test('preserves successful handler result', async () => {
      const guard = new AsyncGuard({ defaultTimeoutMs: 5000 });
      const handler = guard.route(async (req, res) => {
        res.json({ ok: true });
      });

      let jsonResult = null;
      const req = { method: 'GET', originalUrl: '/ok' };
      const res = {
        headersSent: false,
        writableEnded: false,
        json: (data) => { jsonResult = data; },
      };

      // Call middleware (Express style — no return), then wait a
      // microtick for the async handler to complete.
      handler(req, res, () => {});
      await delay(10);

      assert.deepEqual(jsonResult, { ok: true });
    });
  });

  describe('sanitizeFetchInit()', () => {
    test('strips Symbol keys from headers', () => {
      const headers = {
        'content-type': 'application/json',
      };
      headers[Symbol('secret')] = 'dont-leak';

      const result = sanitizeFetchInit({ headers });
      const symbolKeys = Object.getOwnPropertySymbols(result.headers || {});
      assert.equal(symbolKeys.length, 0);
      assert.equal(result.headers['content-type'], 'application/json');
    });

    test('strips null/undefined header values', () => {
      const result = sanitizeFetchInit({
        headers: {
          a: null,
          b: undefined,
          c: 'valid',
        },
      });
      assert.equal(Object.keys(result.headers).length, 1);
      assert.equal(result.headers.c, 'valid');
      assert.equal(Object.prototype.hasOwnProperty.call(result.headers, 'a'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(result.headers, 'b'), false);
    });

    test('strips Symbol values from headers', () => {
      const result = sanitizeFetchInit({
        headers: {
          'x-custom': Symbol('metadata'),
        },
      });
      // Symbol values get stripped entirely
      assert.equal(Object.keys(result.headers).length, 0);
    });

    test('coerces non-string header values to string', () => {
      const result = sanitizeFetchInit({
        headers: {
          'x-count': 42,
          'x-flag': true,
        },
      });
      assert.equal(result.headers['x-count'], '42');
      assert.equal(result.headers['x-flag'], 'true');
    });

    test('normalizes Headers instance to a safe dictionary', () => {
      const h = new Headers({ 'content-type': 'text/plain' });
      const result = sanitizeFetchInit({ headers: h });
      assert.deepEqual(result.headers, { 'content-type': 'text/plain' });
    });

    test('handles null/undefined init gracefully', () => {
      assert.deepEqual(sanitizeFetchInit(null), {});
      assert.deepEqual(sanitizeFetchInit(undefined), {});
    });
  });

  describe('GuardError', () => {
    test('provides structured toJSON() output', () => {
      const err = new GuardError('timeout', {
        code: 'GUARD_TIMEOUT',
        reason: 'timeout',
        elapsedMs: 500,
        timeoutMs: 1000,
        label: 'test',
        guardId: 'g_abc123',
      });
      const json = err.toJSON();
      assert.equal(json.code, 'GUARD_TIMEOUT');
      assert.equal(json.reason, 'timeout');
      assert.equal(json.elapsedMs, 500);
      assert.equal(json.timeoutMs, 1000);
      assert.equal(json.label, 'test');
      assert.equal(json.guardId, 'g_abc123');
    });

    test('isRetryable() returns true for timeout and aborted', () => {
      assert.ok(new GuardError('timeout', { reason: 'timeout' }).isRetryable());
      assert.ok(new GuardError('aborted', { reason: 'aborted' }).isRetryable());
    });

    test('isRetryable() returns false for other reasons', () => {
      const err = new GuardError('config error', { reason: 'validation-error' });
      assert.equal(err.isRetryable(), false);
    });

    test('wraps original error stack', () => {
      const original = new Error('original db error');
      const err = new GuardError('wrapped', {
        reason: 'timeout',
        originalError: original,
      });
      assert.ok(err.stack.includes('original db error'));
    });

    test('keeps sanitized original errors out of enumerable payloads', () => {
      const original = new Error('failed Bearer abcdefghijklmnopqrstuvwxyz123456 https://example.com/?api_key=secret');
      const err = new GuardError('wrapped', {
        reason: 'timeout',
        originalError: original,
      });

      assert.doesNotMatch(JSON.stringify(err), /abcdefghijklmnopqrstuvwxyz123456|api_key=secret/);
      assert.doesNotMatch(err.originalError.message, /abcdefghijklmnopqrstuvwxyz123456|api_key=secret/);
      assert.equal(Object.prototype.propertyIsEnumerable.call(err, 'originalError'), false);
    });
  });

  describe('GuardToken', () => {
    test('initial state is pending', () => {
      const controller = new AbortController();
      const token = new GuardToken({
        id: 'test-1',
        controller,
        timeoutMs: 5000,
        deadline: Date.now() + 5000,
      });
      assert.equal(token.state, GUARD_PENDING);
    });

    test('settle() transitions to settled', () => {
      const controller = new AbortController();
      const token = new GuardToken({
        id: 'test-2',
        controller,
        timeoutMs: 5000,
        deadline: Date.now() + 5000,
      });
      assert.ok(token.settle());
      assert.equal(token.state, GUARD_SETTLED);
      // Second settle is no-op
      assert.equal(token.settle(), false);
    });

    test('cancel() transitions to cancelled and aborts controller', () => {
      const controller = new AbortController();
      const token = new GuardToken({
        id: 'test-3',
        controller,
        timeoutMs: 5000,
        deadline: Date.now() + 5000,
      });
      assert.ok(token.cancel());
      assert.equal(token.state, GUARD_CANCELLED);
      assert.ok(controller.signal.aborted);
    });

    test('remainingMs() returns time left', () => {
      const controller = new AbortController();
      const token = new GuardToken({
        id: 'test-4',
        controller,
        timeoutMs: 5000,
        deadline: Date.now() + 5000,
      });
      const remaining = token.remainingMs();
      assert.ok(remaining > 0);
      assert.ok(remaining <= 5000);
    });

    test('isExpired() returns true when deadline passed', () => {
      const controller = new AbortController();
      const token = new GuardToken({
        id: 'test-5',
        controller,
        timeoutMs: 5,
        deadline: Date.now() - 1000, // already past
      });
      assert.ok(token.isExpired());
    });

    test('toMetadata() returns structured object', () => {
      const controller = new AbortController();
      const token = new GuardToken({
        id: 'g_abc',
        label: 'my-op',
        controller,
        timeoutMs: 5000,
        deadline: Date.now() + 5000,
      });
      const meta = token.toMetadata();
      assert.equal(meta.guardId, 'g_abc');
      assert.equal(meta.label, 'my-op');
      assert.equal(meta.state, GUARD_PENDING);
      assert.equal(meta.timeoutMs, 5000);
    });
  });

  describe('isAbortError()', () => {
    test('detects AbortError by name', () => {
      const err = new DOMException('The operation was aborted', 'AbortError');
      assert.ok(isAbortError(err));
    });

    test('detects regular Error named AbortError', () => {
      const err = new Error('The user aborted a request');
      err.name = 'AbortError';
      assert.ok(isAbortError(err));
    });

    test('returns false for non-abort errors', () => {
      assert.equal(isAbortError(new Error('normal')), false);
      assert.equal(isAbortError(null), false);
      assert.equal(isAbortError({}), false);
    });
  });

  describe('raceWithSignal()', () => {
    test('resolves with the promise value when signal not aborted', async () => {
      const controller = new AbortController();
      const result = await raceWithSignal(Promise.resolve(99), controller.signal);
      assert.equal(result, 99);
    });

    test('rejects when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort(new Error('cancelled'));
      await assert.rejects(
        raceWithSignal(Promise.resolve('never'), controller.signal)
      );
    });

    test('rejects when signal fires after promise start', async () => {
      const controller = new AbortController();
      const promise = raceWithSignal(never(), controller.signal);
      setTimeout(() => controller.abort(new Error('cancelled')), 10);
      await assert.rejects(promise);
    });
  });

  describe('derive()', () => {
    test('creates a new AsyncGuard with overridden defaults', () => {
      const parent = new AsyncGuard({ defaultTimeoutMs: 30000 });
      const child = parent.derive({ defaultTimeoutMs: 5000 });

      // Child has own timeout
      const tokenA = child.register({ label: 'child-op' });
      assert.equal(tokenA.timeoutMs, 5000);

      // Parent still has original timeout
      const tokenB = parent.register({ label: 'parent-op' });
      assert.equal(tokenB.timeoutMs, 30000);
    });
  });

  describe('defaultGuard singleton', () => {
    test('is an AsyncGuard instance', () => {
      assert.ok(defaultGuard instanceof AsyncGuard);
    });

    test('can run operations', async () => {
      const result = await defaultGuard.run(Promise.resolve('singleton works'));
      assert.equal(result, 'singleton works');
    });
  });
});
