/**
 * otel-spans — verifies the defensive span helpers degrade safely when
 * OpenTelemetry isn't configured and propagate attributes / errors when
 * a tracer is wired in.
 *
 * Properties under test:
 *   1. Helpers return the wrapped function's value (transparent).
 *   2. Errors thrown by the wrapped function propagate.
 *   3. With a stub tracer, span name, attrs, status, and end() fire.
 *   4. With a NaN / undefined attr, attribute is dropped silently.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const otelSpans = require('../src/utils/otel-spans');

describe('otel-spans (no SDK / noop tracer)', () => {
  beforeEach(() => otelSpans._resetForTests());

  test('withAIGenerateSpan returns wrapped value', async () => {
    const out = await otelSpans.withAIGenerateSpan(
      { model: 'gpt-4o', provider: 'openai' },
      async () => 'hello',
    );
    assert.equal(out, 'hello');
  });

  test('withDbTransactionSpan propagates throw', async () => {
    await assert.rejects(
      otelSpans.withDbTransactionSpan({}, async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
  });

  test('withWebhookDeliverySpan accepts span arg (noop)', async () => {
    const out = await otelSpans.withWebhookDeliverySpan(
      { url: 'https://x.test', event: 'a.b' },
      async (span) => {
        // Noop tracer returns *something* — we just verify the helper
        // accepts a span argument without crashing.
        if (span && typeof span.setAttributes === 'function') {
          span.setAttributes({ httpStatus: 200 });
        }
        return 42;
      },
    );
    assert.equal(out, 42);
  });
});

describe('otel-spans with a stub tracer provider', () => {
  // We inject a custom global tracer provider so the real @opentelemetry/api
  // surface routes startActiveSpan() calls through our spy.
  const api = require('@opentelemetry/api');

  const spans = [];
  const fakeSpan = (name) => {
    const rec = {
      name,
      attrs: {},
      status: null,
      ended: false,
      setAttribute(k, v) { this.attrs[k] = v; },
      setAttributes(o) { Object.assign(this.attrs, o); },
      setStatus(s) { this.status = s; },
      recordException(_e) { this.exception = _e; },
      end() { this.ended = true; },
    };
    spans.push(rec);
    return rec;
  };

  const fakeTracer = {
    startActiveSpan(name, fn) {
      const span = fakeSpan(name);
      return fn(span);
    },
  };

  const fakeProvider = {
    getTracer() { return fakeTracer; },
  };

  beforeEach(() => {
    spans.length = 0;
    otelSpans._resetForTests();
    api.trace.setGlobalTracerProvider(fakeProvider);
  });

  test('ai.generate span receives model/provider attrs + status OK', async () => {
    await otelSpans.withAIGenerateSpan(
      { model: 'gpt-4o', provider: 'openai', tokensIn: 100, tokensOut: 200 },
      async () => 'ok',
    );
    assert.equal(spans.length, 1);
    assert.equal(spans[0].name, 'ai.generate');
    assert.equal(spans[0].attrs.model, 'gpt-4o');
    assert.equal(spans[0].attrs.provider, 'openai');
    assert.equal(spans[0].attrs.tokensIn, 100);
    assert.equal(spans[0].attrs.tokensOut, 200);
    assert.ok(spans[0].attrs.durationMs >= 0);
    assert.equal(spans[0].status.code, api.SpanStatusCode.OK);
    assert.ok(spans[0].ended);
  });

  test('db.transaction span marks ERROR + records exception when fn throws', async () => {
    await assert.rejects(
      otelSpans.withDbTransactionSpan({ db: 'pg' }, async () => {
        throw new Error('db down');
      }),
      /db down/,
    );
    assert.equal(spans[0].name, 'db.transaction');
    assert.equal(spans[0].status.code, api.SpanStatusCode.ERROR);
    assert.equal(spans[0].exception.message, 'db down');
    assert.ok(spans[0].ended);
  });

  test('webhook.deliver span name + non-finite attrs dropped', async () => {
    await otelSpans.withWebhookDeliverySpan(
      { url: 'u', event: 'e', attempt: NaN, httpStatus: undefined, ok: true },
      async () => null,
    );
    assert.equal(spans[0].name, 'webhook.deliver');
    assert.equal(spans[0].attrs.url, 'u');
    assert.equal(spans[0].attrs.event, 'e');
    assert.equal(spans[0].attrs.ok, true);
    assert.ok(!('attempt' in spans[0].attrs));
    assert.ok(!('httpStatus' in spans[0].attrs));
  });
});
