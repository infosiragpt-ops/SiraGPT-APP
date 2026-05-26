'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-api-endpoints');
const { extractApiEndpoints, buildApiEndpointsForFiles, renderApiEndpointsBlock, _internal } = engine;
const { isLikelyPath } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractApiEndpoints('').total, 0);
  assert.equal(extractApiEndpoints(null).total, 0);
});

test('isLikelyPath: rejects file paths with extensions', () => {
  assert.equal(isLikelyPath('/api/users'), true);
  assert.equal(isLikelyPath('/image.png'), false);
  assert.equal(isLikelyPath('/file.pdf'), false);
});

test('isLikelyPath: requires leading slash', () => {
  assert.equal(isLikelyPath('api/users'), false);
  assert.equal(isLikelyPath('/api/users'), true);
});

test('detects GET /api/users', () => {
  const r = extractApiEndpoints('Use GET /api/users to list users.');
  assert.ok(r.endpoints.some((e) => e.method === 'GET' && e.path === '/api/users'));
});

test('detects POST with path param', () => {
  const r = extractApiEndpoints('POST /api/orders/{id} updates order');
  assert.ok(r.endpoints.some((e) => e.method === 'POST' && /\/api\/orders/.test(e.path)));
});

test('detects DELETE in backticks', () => {
  const r = extractApiEndpoints('Use `DELETE /api/users/123` to remove.');
  assert.ok(r.endpoints.some((e) => e.method === 'DELETE'));
});

test('detects markdown header endpoint', () => {
  const r = extractApiEndpoints('## POST /webhooks\nBody here.');
  assert.ok(r.endpoints.some((e) => e.method === 'POST' && /\/webhooks/.test(e.path)));
});

test('detects OpenAPI paths block', () => {
  const text = `paths:\n  /api/users:\n    get:\n      summary: list`;
  const r = extractApiEndpoints(text);
  assert.ok(r.endpoints.some((e) => /\/api\/users/.test(e.path)));
});

test('groups byMethod', () => {
  const r = extractApiEndpoints('GET /a\nPOST /b\nDELETE /c');
  assert.equal(r.byMethod.GET, 1);
  assert.equal(r.byMethod.POST, 1);
  assert.equal(r.byMethod.DELETE, 1);
});

test('dedupes identical method+path', () => {
  const r = extractApiEndpoints('GET /api/x and again GET /api/x');
  assert.equal(r.endpoints.filter((e) => e.method === 'GET' && e.path === '/api/x').length, 1);
});

test('caps per method', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `GET /api/route-${i}\n`;
  const r = extractApiEndpoints(text);
  assert.ok(r.byMethod.GET <= 12);
});

test('caps per file overall', () => {
  let text = '';
  for (let i = 0; i < 50; i++) text += `${['GET', 'POST', 'PATCH', 'DELETE'][i % 4]} /api/r-${i}\n`;
  const r = extractApiEndpoints(text);
  assert.ok(r.endpoints.length <= 32);
});

test('strips trailing punctuation', () => {
  const r = extractApiEndpoints('Call GET /api/users.\nThen POST /api/orders,');
  assert.ok(r.endpoints.some((e) => e.path === '/api/users'));
  assert.ok(r.endpoints.some((e) => e.path === '/api/orders'));
});

test('ignores prose words like POST in non-API context', () => {
  const r = extractApiEndpoints('Visit our blog POST about features.');
  // "POST about" — "about" doesn't start with /, so should not match
  assert.equal(r.endpoints.filter((e) => e.method === 'POST').length, 0);
});

test('does not match GET inside a word', () => {
  const r = extractApiEndpoints('FORGETting password /api/foo');
  assert.equal(r.endpoints.filter((e) => e.method === 'GET').length, 0);
});

test('buildApiEndpointsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'GET /api/foo' },
    { name: 'b.md', extractedText: 'POST /api/bar' },
  ];
  const r = buildApiEndpointsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderApiEndpointsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'GET /api/foo' }];
  const r = buildApiEndpointsForFiles(files);
  const md = renderApiEndpointsBlock(r);
  assert.match(md, /^## API ENDPOINTS/);
  assert.match(md, /GET \/api\/foo/);
});

test('renderApiEndpointsBlock includes by-method breakdown', () => {
  const files = [{ name: 'doc.md', extractedText: 'GET /a\nPOST /b' }];
  const r = buildApiEndpointsForFiles(files);
  const md = renderApiEndpointsBlock(r);
  assert.match(md, /By method/);
});

test('renderApiEndpointsBlock empty when nothing surfaces', () => {
  assert.equal(renderApiEndpointsBlock({ perFile: [] }), '');
  assert.equal(renderApiEndpointsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildApiEndpointsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'GET /api/x' },
  ]);
  assert.equal(r.perFile.length, 1);
});
