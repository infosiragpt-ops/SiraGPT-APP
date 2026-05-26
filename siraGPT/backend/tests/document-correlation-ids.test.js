'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-correlation-ids');
const { extractCorrelationIds, buildCorrelationIdsForFiles, renderCorrelationIdsBlock, _internal } = engine;
const { maskId, classifyFormat } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractCorrelationIds('').total, 0);
  assert.equal(extractCorrelationIds(null).total, 0);
});

test('maskId: first-4 last-4', () => {
  assert.equal(maskId('aaaaaaaaaaaa'), 'aaaa…aaaa');
});

test('classifyFormat: uuid / ulid / hex32 / hex16 / numeric', () => {
  assert.equal(classifyFormat('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), 'uuid');
  assert.equal(classifyFormat('01ARZ3NDEKTSV4RRFFQ69G5FAV'), 'ulid');
  assert.equal(classifyFormat('a'.repeat(32)), 'hex32');
  assert.equal(classifyFormat('a'.repeat(16)), 'hex16');
  assert.equal(classifyFormat('123456789'), 'numeric');
});

test('detects X-Request-Id', () => {
  const r = extractCorrelationIds('X-Request-Id: 11111111-2222-3333-4444-555555555555');
  assert.ok(r.entries.some((e) => e.role === 'request-id'));
});

test('X-Request-Id value is masked', () => {
  const r = extractCorrelationIds('X-Request-Id: 11111111-2222-3333-4444-555555555555');
  for (const e of r.entries) {
    assert.ok(!/11111111-2222-3333-4444-555555555555/.test(e.masked));
  }
});

test('detects X-Correlation-Id', () => {
  const r = extractCorrelationIds('X-Correlation-Id: abcdef1234567890');
  assert.ok(r.entries.some((e) => e.role === 'correlation-id'));
});

test('detects CF-Ray (Cloudflare)', () => {
  const r = extractCorrelationIds('CF-Ray: 80abc12def345678-LAX');
  assert.ok(r.entries.some((e) => e.role === 'cloudflare-ray'));
});

test('detects X-Amzn-RequestId (AWS)', () => {
  const r = extractCorrelationIds('X-Amzn-RequestId: aaaabbbbccccdddd1234');
  assert.ok(r.entries.some((e) => e.role === 'aws-request-id'));
});

test('detects X-GitHub-Request-Id', () => {
  const r = extractCorrelationIds('X-GitHub-Request-Id: A1B2:C3D4:E5F67890:12345678:abcdef01');
  assert.ok(r.entries.some((e) => e.role === 'github-request-id'));
});

test('detects X-Vercel-Id', () => {
  const r = extractCorrelationIds('x-vercel-id: cdg1::iad1::xyz-1234567890-abcd1234efgh');
  assert.ok(r.entries.some((e) => e.role === 'vercel-id'));
});

test('classifies uuid format', () => {
  const r = extractCorrelationIds('X-Request-Id: 11111111-2222-3333-4444-555555555555');
  assert.ok(r.entries.some((e) => e.format === 'uuid'));
});

test('classifies hex format', () => {
  const r = extractCorrelationIds('X-Trace-Id: abcdef1234567890');
  assert.ok(r.entries.some((e) => e.format === 'hex16'));
});

test('dedupes identical entries', () => {
  const r = extractCorrelationIds('X-Request-Id: abcd1234 here and X-Request-Id: abcd1234 again');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `X-Request-Id: aaaaaaaa-bbbb-cccc-dddd-${i.toString().padStart(12, '0')}\n`;
  const r = extractCorrelationIds(text);
  assert.ok(r.entries.length <= 16);
});

test('buildCorrelationIdsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'X-Request-Id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    { name: 'b', extractedText: 'CF-Ray: 80abc12def345678-LAX' },
  ];
  const r = buildCorrelationIdsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCorrelationIdsBlock NEVER contains the full ID', () => {
  const files = [{ name: 'h', extractedText: 'X-Request-Id: 11111111-2222-3333-4444-555555555555' }];
  const r = buildCorrelationIdsForFiles(files);
  const md = renderCorrelationIdsBlock(r);
  assert.ok(!/11111111-2222-3333-4444-555555555555/.test(md));
});

test('renderCorrelationIdsBlock empty when nothing surfaces', () => {
  assert.equal(renderCorrelationIdsBlock({ perFile: [] }), '');
  assert.equal(renderCorrelationIdsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildCorrelationIdsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'X-Request-Id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
  ]);
  assert.equal(r.perFile.length, 1);
});
