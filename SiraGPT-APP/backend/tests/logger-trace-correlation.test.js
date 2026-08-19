/**
 * Tests for the trace_id/span_id correlation mixin in
 * backend/src/middleware/logger.js.
 *
 * We can't easily start the OTel SDK from a unit test, so we drive the
 * mixin directly via the OTel API tracer (which is a no-op when no SDK
 * is registered — we manually push a span context onto the active
 * context to simulate an in-flight request).
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { context, trace, ROOT_CONTEXT } = require('@opentelemetry/api');
const {
  AsyncLocalStorageContextManager,
} = require('@opentelemetry/context-async-hooks');

// The OTel API ships a no-op context manager by default, so context.with()
// won't actually propagate the active span unless we install a real one.
// In production this is set up by the SDK; here we wire it manually.
before(() => {
  const cm = new AsyncLocalStorageContextManager();
  cm.enable();
  context.setGlobalContextManager(cm);
});

const { traceCorrelationMixin } = require('../src/middleware/logger');

const FAKE_TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const FAKE_SPAN_ID = 'b7ad6b7169203331';

function withFakeSpan(spanContext, fn) {
  const ctx = trace.setSpanContext(ROOT_CONTEXT, spanContext);
  return context.with(ctx, fn);
}

describe('traceCorrelationMixin', () => {
  it('returns empty when no span is active', () => {
    const out = traceCorrelationMixin();
    assert.deepEqual(out, {});
  });

  it('returns trace_id and span_id when a span is active', () => {
    withFakeSpan(
      {
        traceId: FAKE_TRACE_ID,
        spanId: FAKE_SPAN_ID,
        traceFlags: 1,
        isRemote: false,
      },
      () => {
        const out = traceCorrelationMixin();
        assert.equal(out.trace_id, FAKE_TRACE_ID);
        assert.equal(out.span_id, FAKE_SPAN_ID);
        assert.equal(out.trace_flags, '01');
      },
    );
  });

  it('handles missing trace flags gracefully', () => {
    withFakeSpan(
      {
        traceId: FAKE_TRACE_ID,
        spanId: FAKE_SPAN_ID,
        traceFlags: undefined,
        isRemote: false,
      },
      () => {
        const out = traceCorrelationMixin();
        assert.equal(out.trace_id, FAKE_TRACE_ID);
        assert.equal(out.span_id, FAKE_SPAN_ID);
        assert.equal(out.trace_flags, undefined);
      },
    );
  });
});
