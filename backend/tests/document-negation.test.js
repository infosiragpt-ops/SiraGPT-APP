'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-negation');
const { extractNegation, buildNegationForFiles, renderNegationBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractNegation('').negationCount, 0);
  assert.equal(extractNegation(null).negationCount, 0);
});

test('counts negations', () => {
  const text = 'We do not allow this. There is no way to bypass. Never share credentials. Not allowed under any circumstances or terms.'.repeat(2);
  const r = extractNegation(text);
  assert.ok(r.negationCount >= 4);
});

test('detects Spanish negations', () => {
  const text = 'No permitimos esto. Nunca compartir credenciales. Ningún acceso adicional. Ni se debe acceder sin autorización válida o sin permiso.'.repeat(2);
  const r = extractNegation(text);
  assert.ok(r.negationCount >= 3);
});

test('detects contractions', () => {
  const text = "We don't allow this. We won't share. Users can't access without auth. It isn't ready yet for the public release we have planned today.".repeat(2);
  const r = extractNegation(text);
  assert.ok(r.negationCount >= 4);
});

test('detects double negative pattern', () => {
  const text = 'We have not got nothing to hide here today.'.repeat(2);
  const r = extractNegation(text);
  assert.ok(r.doubleNegatives >= 1);
});

test('density reported per 1000 words', () => {
  const text = ('not no never nothing nobody '.repeat(10) + 'word '.repeat(50));
  const r = extractNegation(text);
  assert.ok(r.density > 0);
});

test('returns zero when too few words', () => {
  const r = extractNegation('Brief.');
  assert.equal(r.negationCount, 0);
});

test('buildNegationForFiles aggregates per file', () => {
  const text = 'We do not allow this. There is no way to bypass. Never share credentials. Not allowed under any circumstances.'.repeat(3);
  const files = [
    { name: 'a.md', extractedText: text },
    { name: 'b.md', extractedText: text },
  ];
  const r = buildNegationForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderNegationBlock returns markdown when entries exist', () => {
  const text = 'We do not allow this. There is no way to bypass. Never share credentials.'.repeat(3);
  const files = [{ name: 'doc.md', extractedText: text }];
  const r = buildNegationForFiles(files);
  const md = renderNegationBlock(r);
  assert.match(md, /^## NEGATION DENSITY/);
});

test('renderNegationBlock empty when nothing surfaces', () => {
  assert.equal(renderNegationBlock({ perFile: [] }), '');
  assert.equal(renderNegationBlock(null), '');
});

test('handles non-string extractedText', () => {
  const text = 'We do not allow this. There is no way to bypass. Never share credentials.'.repeat(3);
  const r = buildNegationForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: text },
  ]);
  assert.equal(r.perFile.length, 1);
});
