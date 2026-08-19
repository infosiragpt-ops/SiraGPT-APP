'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-imperatives');
const { extractImperatives, buildImperativesForFiles, renderImperativesBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractImperatives('').total, 0);
  assert.equal(extractImperatives(null).total, 0);
});

test('detects "Install dependencies"', () => {
  const r = extractImperatives('Install dependencies before running');
  assert.ok(r.imperatives.some((i) => /install/i.test(i.text)));
});

test('detects numbered "1. Click Save"', () => {
  const r = extractImperatives('1. Click Save to commit\n2. Reload the page');
  assert.ok(r.imperatives.some((i) => /click/i.test(i.text)));
});

test('detects bulleted "- Edit config"', () => {
  const r = extractImperatives('- Edit config to enable feature\n- Restart server');
  assert.ok(r.imperatives.some((i) => /edit/i.test(i.text)));
});

test('detects "Run npm test"', () => {
  const r = extractImperatives('Run npm test to verify');
  assert.ok(r.imperatives.some((i) => /run/i.test(i.text)));
});

test('detects Spanish "Instale las dependencias"', () => {
  const r = extractImperatives('Instale las dependencias antes de correr');
  assert.ok(r.imperatives.some((i) => i.lang === 'es'));
});

test('detects Spanish "Ejecute"', () => {
  const r = extractImperatives('Ejecute la prueba unitaria');
  assert.ok(r.imperatives.some((i) => /ejecute/i.test(i.text)));
});

test('dedupes identical entries', () => {
  const r = extractImperatives('Install foo today\nInstall foo today');
  assert.equal(r.imperatives.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `Install package ${i} today\n`;
  const r = extractImperatives(text);
  assert.ok(r.imperatives.length <= 24);
});

test('buildImperativesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Install deps' },
    { name: 'b.md', extractedText: 'Run tests' },
  ];
  const r = buildImperativesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderImperativesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Install dependencies' }];
  const r = buildImperativesForFiles(files);
  const md = renderImperativesBlock(r);
  assert.match(md, /^## IMPERATIVES/);
});

test('renderImperativesBlock empty when nothing surfaces', () => {
  assert.equal(renderImperativesBlock({ perFile: [] }), '');
  assert.equal(renderImperativesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildImperativesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Install foo' },
  ]);
  assert.equal(r.perFile.length, 1);
});
