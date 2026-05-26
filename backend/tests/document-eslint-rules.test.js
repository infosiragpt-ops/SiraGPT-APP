'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-eslint-rules');
const { extractEslintRules, buildEslintRulesForFiles, renderEslintRulesBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractEslintRules('').total, 0);
  assert.equal(extractEslintRules(null).total, 0);
});

test('detects eslint-disable-next-line', () => {
  const r = extractEslintRules('// eslint-disable-next-line no-unused-vars');
  assert.ok(r.entries.some((e) => e.rule === 'no-unused-vars' && e.kind === 'disableNext'));
});

test('detects eslint-disable-line', () => {
  const r = extractEslintRules('let x = 1; // eslint-disable-line prefer-const');
  assert.ok(r.entries.some((e) => e.kind === 'disableLine'));
});

test('detects block disable', () => {
  const r = extractEslintRules('/* eslint-disable no-console */');
  assert.ok(r.entries.some((e) => e.kind === 'disableBlock'));
});

test('detects @typescript-eslint scoped rule', () => {
  const r = extractEslintRules('// eslint-disable-next-line @typescript-eslint/no-explicit-any');
  assert.ok(r.entries.some((e) => /no-explicit-any/.test(e.rule)));
});

test('detects rule config severity "error"', () => {
  const r = extractEslintRules('"no-unused-vars": "error"');
  assert.ok(r.entries.some((e) => e.kind === 'config' && e.severity === 'error'));
});

test('detects numeric severity 2 = error', () => {
  const r = extractEslintRules('"no-console": 2');
  assert.ok(r.entries.some((e) => e.severity === 'error'));
});

test('detects array config form', () => {
  const r = extractEslintRules('"max-len": ["error", 120]');
  assert.ok(r.entries.some((e) => e.severity === 'array'));
});

test('detects biome ignore', () => {
  const r = extractEslintRules('// biome-ignore lint/style/noVar');
  assert.ok(r.entries.some((e) => e.kind === 'biome'));
});

test('detects prettier-ignore', () => {
  const r = extractEslintRules('// prettier-ignore');
  assert.ok(r.entries.some((e) => e.kind === 'prettier'));
});

test('rejects reserved config keys', () => {
  const r = extractEslintRules('"extends": "eslint:recommended"');
  assert.equal(r.entries.filter((e) => e.rule === 'extends').length, 0);
});

test('dedupes identical entries', () => {
  const r = extractEslintRules('// eslint-disable-next-line no-unused-vars\n// eslint-disable-next-line no-unused-vars');
  assert.equal(r.entries.filter((e) => e.rule === 'no-unused-vars' && e.kind === 'disableNext').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `// eslint-disable-next-line rule-${i}-a\n`;
  const r = extractEslintRules(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractEslintRules(`
    // eslint-disable-next-line no-foo
    // biome-ignore lint/style/noVar
    "no-console": "error"
  `);
  assert.ok(r.totals.disableNext >= 1);
  assert.ok(r.totals.biome >= 1);
  assert.ok(r.totals.config >= 1);
});

test('buildEslintRulesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.js', extractedText: '// eslint-disable-next-line no-unused-vars' },
    { name: 'b.js', extractedText: '// eslint-disable-next-line no-console' },
  ];
  const r = buildEslintRulesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderEslintRulesBlock returns markdown when entries exist', () => {
  const files = [{ name: '.eslintrc', extractedText: '"no-unused-vars": "error"' }];
  const r = buildEslintRulesForFiles(files);
  const md = renderEslintRulesBlock(r);
  assert.match(md, /^## ESLINT/);
});

test('renderEslintRulesBlock empty when nothing surfaces', () => {
  assert.equal(renderEslintRulesBlock({ perFile: [] }), '');
  assert.equal(renderEslintRulesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildEslintRulesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '// eslint-disable-next-line no-unused-vars' },
  ]);
  assert.equal(r.perFile.length, 1);
});
