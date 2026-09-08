'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const metrics = require('../src/utils/metrics');
const {
  buildPublicStreamError,
  classifyPublicStreamError,
  sanitizePublicStoppedReason,
  sanitizePublicStreamEvent,
} = require('../src/services/observability/public-stream-error');

test('stream errors expose stable diagnostics without leaking provider, token, or filesystem details', () => {
  metrics._reset();
  const secret = 'Bearer sk-prod-secret /opt/siragpt/.env ECONNREFUSED';
  const payload = buildPublicStreamError(new Error(secret), {
    req: { requestId: 'req-safe-123' },
    surface: 'agent.batch',
    traceId: 'trace-safe-456',
  });

  assert.equal(payload.code, 'provider_unavailable');
  assert.equal(payload.retryable, true);
  assert.equal(payload.requestId, 'req-safe-123');
  assert.equal(payload.traceId, 'trace-safe-456');
  assert.doesNotMatch(JSON.stringify(payload), /Bearer|sk-prod-secret|\/opt\/siragpt|ECONNREFUSED/);

  const exposition = metrics.renderText();
  assert.match(
    exposition,
    /siragpt_stream_failures_total\{surface="agent\.batch",code="provider_unavailable"\} 1/,
  );
});

test('timeouts, cancellation, persistence, and validation map to bounded public codes', () => {
  assert.equal(classifyPublicStreamError(Object.assign(new Error('late'), { name: 'TimeoutError' })).code, 'timeout');
  assert.equal(classifyPublicStreamError(Object.assign(new Error('cancelled'), { name: 'AbortError' })).code, 'aborted');
  assert.equal(classifyPublicStreamError(Object.assign(new Error('db details'), { code: 'PERSISTENCE_FAILED' })).code, 'persistence_failed');
  assert.equal(classifyPublicStreamError(Object.assign(new Error('bad output'), { code: 'DOCUMENT_VALIDATION_FAILED' })).code, 'validation_failed');
});

test('final and nested agent events cannot expose raw stopped reasons or error details', () => {
  const secret = 'model_error: Bearer sk-prod-secret /opt/siragpt/.env';
  assert.equal(sanitizePublicStoppedReason(secret), 'failed');
  const sanitized = sanitizePublicStreamEvent({
    type: 'final',
    stoppedReason: secret,
    plan: [{ stoppedReason: `provider_failed: ${secret}`, lastError: secret }],
    error: { message: secret, stack: `/opt/siragpt/src/agent.js:1 ${secret}` },
  }, { surface: 'agent.run.final' });

  assert.equal(sanitized.stoppedReason, 'failed');
  assert.equal(sanitized.plan[0].stoppedReason, 'failed');
  assert.equal(sanitized.error.code, 'internal_error');
  assert.doesNotMatch(JSON.stringify(sanitized), /Bearer|sk-prod-secret|\/opt\/siragpt|model_error/);
});
