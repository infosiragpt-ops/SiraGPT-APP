'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-html-attrs');
const { extractHtmlAttrs, buildHtmlAttrsForFiles, renderHtmlAttrsBlock, _internal } = engine;
const { isLikelyHtmlAttr } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractHtmlAttrs('').total, 0);
  assert.equal(extractHtmlAttrs(null).total, 0);
});

test('isLikelyHtmlAttr: known attrs', () => {
  assert.equal(isLikelyHtmlAttr('rel'), true);
  assert.equal(isLikelyHtmlAttr('href'), true);
  assert.equal(isLikelyHtmlAttr('aria-label'), true);
  assert.equal(isLikelyHtmlAttr('data-foo'), true);
  assert.equal(isLikelyHtmlAttr('onclick'), true);
  assert.equal(isLikelyHtmlAttr('xyzunknown'), false);
});

test('detects rel="noopener"', () => {
  const r = extractHtmlAttrs('Use rel="noopener" on external links.');
  assert.ok(r.attrs.some((a) => a.name === 'rel' && a.value === 'noopener'));
});

test('detects target="_blank"', () => {
  const r = extractHtmlAttrs('Set target="_blank" for popups.');
  assert.ok(r.attrs.some((a) => a.name === 'target'));
});

test('detects sandbox attribute', () => {
  const r = extractHtmlAttrs('Embed via sandbox="allow-scripts".');
  assert.ok(r.attrs.some((a) => a.name === 'sandbox'));
});

test('detects "the rel attribute" labeled', () => {
  const r = extractHtmlAttrs('The rel attribute should be set.');
  assert.ok(r.attrs.some((a) => a.kind === 'labeled' && a.name === 'rel'));
});

test('detects aria-label', () => {
  const r = extractHtmlAttrs('Use aria-label for screen readers.');
  assert.ok(r.attrs.some((a) => a.name === 'aria-label'));
});

test('detects data-* attribute', () => {
  const r = extractHtmlAttrs('Add data-track-id to elements.');
  assert.ok(r.attrs.some((a) => /data-track-id/.test(a.name)));
});

test('detects event handler onclick', () => {
  const r = extractHtmlAttrs('Avoid inline onclick="..." handlers.');
  assert.ok(r.attrs.some((a) => a.name === 'onclick'));
});

test('rejects random non-HTML "attribute"', () => {
  const r = extractHtmlAttrs('The xyzunknown attribute should be ignored.');
  assert.equal(r.attrs.length, 0);
});

test('dedupes identical entries', () => {
  const r = extractHtmlAttrs('rel="noopener" here and rel="noopener" there.');
  assert.equal(r.attrs.filter((a) => a.name === 'rel' && a.value === 'noopener').length, 1);
});

test('caps attrs per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `data-x${i}="v${i}" `;
  const r = extractHtmlAttrs(text);
  assert.ok(r.attrs.length <= 24);
});

test('counts totals by kind', () => {
  const r = extractHtmlAttrs('rel="noopener" and "the target attribute" and aria-label');
  assert.ok(r.totals['with-value'] >= 1);
  assert.ok(r.totals.labeled >= 1);
  assert.ok(r.totals['aria-data'] >= 1);
});

test('buildHtmlAttrsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'rel="noopener"' },
    { name: 'b.md', extractedText: 'aria-label' },
  ];
  const r = buildHtmlAttrsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderHtmlAttrsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'rel="noopener"' }];
  const r = buildHtmlAttrsForFiles(files);
  const md = renderHtmlAttrsBlock(r);
  assert.match(md, /^## HTML ATTRIBUTES/);
});

test('renderHtmlAttrsBlock empty when nothing surfaces', () => {
  assert.equal(renderHtmlAttrsBlock({ perFile: [] }), '');
  assert.equal(renderHtmlAttrsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildHtmlAttrsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'rel="noopener"' },
  ]);
  assert.equal(r.perFile.length, 1);
});
