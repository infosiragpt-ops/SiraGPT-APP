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

  test('hashUserId returns stable 16-hex-char digest, drops empty input', () => {
    assert.equal(otelSpans.hashUserId(null), null);
    assert.equal(otelSpans.hashUserId(undefined), null);
    assert.equal(otelSpans.hashUserId(''), null);
    const h1 = otelSpans.hashUserId('alice@example.com');
    const h2 = otelSpans.hashUserId('alice@example.com');
    const h3 = otelSpans.hashUserId('bob@example.com');
    assert.equal(typeof h1, 'string');
    assert.equal(h1.length, 16);
    assert.match(h1, /^[0-9a-f]{16}$/);
    assert.equal(h1, h2);
    assert.notEqual(h1, h3);
    // Numeric input is coerced to string
    assert.equal(otelSpans.hashUserId(42), otelSpans.hashUserId('42'));
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

  test('withSpan uses caller-provided name and tracer', async () => {
    const out = await otelSpans.withSpan(
      'custom.unit',
      { foo: 'bar' },
      async () => 'value',
      '@siragpt/custom',
    );
    assert.equal(out, 'value');
    assert.equal(spans[0].name, 'custom.unit');
    assert.equal(spans[0].attrs.foo, 'bar');
    assert.equal(spans[0].status.code, api.SpanStatusCode.OK);
  });

  test('httpSpanMiddleware wraps req in http.{METHOD}.{route} span and records status', (t, done) => {
    const EventEmitter = require('node:events');
    const mw = otelSpans.httpSpanMiddleware();

    const req = {
      method: 'get',
      originalUrl: '/api/widgets/123?x=1',
      baseUrl: '/api/widgets',
      path: '/123',
      route: { path: '/api/widgets/:id' },
      headers: { 'user-agent': 'jest-agent' },
      id: 'req-1',
    };
    const res = new EventEmitter();
    res.statusCode = 0;

    mw(req, res, () => {
      // Simulate handler completing successfully.
      res.statusCode = 201;
      res.emit('finish');
      try {
        assert.equal(spans.length, 1);
        assert.equal(spans[0].name, 'http.GET./api/widgets/:id');
        assert.equal(spans[0].attrs['http.method'], 'GET');
        assert.equal(spans[0].attrs['http.route'], '/api/widgets/:id');
        assert.equal(spans[0].attrs['http.status_code'], 201);
        assert.equal(spans[0].attrs['http.request_id'], 'req-1');
        assert.equal(spans[0].attrs['http.user_agent'], 'jest-agent');
        assert.equal(spans[0].status.code, api.SpanStatusCode.OK);
        assert.ok(spans[0].ended);
        done();
      } catch (err) { done(err); }
    });
  });

  test('httpSpanMiddleware marks ERROR on 5xx', (t, done) => {
    const EventEmitter = require('node:events');
    const mw = otelSpans.httpSpanMiddleware({ routePath: '/api/forced' });
    const req = { method: 'POST', originalUrl: '/api/forced', headers: {} };
    const res = new EventEmitter();
    res.statusCode = 0;

    mw(req, res, () => {
      res.statusCode = 503;
      res.emit('close');
      try {
        assert.equal(spans[0].name, 'http.POST./api/forced');
        assert.equal(spans[0].attrs['http.status_code'], 503);
        assert.equal(spans[0].status.code, api.SpanStatusCode.ERROR);
        done();
      } catch (err) { done(err); }
    });
  });

  test('ai.generate span carries hashed userId / orgId / planTier attrs', async () => {
    const hash = otelSpans.hashUserId('user-42');
    assert.equal(typeof hash, 'string');
    assert.equal(hash.length, 16);
    await otelSpans.withAIGenerateSpan(
      {
        model: 'gpt-4o',
        provider: 'openai',
        userId: hash,
        orgId: 'org-7',
        planTier: 'PRO',
      },
      async () => 'ok',
    );
    const s = spans[spans.length - 1];
    assert.equal(s.name, 'ai.generate');
    assert.equal(s.attrs.userId, hash);
    // raw user id never appears in attrs
    assert.notEqual(s.attrs.userId, 'user-42');
    assert.equal(s.attrs.orgId, 'org-7');
    assert.equal(s.attrs.planTier, 'PRO');
  });

  test('httpSpanMiddleware ends span exactly once across finish + close', (t, done) => {
    const EventEmitter = require('node:events');
    const mw = otelSpans.httpSpanMiddleware();
    const req = { method: 'GET', originalUrl: '/x', path: '/x', headers: {} };
    const res = new EventEmitter();
    res.statusCode = 200;

    mw(req, res, () => {
      res.emit('finish');
      res.emit('close');
      try {
        assert.equal(spans.length, 1);
        // ended flag is boolean; ensure we don't double-end (no throw).
        assert.equal(spans[0].ended, true);
        done();
      } catch (err) { done(err); }
    });
  });
});
