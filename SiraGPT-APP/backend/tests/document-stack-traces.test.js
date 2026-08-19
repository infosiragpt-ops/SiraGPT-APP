'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-stack-traces');
const { extractStackTraces, buildStackTracesForFiles, renderStackTracesBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractStackTraces('').total, 0);
  assert.equal(extractStackTraces(null).total, 0);
});

test('detects JS V8 stack frame', () => {
  const r = extractStackTraces('    at handleRequest (server/routes/ai.js:123:45)');
  assert.ok(r.entries.some((e) => e.lang === 'js' && e.fn === 'handleRequest' && e.line === 123));
});

test('detects Python "File" line', () => {
  const r = extractStackTraces('  File "/app/main.py", line 42, in compute');
  assert.ok(r.entries.some((e) => e.lang === 'python' && e.fn === 'compute' && e.line === 42));
});

test('detects Java stack frame', () => {
  const r = extractStackTraces('    at com.example.UserService.fetch(UserService.java:88)');
  assert.ok(r.entries.some((e) => e.lang === 'java' && e.line === 88));
});

test('detects Go panic frame', () => {
  const r = extractStackTraces('/app/main.go:42 +0x123');
  assert.ok(r.entries.some((e) => e.lang === 'go' && e.line === 42));
});

test('detects Ruby trace line', () => {
  const r = extractStackTraces("/app/lib/foo.rb:42:in `process'");
  assert.ok(r.entries.some((e) => e.lang === 'ruby' && e.fn === 'process'));
});

test('dedupes identical frames', () => {
  const r = extractStackTraces(
    '    at f (a.js:1:1)\n    at f (a.js:1:1)'
  );
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `    at fn${i} (file.js:${i + 1}:1)\n`;
  const r = extractStackTraces(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by lang', () => {
  const r = extractStackTraces(
    '    at f (a.js:1:1)\n' +
    '  File "b.py", line 1, in g\n' +
    '    at c.X.h(X.java:1)'
  );
  assert.ok(r.totals.js >= 1);
  assert.ok(r.totals.python >= 1);
  assert.ok(r.totals.java >= 1);
});

test('buildStackTracesForFiles aggregates across batch', () => {
  const files = [
    { name: 'log1', extractedText: '    at f (a.js:1:1)' },
    { name: 'log2', extractedText: '  File "b.py", line 1, in g' },
  ];
  const r = buildStackTracesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderStackTracesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'log', extractedText: '    at f (a.js:1:1)' }];
  const r = buildStackTracesForFiles(files);
  const md = renderStackTracesBlock(r);
  assert.match(md, /^## STACK TRACE/);
});

test('renderStackTracesBlock empty when nothing surfaces', () => {
  assert.equal(renderStackTracesBlock({ perFile: [] }), '');
  assert.equal(renderStackTracesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildStackTracesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '    at f (a.js:1:1)' },
  ]);
  assert.equal(r.perFile.length, 1);
});
