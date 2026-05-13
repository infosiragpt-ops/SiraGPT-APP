'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-code-defs');
const { extractCodeDefs, buildCodeDefsForFiles, renderCodeDefsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractCodeDefs('').total, 0);
  assert.equal(extractCodeDefs(null).total, 0);
});

test('detects JS function declaration', () => {
  const r = extractCodeDefs('function calculateTotal() { ... }');
  assert.ok(r.defs.some((d) => d.kind === 'function' && d.name === 'calculateTotal'));
});

test('detects JS const arrow function', () => {
  const r = extractCodeDefs('const handleClick = () => doStuff()');
  assert.ok(r.defs.some((d) => d.name === 'handleClick'));
});

test('detects Python def', () => {
  const r = extractCodeDefs('def process_data(items):');
  assert.ok(r.defs.some((d) => d.kind === 'function' && d.name === 'process_data'));
});

test('detects Python class', () => {
  const r = extractCodeDefs('class UserRepository:');
  assert.ok(r.defs.some((d) => d.kind === 'class' && d.name === 'UserRepository'));
});

test('detects JS class', () => {
  const r = extractCodeDefs('class OrderService {');
  assert.ok(r.defs.some((d) => d.kind === 'class'));
});

test('detects TS interface', () => {
  const r = extractCodeDefs('interface UserProfile {');
  assert.ok(r.defs.some((d) => d.kind === 'type' && d.name === 'UserProfile'));
});

test('detects TS type alias', () => {
  const r = extractCodeDefs('type Status = "active" | "inactive"');
  assert.ok(r.defs.some((d) => d.kind === 'type'));
});

test('detects Go func', () => {
  const r = extractCodeDefs('func Process(items []Item) error {');
  assert.ok(r.defs.some((d) => d.kind === 'function'));
});

test('detects Go struct type', () => {
  const r = extractCodeDefs('type User struct {');
  assert.ok(r.defs.some((d) => d.kind === 'type'));
});

test('detects Rust fn', () => {
  const r = extractCodeDefs('fn parse_input(input: &str) {');
  assert.ok(r.defs.some((d) => d.kind === 'function'));
});

test('detects Rust struct / trait', () => {
  const r = extractCodeDefs('struct UserData { }\ntrait Handler {');
  assert.ok(r.defs.filter((d) => d.kind === 'type').length >= 2);
});

test('dedupes identical names within same lang+kind', () => {
  const r = extractCodeDefs('function foo() {}\nfunction foo() {}');
  assert.equal(r.defs.filter((d) => d.name === 'foo' && d.kind === 'function').length, 1);
});

test('caps per kind', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `function func${i}() {} `;
  const r = extractCodeDefs(text);
  assert.ok(r.byKind.function <= 12);
});

test('rejects reserved keywords', () => {
  const r = extractCodeDefs('class return {} function this() {}');
  assert.equal(r.defs.filter((d) => d.name === 'return' || d.name === 'this').length, 0);
});

test('buildCodeDefsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'function foo() {}' },
    { name: 'b.md', extractedText: 'def bar():' },
  ];
  const r = buildCodeDefsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCodeDefsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'function foo() {}' }];
  const r = buildCodeDefsForFiles(files);
  const md = renderCodeDefsBlock(r);
  assert.match(md, /^## CODE DEFINITIONS/);
});

test('renderCodeDefsBlock empty when nothing surfaces', () => {
  assert.equal(renderCodeDefsBlock({ perFile: [] }), '');
  assert.equal(renderCodeDefsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildCodeDefsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'function foo() {}' },
  ]);
  assert.equal(r.perFile.length, 1);
});
