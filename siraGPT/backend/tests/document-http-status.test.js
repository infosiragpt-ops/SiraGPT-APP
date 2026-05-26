'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-http-status');
const { extractHttpStatus, buildHttpStatusForFiles, renderHttpStatusBlock, _internal } = engine;
const { classify } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractHttpStatus('').total, 0);
  assert.equal(extractHttpStatus(null).total, 0);
});

test('classify by code', () => {
  assert.equal(classify(100), '1xx');
  assert.equal(classify(200), '2xx');
  assert.equal(classify(301), '3xx');
  assert.equal(classify(404), '4xx');
  assert.equal(classify(503), '5xx');
});

test('detects "HTTP 200"', () => {
  const r = extractHttpStatus('Server returned HTTP 200 today.');
  assert.ok(r.codes.some((c) => c.code === 200));
});

test('detects "Status: 404"', () => {
  const r = extractHttpStatus('Status: 404 reported.');
  assert.ok(r.codes.some((c) => c.code === 404));
});

test('detects "returns a 401"', () => {
  const r = extractHttpStatus('API returns a 401 on auth failure.');
  assert.ok(r.codes.some((c) => c.code === 401));
});

test('detects "404 Not Found"', () => {
  const r = extractHttpStatus('Got 404 Not Found from upstream.');
  assert.ok(r.codes.some((c) => c.code === 404));
});

test('detects "503 Service Unavailable"', () => {
  const r = extractHttpStatus('Returned 503 Service Unavailable repeatedly.');
  assert.ok(r.codes.some((c) => c.code === 503));
});

test('rejects unknown 3-digit numbers', () => {
  const r = extractHttpStatus('Random number 234 in text.');
  assert.equal(r.codes.length, 0);
});

test('byClass counts correctly', () => {
  const r = extractHttpStatus('Got 200, then 404, then 503.');
  assert.ok(r.byClass['2xx'] >= 1);
  assert.ok(r.byClass['4xx'] >= 1);
  assert.ok(r.byClass['5xx'] >= 1);
});

test('dedupes identical codes', () => {
  const r = extractHttpStatus('Got 404. Got 404 again.');
  assert.equal(r.codes.filter((c) => c.code === 404).length, 1);
});

test('caps codes per file', () => {
  let text = '';
  for (let i = 100; i < 600; i += 100) text += `Status: ${i} `;
  for (let i = 0; i < 30; i++) text += `Status: ${[200, 404, 503][i % 3]} `;
  const r = extractHttpStatus(text);
  assert.ok(r.codes.length <= 20);
});

test('buildHttpStatusForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Status: 200' },
    { name: 'b.md', extractedText: 'Status: 500' },
  ];
  const r = buildHttpStatusForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderHttpStatusBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Status: 404' }];
  const r = buildHttpStatusForFiles(files);
  const md = renderHttpStatusBlock(r);
  assert.match(md, /^## HTTP STATUS CODES/);
});

test('renderHttpStatusBlock empty when nothing surfaces', () => {
  assert.equal(renderHttpStatusBlock({ perFile: [] }), '');
  assert.equal(renderHttpStatusBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildHttpStatusForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Status: 200' },
  ]);
  assert.equal(r.perFile.length, 1);
});
