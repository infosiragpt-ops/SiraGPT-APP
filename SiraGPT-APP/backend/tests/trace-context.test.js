'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  parseTraceparent,
  formatTraceparent,
  parseTracestate,
  formatTracestate,
  newTraceContext,
  childOf,
  withContext,
  currentContext,
  injectHeaders,
  extractFromHeaders,
  FLAG_SAMPLED,
} = require('../src/services/observability/trace-context');

describe('parseTraceparent', () => {
  test('parses a valid sampled traceparent', () => {
    const r = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    assert.equal(r.version, '00');
    assert.equal(r.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.equal(r.spanId, '00f067aa0ba902b7');
    assert.equal(r.flags, 1);
  });
  test('case-insensitive', () => {
    const r = parseTraceparent('00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01');
    assert.equal(r.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  });
  test('rejects all-zero ids', () => {
    assert.equal(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01'), null);
    assert.equal(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01'), null);
  });
  test('rejects malformed input', () => {
    assert.equal(parseTraceparent(''), null);
    assert.equal(parseTraceparent(null), null);
    assert.equal(parseTraceparent('garbage'), null);
    assert.equal(parseTraceparent('00-shorttrace-00f067aa0ba902b7-01'), null);
  });
});

describe('formatTraceparent', () => {
  test('round-trips', () => {
    const ctx = newTraceContext();
    const wire = formatTraceparent(ctx);
    const parsed = parseTraceparent(wire);
    assert.equal(parsed.traceId, ctx.traceId);
    assert.equal(parsed.spanId, ctx.spanId);
    assert.equal(parsed.flags, ctx.flags);
  });
  test('rejects bad ids', () => {
    assert.throws(() => formatTraceparent({ traceId: 'short', spanId: '00f067aa0ba902b7', flags: 1 }), TypeError);
    assert.throws(() => formatTraceparent({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: 'short', flags: 1 }), TypeError);
  });
});

describe('parseTracestate / formatTracestate', () => {
  test('parses comma-separated key=value pairs', () => {
    const m = parseTracestate('vendor1=abc, vendor2=xyz');
    assert.equal(m.size, 2);
    assert.equal(m.get('vendor1'), 'abc');
    assert.equal(m.get('vendor2'), 'xyz');
  });
  test('drops malformed entries', () => {
    const m = parseTracestate('=novalue,nokey,good=ok,=,trailing=');
    assert.equal(m.size, 1);
    assert.equal(m.get('good'), 'ok');
  });
  test('caps at 32 members per spec', () => {
    const parts = [];
    for (let i = 0; i < 50; i++) parts.push(`v${i}=x`);
    const m = parseTracestate(parts.join(','));
    assert.equal(m.size, 32);
  });
  test('format/parse round-trips', () => {
    const m = new Map([['a', '1'], ['b', '2']]);
    const out = formatTracestate(m);
    const back = parseTracestate(out);
    assert.deepEqual([...back.entries()], [['a', '1'], ['b', '2']]);
  });
  test('empty map → empty string', () => {
    assert.equal(formatTracestate(new Map()), '');
  });
});

describe('newTraceContext / childOf', () => {
  test('newTraceContext makes valid sampled ctx', () => {
    const ctx = newTraceContext();
    assert.equal(ctx.flags & FLAG_SAMPLED, FLAG_SAMPLED);
    assert.equal(ctx.traceId.length, 32);
    assert.equal(ctx.spanId.length, 16);
  });
  test('newTraceContext({sampled:false}) clears the bit', () => {
    const ctx = newTraceContext({ sampled: false });
    assert.equal(ctx.flags & FLAG_SAMPLED, 0);
  });
  test('childOf preserves traceId, mints new spanId, copies state', () => {
    const parent = newTraceContext();
    parent.state.set('vendor', 'val');
    const child = childOf(parent);
    assert.equal(child.traceId, parent.traceId);
    assert.notEqual(child.spanId, parent.spanId);
    assert.equal(child.state.get('vendor'), 'val');
  });
});

describe('AsyncLocalStorage propagation', () => {
  test('withContext / currentContext', async () => {
    const ctx = newTraceContext();
    assert.equal(currentContext(), null);
    await withContext(ctx, async () => {
      assert.equal(currentContext(), ctx);
      // survives async boundary
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(currentContext(), ctx);
    });
    assert.equal(currentContext(), null);
  });
});

describe('injectHeaders / extractFromHeaders', () => {
  test('inject + extract round-trips', () => {
    const ctx = newTraceContext();
    ctx.state.set('siragpt', 'v1');
    const headers = injectHeaders({}, ctx);
    assert.ok(headers.traceparent);
    assert.equal(headers.tracestate, 'siragpt=v1');
    const extracted = extractFromHeaders(headers);
    assert.equal(extracted.traceId, ctx.traceId);
    assert.equal(extracted.state.get('siragpt'), 'v1');
  });

  test('inject uses currentContext when ctx not given', () => {
    const ctx = newTraceContext();
    withContext(ctx, () => {
      const h = injectHeaders({});
      assert.ok(h.traceparent.includes(ctx.traceId));
    });
  });

  test('inject without any ctx is a no-op', () => {
    const h = injectHeaders({});
    assert.equal(h.traceparent, undefined);
  });

  test('extract reads canonical and capitalized header names', () => {
    const ctx = newTraceContext();
    const wire = formatTraceparent(ctx);
    assert.ok(extractFromHeaders({ Traceparent: wire }));
    assert.ok(extractFromHeaders({ traceparent: wire }));
  });

  test('extract returns null for headers with no traceparent', () => {
    assert.equal(extractFromHeaders({}), null);
    assert.equal(extractFromHeaders(null), null);
  });
});
