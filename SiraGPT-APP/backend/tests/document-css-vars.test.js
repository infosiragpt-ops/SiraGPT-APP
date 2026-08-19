'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-css-vars');
const { extractCssVars, buildCssVarsForFiles, renderCssVarsBlock, _internal } = engine;
const { classifyVar, previewValue } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractCssVars('').total, 0);
  assert.equal(extractCssVars(null).total, 0);
});

test('classifyVar: palette / size / font / radius / zIndex / shadow / motion / other', () => {
  assert.equal(classifyVar('--color-primary'), 'palette');
  assert.equal(classifyVar('--bg-card'), 'palette');
  assert.equal(classifyVar('--size-lg'), 'size');
  assert.equal(classifyVar('--space-4'), 'size');
  assert.equal(classifyVar('--font-mono'), 'font');
  assert.equal(classifyVar('--radius-md'), 'radius');
  assert.equal(classifyVar('--z-modal'), 'zIndex');
  assert.equal(classifyVar('--shadow-lg'), 'shadow');
  assert.equal(classifyVar('--transition-fast'), 'motion');
  assert.equal(classifyVar('--something-else'), 'other');
});

test('previewValue truncates long values', () => {
  assert.equal(previewValue('short'), 'short');
  const long = 'x'.repeat(50);
  assert.ok(previewValue(long).includes('…'));
});

test('detects --var: value declarations', () => {
  const r = extractCssVars(':root { --color-primary: #ff0000; --space-4: 1rem; }');
  assert.ok(r.entries.some((e) => e.name === '--color-primary'));
  assert.ok(r.entries.some((e) => e.name === '--space-4'));
});

test('detects var() references', () => {
  const r = extractCssVars('.btn { color: var(--color-primary); padding: var(--space-4); }');
  assert.ok(r.totals.references >= 2);
});

test('detects var() with fallback', () => {
  const r = extractCssVars('.box { color: var(--bg-card, #fff); }');
  const ref = r.entries.find((e) => e.kind === 'ref');
  assert.ok(ref);
  assert.ok(ref.value.startsWith('fallback:'));
});

test('detects @property declarations', () => {
  const r = extractCssVars('@property --my-prop { syntax: "<color>"; inherits: true; initial-value: red; }');
  assert.ok(r.entries.some((e) => e.kind === 'property' && e.name === '--my-prop'));
  assert.ok(r.totals.propertyAt >= 1);
});

test('classifies declarations by category', () => {
  const r = extractCssVars(':root { --color-x: red; --font-y: serif; --radius-z: 4px; }');
  assert.ok(r.totals.palette >= 1);
  assert.ok(r.totals.font >= 1);
  assert.ok(r.totals.radius >= 1);
});

test('dedupes identical var declarations', () => {
  const r = extractCssVars('--color-x: red; --color-x: blue;');
  assert.equal(r.entries.filter((e) => e.kind === 'decl' && e.name === '--color-x').length, 1);
});

test('caps entries per file', () => {
  let text = ':root {';
  for (let i = 0; i < 30; i++) text += ` --custom-${i}: ${i}px;`;
  text += '}';
  const r = extractCssVars(text);
  assert.ok(r.entries.length <= 22);
});

test('counts references separately from declarations', () => {
  const r = extractCssVars(':root { --x: 1; } .y { z: var(--x); w: var(--x); }');
  // 1 declaration, 1 unique reference (deduped)
  assert.equal(r.totals.references, 1);
});

test('buildCssVarsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.css', extractedText: ':root { --x: 1; }' },
    { name: 'b.css', extractedText: ':root { --y: 2; }' },
  ];
  const r = buildCssVarsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCssVarsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'theme.css', extractedText: ':root { --color-primary: #fff; }' }];
  const r = buildCssVarsForFiles(files);
  const md = renderCssVarsBlock(r);
  assert.match(md, /^## CSS CUSTOM PROPERTIES/);
});

test('renderCssVarsBlock empty when nothing surfaces', () => {
  assert.equal(renderCssVarsBlock({ perFile: [] }), '');
  assert.equal(renderCssVarsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildCssVarsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: ':root { --x: 1; }' },
  ]);
  assert.equal(r.perFile.length, 1);
});

test('value preview truncates long CSS values', () => {
  const r = extractCssVars(`:root { --grad: linear-gradient(${'x'.repeat(60)}); }`);
  const entry = r.entries.find((e) => e.name === '--grad');
  assert.ok(entry);
  assert.ok(entry.value.length < 40);
});
