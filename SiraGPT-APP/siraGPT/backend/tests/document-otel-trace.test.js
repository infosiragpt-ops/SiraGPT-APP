'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-otel-trace');
const { extractOtelTrace, buildOtelTraceForFiles, renderOtelTraceBlock, _internal } = engine;
const { maskId } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractOtelTrace('').total, 0);
  assert.equal(extractOtelTrace(null).total, 0);
});

test('maskId: returns first-4…last-4', () => {
  assert.equal(maskId('0123456789abcdef0123456789abcdef'), '0123…cdef');
  assert.equal(maskId('aa'), '****');
});

test('detects W3C traceparent', () => {
  const r = extractOtelTrace(
    'traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
  );
  assert.ok(r.entries.some((e) => e.kind === 'traceparent'));
});

test('W3C trace output is masked', () => {
  const r = extractOtelTrace(
    'traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
  );
  for (const e of r.entries) {
    assert.ok(!/4bf92f3577b34da6a3ce929d0e0e4736/.test(e.masked));
  }
});

test('detects labeled trace_id', () => {
  const r = extractOtelTrace('trace_id: 4bf92f3577b34da6a3ce929d0e0e4736');
  assert.ok(r.entries.some((e) => e.kind === 'trace_id'));
});

test('detects labeled span_id', () => {
  const r = extractOtelTrace('span_id: 00f067aa0ba902b7');
  assert.ok(r.entries.some((e) => e.kind === 'span_id'));
});

test('detects GCP X-Cloud-Trace-Context', () => {
  const r = extractOtelTrace('X-Cloud-Trace-Context: 105445aa7843bc8bf206b12000100012/1234567890;o=1');
  assert.ok(r.entries.some((e) => e.kind === 'gcp-trace'));
});

test('detects AWS X-Ray trace ID', () => {
  const r = extractOtelTrace('X-Amzn-Trace-Id: Root=1-5759e988-bd862e3fe1be46a994272793');
  assert.ok(r.entries.some((e) => e.kind === 'aws-xray'));
});

test('detects B3 TraceId / SpanId', () => {
  const r = extractOtelTrace(
    'X-B3-TraceId: 80f198ee56343ba864fe8b2a57d3eff7\n' +
    'X-B3-SpanId: e457b5a2e4d86bd1'
  );
  assert.ok(r.entries.some((e) => e.kind === 'b3-trace'));
  assert.ok(r.entries.some((e) => e.kind === 'b3-span'));
});

test('dedupes identical IDs', () => {
  const r = extractOtelTrace(
    'trace_id: 4bf92f3577b34da6a3ce929d0e0e4736 here. trace_id: 4bf92f3577b34da6a3ce929d0e0e4736 again.'
  );
  assert.equal(r.entries.filter((e) => e.kind === 'trace_id').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `trace_id: ${i.toString(16).padStart(32, '0')}\n`;
  const r = extractOtelTrace(text);
  assert.ok(r.entries.length <= 14);
});

test('buildOtelTraceForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'trace_id: 4bf92f3577b34da6a3ce929d0e0e4736' },
    { name: 'b', extractedText: 'span_id: 00f067aa0ba902b7' },
  ];
  const r = buildOtelTraceForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderOtelTraceBlock returns markdown when entries exist', () => {
  const files = [{ name: 'log', extractedText: 'trace_id: 4bf92f3577b34da6a3ce929d0e0e4736' }];
  const r = buildOtelTraceForFiles(files);
  const md = renderOtelTraceBlock(r);
  assert.match(md, /^## OPENTELEMETRY/);
});

test('renderOtelTraceBlock NEVER contains the full ID', () => {
  const files = [{ name: 'log', extractedText: 'trace_id: 4bf92f3577b34da6a3ce929d0e0e4736' }];
  const r = buildOtelTraceForFiles(files);
  const md = renderOtelTraceBlock(r);
  assert.ok(!/4bf92f3577b34da6a3ce929d0e0e4736/.test(md));
});

test('renderOtelTraceBlock empty when nothing surfaces', () => {
  assert.equal(renderOtelTraceBlock({ perFile: [] }), '');
  assert.equal(renderOtelTraceBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildOtelTraceForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'trace_id: 4bf92f3577b34da6a3ce929d0e0e4736' },
  ]);
  assert.equal(r.perFile.length, 1);
});
