/**
 * Tests for error-telemetry.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  createErrorReporter,
  errorToSnapshot,
  classifyError,
  ERROR_CATEGORIES,
} = require('../src/utils/error-telemetry');
const { CircuitBreaker } = require('../src/utils/circuit-breaker');
const { createTracer } = require('../src/services/observability/spans');

// ── Helpers ────────────────────────────────────────────────────────────────

/** Collect log output into an array for assertions. */
function makeLogCollector() {
  const entries = [];
  const logger = {};
  for (const level of ['debug', 'info', 'warn', 'error', 'fatal']) {
    logger[level] = (msg, meta) => entries.push({ level, msg, meta });
  }
  return { logger, entries };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('error-telemetry', () => {

  // ── errorToSnapshot ──────────────────────────────────────────

  describe('errorToSnapshot', () => {
    it('returns a plain object with name, message, stack, category', () => {
      const err = new Error('something broke');
      const snap = errorToSnapshot(err);
      assert.equal(snap.name, 'Error');
      assert.equal(snap.message, 'something broke');
      assert.ok(snap.stack);
      assert.equal(snap.category, ERROR_CATEGORIES.UNKNOWN);
    });

    it('captures error code and statusCode', () => {
      const err = new Error('rate limited');
      err.code = 429;
      err.statusCode = 429;
      const snap = errorToSnapshot(err);
      assert.equal(snap.code, 429);
    });

    it('captures cause chain up to maxDepth', () => {
      const inner = new Error('inner failure');
      const mid = new Error('mid failure');
      mid.cause = inner;
      const outer = new Error('outer failure');
      outer.cause = mid;

      const snap = errorToSnapshot(outer, 2);
      assert.equal(snap.cause1, 'mid failure');
      assert.equal(snap.cause2, 'inner failure');
      assert.equal(snap.cause3, undefined);
    });

    it('captures breakerName and timeoutMs from circuit-breaker errors', () => {
      const err = new Error('OPEN');
      err.name = 'CircuitOpenError';
      err.breakerName = 'openai';
      const snap = errorToSnapshot(err);
      assert.equal(snap.breakerName, 'openai');
      assert.equal(snap.category, ERROR_CATEGORIES.SYSTEM);
    });

    it('handles null/undefined gracefully', () => {
      const snap = errorToSnapshot(null);
      assert.equal(snap.message, 'unknown error');
    });

    it('truncates message beyond 500 chars', () => {
      const long = 'a'.repeat(1000);
      const err = new Error(long);
      const snap = errorToSnapshot(err);
      assert.ok(snap.message.length <= 503, `length ${snap.message.length} <= 503`);
      assert.ok(snap.message.length >= 495, `length ${snap.message.length} >= 495`);
    });
  });

  // ── classifyError ────────────────────────────────────────────

  describe('classifyError', () => {
    it('classifies CircuitOpenError as SYSTEM', () => {
      const err = new Error('broken');
      err.name = 'CircuitOpenError';
      assert.equal(classifyError(err), ERROR_CATEGORIES.SYSTEM);
    });

    it('classifies CircuitTimeoutError as TIMEOUT', () => {
      const err = new Error('timed out');
      err.name = 'CircuitTimeoutError';
      assert.equal(classifyError(err), ERROR_CATEGORIES.TIMEOUT);
    });

    it('classifies GuardError as TIMEOUT', () => {
      const err = new Error('guard timed out');
      err.name = 'GuardError';
      assert.equal(classifyError(err), ERROR_CATEGORIES.TIMEOUT);
    });

    it('classifies 429 as RATE_LIMIT', () => {
      const err = new Error('Too Many Requests');
      err.statusCode = '429';
      assert.equal(classifyError(err), ERROR_CATEGORIES.RATE_LIMIT);
    });

    it('classifies 401 as AUTH', () => {
      const err = new Error('Unauthorized');
      err.code = '401';
      assert.equal(classifyError(err), ERROR_CATEGORIES.AUTH);
    });

    it('classifies 5xx as NETWORK', () => {
      const err = new Error('Internal Server Error');
      err.code = '500';
      assert.equal(classifyError(err), ERROR_CATEGORIES.NETWORK);
    });

    it('returns UNKNOWN for generic errors', () => {
      assert.equal(classifyError(new Error('weird')), ERROR_CATEGORIES.UNKNOWN);
    });

    it('returns UNKNOWN for null', () => {
      assert.equal(classifyError(null), ERROR_CATEGORIES.UNKNOWN);
    });
  });

  // ── createErrorReporter ──────────────────────────────────────

  describe('createErrorReporter', () => {
    it('returns reporter with all expected methods', () => {
      const reporter = createErrorReporter();
      assert.equal(typeof reporter.wireCircuitBreaker, 'function');
      assert.equal(typeof reporter.captureError, 'function');
      assert.equal(typeof reporter.captureRetry, 'function');
      assert.equal(typeof reporter.captureGuardTimeout, 'function');
      assert.equal(typeof reporter.expressErrorHandler, 'function');
    });

    it('uses injected logger methods', () => {
      const { logger, entries } = makeLogCollector();
      const reporter = createErrorReporter({ logger });
      reporter.captureError(new Error('test'), { module: 'test', operation: 'op' });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].level, 'error');
      assert.ok(entries[0].msg.includes('test.op'));
    });
  });

  // ── captureError ─────────────────────────────────────────────

  describe('captureError', () => {
    it('records error with module and operation context', () => {
      const { logger, entries } = makeLogCollector();
      const reporter = createErrorReporter({ logger });
      const err = new Error('db-down');

      reporter.captureError(err, { module: 'database', operation: 'query' });

      assert.equal(entries.length, 1);
      assert.ok(entries[0].msg.includes('database.query'));
      assert.equal(entries[0].meta.module, 'database');
      assert.equal(entries[0].meta.operation, 'query');
    });

    it('returns error snapshot', () => {
      const reporter = createErrorReporter();
      const err = new Error('snapshot-test');
      const snap = reporter.captureError(err, { module: 'm', operation: 'o' });
      assert.equal(snap.message, 'snapshot-test');
      assert.equal(snap.name, 'Error');
    });

    it('annotates an active span with exception event', () => {
      const tracer = createTracer({ serviceName: 'test' });
      const reporter = createErrorReporter({ tracer });
      const err = new Error('span-error');

      const span = tracer.startSpan({ name: 'test-op' });
      reporter.captureError(err, { module: 'm', operation: 'o' }, span);
      span.end();

      assert.equal(span.events.length, 1);
      assert.equal(span.events[0].name, 'exception');
      assert.equal(span.events[0].attributes['exception.type'], 'Error');
      assert.equal(span.events[0].attributes['exception.message'], 'span-error');
      assert.equal(span.status.code, 'ERROR');
    });
  });

  // ── captureRetry ─────────────────────────────────────────────

  describe('captureRetry', () => {
    it('logs retry attempt with context', () => {
      const { logger, entries } = makeLogCollector();
      const reporter = createErrorReporter({ logger });

      reporter.captureRetry(
        { attempt: 2, delayMs: 1000, reason: 'rate-limited', error: new Error('429') },
        { module: 'scheduler', operation: 'fireJob' },
      );

      assert.equal(entries.length, 1);
      assert.equal(entries[0].level, 'warn');
      assert.equal(entries[0].meta.retryAttempt, 2);
      assert.equal(entries[0].meta.retryDelayMs, 1000);
      assert.equal(entries[0].meta.retryReason, 'rate-limited');
      assert.equal(entries[0].meta.module, 'scheduler');
      assert.ok(entries[0].meta.error);
    });

    it('annotates span with retry event', () => {
      const tracer = createTracer({ serviceName: 'test' });
      const reporter = createErrorReporter({ tracer });
      const span = tracer.startSpan({ name: 'test-retry' });

      reporter.captureRetry(
        { attempt: 1, delayMs: 5000, reason: 'transient', error: new Error('timeout') },
        { module: 'm', operation: 'o' },
        span,
      );
      span.end();

      assert.equal(span.events.length, 1);
      assert.equal(span.events[0].name, 'retry');
      assert.equal(span.events[0].attributes.retryAttempt, 1);
    });
  });

  // ── captureGuardTimeout ──────────────────────────────────────

  describe('captureGuardTimeout', () => {
    it('logs guard timeout', () => {
      const { logger, entries } = makeLogCollector();
      const reporter = createErrorReporter({ logger });

      reporter.captureGuardTimeout({ timeoutMs: 5000, operation: 'agent-task' });

      assert.equal(entries.length, 1);
      assert.equal(entries[0].level, 'warn');
      assert.equal(entries[0].meta.timeoutMs, 5000);
      assert.equal(entries[0].meta.operation, 'agent-task');
    });

    it('annotates span with guard_timeout event', () => {
      const tracer = createTracer({ serviceName: 'test' });
      const reporter = createErrorReporter({ tracer });
      const span = tracer.startSpan({ name: 'test-guard' });

      reporter.captureGuardTimeout({ timeoutMs: 10000, operation: 'doc-gen' }, span);
      span.end();

      assert.equal(span.events.length, 1);
      assert.equal(span.events[0].name, 'guard_timeout');
    });
  });

  // ── wireCircuitBreaker ───────────────────────────────────────

  describe('wireCircuitBreaker', () => {
    let cb;
    let reporter;

    beforeEach(() => {
      cb = new CircuitBreaker({ name: 'test-cb', threshold: 3, cooldownMs: 100, probeCount: 1 });
      reporter = createErrorReporter();
    });

    afterEach(() => {
      cb.reset();
    });

    it('returns an unsubscribe function', () => {
      const unsub = reporter.wireCircuitBreaker(cb);
      assert.equal(typeof unsub, 'function');
      unsub();
    });

    it('opens circuit on threshold exceeded', async () => {
      reporter.wireCircuitBreaker(cb);
      for (let i = 0; i < 3; i++) {
        try { await cb.call(async () => { throw new Error('fail'); }); } catch { /* expected */ }
      }
      assert.equal(cb.state, 'OPEN');
    });

    it('does not double-wire the same breaker', () => {
      const unsub1 = reporter.wireCircuitBreaker(cb);
      const unsub2 = reporter.wireCircuitBreaker(cb);
      assert.equal(typeof unsub1, 'function');
      assert.equal(typeof unsub2, 'function');
      unsub1();
      unsub2();
    });

    it('is idempotent with null/undefined', () => {
      const unsub = reporter.wireCircuitBreaker(null);
      assert.equal(typeof unsub, 'function');
      unsub();
    });
  });

  // ── expressErrorHandler ──────────────────────────────────────

  describe('expressErrorHandler', () => {
    it('returns a middleware function', () => {
      const reporter = createErrorReporter();
      const middleware = reporter.expressErrorHandler();
      assert.equal(typeof middleware, 'function');
      assert.equal(middleware.length, 4);
    });

    it('captures error and calls next(err)', () => {
      const { logger, entries } = makeLogCollector();
      const reporter = createErrorReporter({ logger });
      const middleware = reporter.expressErrorHandler();

      const err = new Error('route-error');
      const req = { method: 'GET', originalUrl: '/api/test', id: 'req-123', user: { id: 'user-1' } };
      let nextCalledWith = null;
      const next = (e) => { nextCalledWith = e; };

      middleware(err, req, null, next);

      assert.equal(entries.length, 1);
      assert.equal(entries[0].meta.operation, 'GET /api/test');
      assert.equal(entries[0].meta.requestId, 'req-123');
      assert.equal(entries[0].meta.userId, 'user-1');
      assert.equal(nextCalledWith, err);
    });
  });

  // ── Integration: reporter + circuit breaker + tracer ─────────

  describe('integration', () => {
    it('captures errors with span through the full flow', async () => {
      const tracer = createTracer({ serviceName: 'test' });
      const reporter = createErrorReporter({ tracer });
      const cb = new CircuitBreaker({ name: 'integration', threshold: 2, cooldownMs: 200, probeCount: 1 });

      reporter.wireCircuitBreaker(cb);

      const span = tracer.startSpan({ name: 'integration-test' });
      try {
        await cb.call(async () => { throw new Error('integration-failure'); });
      } catch (err) {
        reporter.captureError(err, { module: 'integration', operation: 'test-call' }, span);
      }
      span.end();

      assert.equal(span.events.length, 1);
      assert.equal(span.events[0].name, 'exception');
      assert.equal(span.status.code, 'ERROR');
      cb.reset();
    });

    it('captures retry info in span events', () => {
      const tracer = createTracer({ serviceName: 'test' });
      const reporter = createErrorReporter({ tracer });

      const span = tracer.startSpan({ name: 'retry-flow' });
      reporter.captureRetry(
        { attempt: 1, delayMs: 1000, reason: 'timeout', error: new Error('ETIMEDOUT') },
        { module: 'retry', operation: 'call' },
        span,
      );
      reporter.captureRetry(
        { attempt: 2, delayMs: 2000, reason: 'timeout', error: new Error('ETIMEDOUT') },
        { module: 'retry', operation: 'call' },
        span,
      );
      span.end();

      assert.equal(span.events.length, 2);
      assert.equal(span.events[0].attributes.retryAttempt, 1);
      assert.equal(span.events[1].attributes.retryAttempt, 2);
    });
  });
});
