'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-pip-reqs');
const { extractPipReqs, buildPipReqsForFiles, renderPipReqsBlock, _internal } = engine;
const { classifyOp } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractPipReqs('').total, 0);
  assert.equal(extractPipReqs(null).total, 0);
});

test('classifyOp: == is exact, >= is min-bound', () => {
  assert.equal(classifyOp('=='), 'exact');
  assert.equal(classifyOp('>='), 'min-bound');
  assert.equal(classifyOp('<='), 'max-bound');
  assert.equal(classifyOp('~='), 'compatible');
});

test('detects exact pin foo==1.2.3', () => {
  const r = extractPipReqs('django==4.2.1');
  assert.ok(r.entries.some((e) => e.name === 'django' && e.kind === 'exact'));
});

test('detects min-bound foo>=1.0', () => {
  const r = extractPipReqs('requests>=2.31.0');
  assert.ok(r.entries.some((e) => e.kind === 'min-bound'));
});

test('detects max-bound foo<2.0', () => {
  const r = extractPipReqs('numpy<2.0');
  assert.ok(r.entries.some((e) => e.kind === 'max-bound'));
});

test('detects compatible release foo~=1.2', () => {
  const r = extractPipReqs('pydantic~=2.5');
  assert.ok(r.entries.some((e) => e.kind === 'compatible'));
});

test('detects extras foo[extra]==1.0', () => {
  const r = extractPipReqs('fastapi[all]==0.110.0');
  const entry = r.entries.find((e) => e.name === 'fastapi');
  assert.equal(entry.extras, '[all]');
});

test('detects environment markers', () => {
  const r = extractPipReqs('typing-extensions>=4.0 ; python_version < "3.11"');
  const entry = r.entries[0];
  assert.match(entry.marker, /python_version/);
});

test('detects VCS dependency', () => {
  const r = extractPipReqs('git+https://github.com/foo/bar@main');
  assert.ok(r.entries.some((e) => e.kind === 'vcs'));
});

test('detects editable install', () => {
  const r = extractPipReqs('-e .[dev]');
  assert.ok(r.entries.some((e) => e.kind === 'editable'));
});

test('rejects python reserved word', () => {
  const r = extractPipReqs('python>=3.10');
  assert.equal(r.entries.filter((e) => e.name === 'python').length, 0);
});

test('dedupes identical entries', () => {
  const r = extractPipReqs('django==4.2\ndjango==4.2');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `pkg-${i}==1.${i}.0\n`;
  const r = extractPipReqs(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractPipReqs('django==4.2\nrequests>=2.31\nnumpy<2.0\npydantic~=2.5');
  assert.ok(r.totals.exact >= 1);
  assert.ok(r.totals['min-bound'] >= 1);
  assert.ok(r.totals['max-bound'] >= 1);
  assert.ok(r.totals.compatible >= 1);
});

test('buildPipReqsForFiles aggregates across batch', () => {
  const files = [
    { name: 'requirements.txt', extractedText: 'django==4.2' },
    { name: 'dev-requirements.txt', extractedText: 'pytest>=8.0' },
  ];
  const r = buildPipReqsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderPipReqsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'requirements.txt', extractedText: 'django==4.2' }];
  const r = buildPipReqsForFiles(files);
  const md = renderPipReqsBlock(r);
  assert.match(md, /^## PYTHON/);
});

test('renderPipReqsBlock empty when nothing surfaces', () => {
  assert.equal(renderPipReqsBlock({ perFile: [] }), '');
  assert.equal(renderPipReqsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildPipReqsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'django==4.2' },
  ]);
  assert.equal(r.perFile.length, 1);
});
