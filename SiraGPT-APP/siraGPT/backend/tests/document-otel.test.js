'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-otel');
const { extractOtel, buildOtelForFiles, renderOtelBlock, _internal } = engine;
const { isOtelLike } = _internal;

const OTEL_FIXTURE = `import { trace, context, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { SemanticAttributes, SEMATTRS_HTTP_METHOD } from '@opentelemetry/semantic-conventions';

const tracer = trace.getTracer('my-service', '1.0.0');
const meter = metrics.getMeter('my-service');

const counter = meter.createCounter('requests.total');
const histogram = meter.createHistogram('request.duration');

const propagator = new W3CTraceContextPropagator();

export async function handleRequest(req, res) {
  const span = tracer.startSpan('http.request', { kind: SpanKind.SERVER });
  span.setAttribute('http.method', req.method);
  span.setAttribute(SEMATTRS_HTTP_METHOD, req.method);
  span.setAttributes({ 'http.url': req.url, 'http.status_code': 200 });
  span.addEvent('processing', { 'user.id': req.user.id });

  try {
    const result = await processRequest(req);
    span.setStatus({ code: SpanStatusCode.OK });
    counter.add(1, { 'http.status_code': res.statusCode });
    return result;
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    span.end();
  }
}

const tracerProvider = new NodeTracerProvider({
  instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
});
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractOtel('').total, 0);
  assert.equal(extractOtel(null).total, 0);
});

test('non-OTel text returns empty', () => {
  const r = extractOtel('Just regular code without OpenTelemetry');
  assert.equal(r.total, 0);
});

test('isOtelLike heuristic', () => {
  assert.ok(isOtelLike('@opentelemetry/api'));
  assert.ok(isOtelLike('SpanKind.SERVER'));
  assert.ok(!isOtelLike('plain text'));
});

test('detects trace.getTracer', () => {
  const r = extractOtel(OTEL_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'tracer' && e.name === 'getTracer'));
});

test('detects tracer.startSpan', () => {
  const r = extractOtel(OTEL_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'tracer' && e.name === 'startSpan'));
});

test('detects setAttribute / setAttributes', () => {
  const r = extractOtel(OTEL_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'spanOp' && e.name === 'setAttribute'));
  assert.ok(r.entries.some((e) => e.kind === 'spanOp' && e.name === 'setAttributes'));
});

test('detects addEvent / recordException / setStatus / end', () => {
  const r = extractOtel(OTEL_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'spanOp' && e.name === 'addEvent'));
  assert.ok(r.entries.some((e) => e.kind === 'spanOp' && e.name === 'recordException'));
  assert.ok(r.entries.some((e) => e.kind === 'spanOp' && e.name === 'setStatus'));
  assert.ok(r.entries.some((e) => e.kind === 'spanOp' && e.name === 'end'));
});

test('detects SpanKind values', () => {
  const r = extractOtel(OTEL_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'kind' && e.name === 'SpanKind.SERVER'));
});

test('detects SpanStatusCode values', () => {
  const r = extractOtel(OTEL_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'status' && e.name === 'SpanStatusCode.OK'));
  assert.ok(r.entries.some((e) => e.kind === 'status' && e.name === 'SpanStatusCode.ERROR'));
});

test('detects SEMATTRS_X constants', () => {
  const r = extractOtel(OTEL_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'semanticAttr' && e.name === 'HTTP_METHOD'));
});

test('detects meter.createCounter / createHistogram', () => {
  const r = extractOtel(OTEL_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'meter' && e.name === 'createCounter'));
  assert.ok(r.entries.some((e) => e.kind === 'meter' && e.name === 'createHistogram'));
  assert.ok(r.entries.some((e) => e.kind === 'meter' && e.name === 'getMeter'));
});

test('detects propagators', () => {
  const r = extractOtel(OTEL_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'propagator' && e.name === 'W3CTraceContextPropagator'));
});

test('detects instrumentations', () => {
  const r = extractOtel(OTEL_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'instrumentation' && e.name === 'HttpInstrumentation'));
  assert.ok(r.entries.some((e) => e.kind === 'instrumentation' && e.name === 'ExpressInstrumentation'));
});

test('detects standard attribute keys', () => {
  const r = extractOtel(OTEL_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'attrKey' && e.name === 'http.method'));
  assert.ok(r.entries.some((e) => e.kind === 'attrKey' && e.name === 'http.url'));
});

test('dedupes identical calls', () => {
  const r = extractOtel('SpanKind.SERVER; SpanKind.SERVER;');
  assert.equal(r.entries.filter((e) => e.kind === 'kind' && e.name === 'SpanKind.SERVER').length, 1);
});

test('caps entries per file', () => {
  let text = 'import { trace } from "@opentelemetry/api";\n';
  for (let i = 0; i < 30; i++) text += `span.setAttribute("attr.${i}", v); `;
  const r = extractOtel(text);
  assert.ok(r.entries.length <= 24);
});

test('counts totals by kind', () => {
  const r = extractOtel(OTEL_FIXTURE);
  assert.ok(r.totals.spanOp >= 4);
  assert.ok(r.totals.kind >= 1);
});

test('buildOtelForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.ts', extractedText: 'import { trace, SpanKind } from "@opentelemetry/api"; const t = trace.getTracer("a");' },
    { name: 'b.ts', extractedText: 'import { SpanKind } from "@opentelemetry/api"; const k = SpanKind.CLIENT;' },
  ];
  const r = buildOtelForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderOtelBlock returns markdown when entries exist', () => {
  const files = [{ name: 'tracing.ts', extractedText: OTEL_FIXTURE }];
  const r = buildOtelForFiles(files);
  const md = renderOtelBlock(r);
  assert.match(md, /^## OPENTELEMETRY/);
});

test('renderOtelBlock empty when nothing surfaces', () => {
  assert.equal(renderOtelBlock({ perFile: [] }), '');
  assert.equal(renderOtelBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildOtelForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: OTEL_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
