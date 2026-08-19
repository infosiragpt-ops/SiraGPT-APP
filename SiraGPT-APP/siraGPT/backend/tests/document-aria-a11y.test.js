'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-aria-a11y');
const { extractAriaA11y, buildAriaA11yForFiles, renderAriaA11yBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractAriaA11y('').total, 0);
  assert.equal(extractAriaA11y(null).total, 0);
});

test('detects role="button"', () => {
  const r = extractAriaA11y('<div role="button">Click</div>');
  assert.ok(r.entries.some((e) => e.kind === 'role' && e.name === 'button'));
});

test('detects role="navigation"', () => {
  const r = extractAriaA11y('<nav role="navigation">');
  assert.ok(r.entries.some((e) => e.kind === 'role' && e.name === 'navigation'));
});

test('rejects invalid roles', () => {
  const r = extractAriaA11y('<div role="fake-role">');
  assert.equal(r.entries.filter((e) => e.kind === 'role').length, 0);
});

test('detects aria-label="…"', () => {
  const r = extractAriaA11y('<button aria-label="Close modal">×</button>');
  assert.ok(r.entries.some((e) => e.name === 'aria-label' && /Close modal/.test(e.value)));
});

test('detects aria-labelledby', () => {
  const r = extractAriaA11y('<input aria-labelledby="user-id-label" />');
  assert.ok(r.entries.some((e) => e.name === 'aria-labelledby'));
});

test('detects aria-describedby', () => {
  const r = extractAriaA11y('<input aria-describedby="hint-text">');
  assert.ok(r.entries.some((e) => e.name === 'aria-describedby'));
});

test('detects aria-hidden', () => {
  const r = extractAriaA11y('<svg aria-hidden="true" />');
  assert.ok(r.entries.some((e) => e.name === 'aria-hidden'));
});

test('detects alt text on img', () => {
  const r = extractAriaA11y('<img src="x.png" alt="Logo of the company" />');
  assert.ok(r.entries.some((e) => e.kind === 'alt' && /Logo/.test(e.value)));
});

test('detects empty alt="" (decorative)', () => {
  const r = extractAriaA11y('<img src="x.png" alt="" />');
  assert.ok(r.entries.some((e) => e.kind === 'alt' && e.value === '(empty)'));
});

test('detects tabindex="-1"', () => {
  const r = extractAriaA11y('<div tabindex="-1">');
  assert.ok(r.entries.some((e) => e.kind === 'tabindex' && e.value === '-1'));
});

test('detects JSX tabIndex={0}', () => {
  const r = extractAriaA11y('<div tabIndex={0}>');
  assert.ok(r.entries.some((e) => e.kind === 'tabindex' && e.value === '0'));
});

test('dedupes identical entries', () => {
  const r = extractAriaA11y('<a role="button">x</a><a role="button">y</a>');
  assert.equal(r.entries.filter((e) => e.kind === 'role' && e.name === 'button').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `<button aria-label="Action ${i}">x</button>\n`;
  const r = extractAriaA11y(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by kind', () => {
  const r = extractAriaA11y('<div role="button" aria-label="x" tabindex="0"><img alt="y" /></div>');
  assert.ok(r.totals.role >= 1);
  assert.ok(r.totals.aria >= 1);
  assert.ok(r.totals.alt >= 1);
  assert.ok(r.totals.tabindex >= 1);
});

test('buildAriaA11yForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.html', extractedText: '<div role="button">x</div>' },
    { name: 'b.html', extractedText: '<img alt="y" />' },
  ];
  const r = buildAriaA11yForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderAriaA11yBlock returns markdown when entries exist', () => {
  const files = [{ name: 'a.html', extractedText: '<div role="button">x</div>' }];
  const r = buildAriaA11yForFiles(files);
  const md = renderAriaA11yBlock(r);
  assert.match(md, /^## ACCESSIBILITY/);
});

test('renderAriaA11yBlock empty when nothing surfaces', () => {
  assert.equal(renderAriaA11yBlock({ perFile: [] }), '');
  assert.equal(renderAriaA11yBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildAriaA11yForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '<div role="button">x</div>' },
  ]);
  assert.equal(r.perFile.length, 1);
});
