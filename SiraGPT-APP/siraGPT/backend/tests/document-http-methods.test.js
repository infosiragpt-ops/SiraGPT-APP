'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-http-methods');
const { extractHttpMethods, buildHttpMethodsForFiles, renderHttpMethodsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractHttpMethods('').total, 0);
  assert.equal(extractHttpMethods(null).total, 0);
});

test('counts GET', () => {
  const r = extractHttpMethods('Use GET /api/users to list');
  assert.ok(r.counts.GET >= 1);
});

test('counts POST', () => {
  const r = extractHttpMethods('Send POST /api/orders today');
  assert.ok(r.counts.POST >= 1);
});

test('counts multiple methods', () => {
  const r = extractHttpMethods('GET /a then POST /b then PUT /c then DELETE /d');
  assert.ok(r.counts.GET >= 1);
  assert.ok(r.counts.POST >= 1);
  assert.ok(r.counts.PUT >= 1);
  assert.ok(r.counts.DELETE >= 1);
});

test('counts repeated methods', () => {
  const r = extractHttpMethods('GET /a and GET /b and GET /c');
  assert.equal(r.counts.GET, 3);
});

test('ignores method words in prose', () => {
  const r = extractHttpMethods('We GET many requests typically.');
  // "GET many" without slash/quote — shouldn't count
  assert.equal(r.counts.GET, 0);
});

test('total reflects sum', () => {
  const r = extractHttpMethods('GET /a, POST /b, GET /c');
  assert.equal(r.total, 3);
});

test('buildHttpMethodsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'GET /foo' },
    { name: 'b.md', extractedText: 'POST /bar' },
  ];
  const r = buildHttpMethodsForFiles(files);
  assert.equal(r.perFile.length, 2);
  assert.ok(r.totals.GET >= 1);
  assert.ok(r.totals.POST >= 1);
});

test('renderHttpMethodsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'GET /foo' }];
  const r = buildHttpMethodsForFiles(files);
  const md = renderHttpMethodsBlock(r);
  assert.match(md, /^## HTTP METHODS CENSUS/);
});

test('renderHttpMethodsBlock empty when nothing surfaces', () => {
  assert.equal(renderHttpMethodsBlock({ perFile: [] }), '');
  assert.equal(renderHttpMethodsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildHttpMethodsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'GET /foo' },
  ]);
  assert.equal(r.perFile.length, 1);
});

test('counts PATCH and OPTIONS', () => {
  const r = extractHttpMethods('PATCH /api/x to update. OPTIONS /api/y for CORS.');
  assert.ok(r.counts.PATCH >= 1);
  assert.ok(r.counts.OPTIONS >= 1);
});
