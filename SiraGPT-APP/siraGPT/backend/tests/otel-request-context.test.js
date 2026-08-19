/**
 * Tests for otel-request-context.js — middleware that decorates the
 * active OTel span with request metadata and stamps the trace id back
 * onto the response.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  TRACE_HEADER,
  applyRequestTraceContext,
  readRequestId,
  otelRequestContextMiddleware,
} = require('../src/middleware/otel-request-context');

function mockSpan(spanContext) {
  const attrs = {};
  return {
    attrs,
    setAttribute(key, value) {
      attrs[key] = value;
    },
    spanContext() {
      return spanContext || { traceId: 'abcdef0123456789' };
    },
  };
}

function mockRes(initial = {}) {
  const headers = { ...(initial.headers || {}) };
  return {
    headers,
    headersSent: initial.headersSent || false,
    setHeader(name, value) {
      headers[name] = value;
    },
  };
}

describe('TRACE_HEADER', () => {
  it('is the standard X-Trace-Id header', () => {
    assert.equal(TRACE_HEADER, 'X-Trace-Id');
  });
});

describe('readRequestId', () => {
  it('returns null for a missing request', () => {
    assert.equal(readRequestId(null), null);
    assert.equal(readRequestId(undefined), null);
  });

  it('reads req.requestId first', () => {
    assert.equal(
      readRequestId({ requestId: 'r-1', id: 'r-2', headers: { 'x-request-id': 'r-3' } }),
      'r-1',
    );
  });

  it('falls through to req.id when requestId is absent', () => {
    assert.equal(
      readRequestId({ id: 'r-2', headers: { 'x-request-id': 'r-3' } }),
      'r-2',
    );
  });

  it('falls through to x-request-id header when both .requestId and .id absent', () => {
    assert.equal(
      readRequestId({ headers: { 'x-request-id': 'r-3' } }),
      'r-3',
    );
  });

  it('returns null when no source is present', () => {
    assert.equal(readRequestId({}), null);
    assert.equal(readRequestId({ headers: {} }), null);
  });

  it('coerces numeric ids to string', () => {
    assert.equal(readRequestId({ id: 42 }), '42');
    assert.equal(readRequestId({ requestId: 99 }), '99');
  });
});

describe('applyRequestTraceContext', () => {
  it('returns null when no span is provided', () => {
    assert.equal(applyRequestTraceContext({}), null);
    assert.equal(applyRequestTraceContext({ span: null }), null);
  });

  it('returns null when span lacks setAttribute', () => {
    const out = applyRequestTraceContext({ span: { spanContext: () => ({ traceId: 'x' }) } });
    assert.equal(out, null);
  });

  it('sets request_id attribute on the span when present', () => {
    const span = mockSpan();
    const req = { requestId: 'req-123' };
    const res = mockRes();
    const result = applyRequestTraceContext({ span, req, res });
    assert.equal(span.attrs['siragpt.request_id'], 'req-123');
    assert.equal(span.attrs['http.request_id'], 'req-123');
    assert.equal(result.requestId, 'req-123');
  });

  it('omits request_id attribute when the request has no id', () => {
    const span = mockSpan();
    const req = { headers: {} };
    const res = mockRes();
    applyRequestTraceContext({ span, req, res });
    assert.equal('siragpt.request_id' in span.attrs, false);
    assert.equal('http.request_id' in span.attrs, false);
  });

  it('sets authenticated=true when req.user exists', () => {
    const span = mockSpan();
    const req = { user: { id: 'u-1' } };
    const res = mockRes();
    const result = applyRequestTraceContext({ span, req, res });
    assert.equal(span.attrs['siragpt.authenticated'], true);
    assert.equal(result.authenticated, true);
  });

  it('sets authenticated=false when req.user is absent', () => {
    const span = mockSpan();
    const result = applyRequestTraceContext({ span, req: {}, res: mockRes() });
    assert.equal(span.attrs['siragpt.authenticated'], false);
    assert.equal(result.authenticated, false);
  });

  it('writes X-Trace-Id response header when traceId available', () => {
    const span = mockSpan({ traceId: 'trace-id-xyz' });
    const res = mockRes();
    const result = applyRequestTraceContext({ span, req: {}, res });
    assert.equal(res.headers['X-Trace-Id'], 'trace-id-xyz');
    assert.equal(result.traceId, 'trace-id-xyz');
  });

  it('does NOT overwrite headers after they were sent', () => {
    const span = mockSpan({ traceId: 'trace-id-late' });
    const res = mockRes({ headersSent: true });
    const result = applyRequestTraceContext({ span, req: {}, res });
    // Header NOT set since headersSent is true.
    assert.equal('X-Trace-Id' in res.headers, false);
    // traceId is still returned for the caller to use elsewhere.
    assert.equal(result.traceId, 'trace-id-late');
  });

  it('skips the header step when res lacks setHeader', () => {
    const span = mockSpan({ traceId: 'no-res' });
    const result = applyRequestTraceContext({ span, req: {} });
    // No throw, traceId still returned.
    assert.equal(result.traceId, 'no-res');
  });

  it('handles a span whose spanContext() returns null', () => {
    const span = {
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      spanContext: () => null,
    };
    const res = mockRes();
    const result = applyRequestTraceContext({ span, req: {}, res });
    assert.equal(result.traceId, null);
    assert.equal('X-Trace-Id' in res.headers, false);
  });

  it('handles a span without a spanContext function', () => {
    const span = {
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; },
    };
    const res = mockRes();
    const result = applyRequestTraceContext({ span, req: {}, res });
    assert.equal(result.traceId, null);
  });
});

describe('otelRequestContextMiddleware', () => {
  it('always calls next()', () => {
    let called = false;
    otelRequestContextMiddleware({}, mockRes(), () => { called = true; });
    assert.equal(called, true);
  });

  it('never throws even if span/headers are broken', () => {
    // The middleware swallows any error so tracing never blocks the
    // request. Passing a request with a getter that throws should not
    // propagate.
    const evilReq = new Proxy({}, {
      get() { throw new Error('evil getter'); },
    });
    let called = false;
    assert.doesNotThrow(() => {
      otelRequestContextMiddleware(evilReq, mockRes(), () => { called = true; });
    });
    assert.equal(called, true, 'next() must still fire');
  });
});
