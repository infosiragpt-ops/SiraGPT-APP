'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-browser-support');
const { extractBrowserSupport, buildBrowserSupportForFiles, renderBrowserSupportBlock, _internal } = engine;
const { classifyBrowser } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractBrowserSupport('').total, 0);
  assert.equal(extractBrowserSupport(null).total, 0);
});

test('classifyBrowser: Safari -> apple', () => {
  assert.equal(classifyBrowser('Safari'), 'apple');
  assert.equal(classifyBrowser('Chrome'), 'desktop');
  assert.equal(classifyBrowser('Node.js'), 'runtime');
});

test('detects "Chrome 100+"', () => {
  const r = extractBrowserSupport('Requires Chrome 100+');
  assert.ok(r.entries.some((e) => e.browser === 'Chrome' && e.version === '100' && e.lowerBound));
});

test('detects "Safari 16"', () => {
  const r = extractBrowserSupport('Available in Safari 16 and later');
  assert.ok(r.entries.some((e) => e.browser === 'Safari'));
});

test('detects "Firefox 119"', () => {
  const r = extractBrowserSupport('Tested on Firefox 119');
  assert.ok(r.entries.some((e) => e.browser === 'Firefox'));
});

test('detects "Edge 119"', () => {
  const r = extractBrowserSupport('Edge 119 supports this');
  assert.ok(r.entries.some((e) => e.browser === 'Edge'));
});

test('detects "iOS 17+"', () => {
  const r = extractBrowserSupport('Requires iOS 17+');
  assert.ok(r.entries.some((e) => e.family === 'apple'));
});

test('detects "Node.js 20"', () => {
  const r = extractBrowserSupport('Built for Node.js 20');
  assert.ok(r.entries.some((e) => e.family === 'runtime'));
});

test('detects caniuse URL', () => {
  const r = extractBrowserSupport('Check caniuse.com/css-grid');
  assert.ok(r.entries.some((e) => e.browser === 'caniuse'));
});

test('captures lowerBound flag', () => {
  const r = extractBrowserSupport('Chrome 90+');
  const entry = r.entries.find((e) => e.browser === 'Chrome');
  assert.equal(entry.lowerBound, true);
});

test('dedupes identical entries', () => {
  const r = extractBrowserSupport('Chrome 100+ and Chrome 100+ again');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  const browsers = ['Chrome', 'Firefox', 'Safari', 'Edge', 'Opera', 'Vivaldi', 'iOS', 'Android'];
  for (let i = 0; i < 20; i++) text += `${browsers[i % browsers.length]} ${100 + i}+ `;
  const r = extractBrowserSupport(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by family', () => {
  const r = extractBrowserSupport('Chrome 100, Safari 16, iOS 17, Node.js 20');
  assert.ok(r.totals.desktop >= 1);
  assert.ok(r.totals.apple >= 1);
  assert.ok(r.totals.runtime >= 1);
});

test('buildBrowserSupportForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'Chrome 100+' },
    { name: 'b', extractedText: 'Safari 16+' },
  ];
  const r = buildBrowserSupportForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderBrowserSupportBlock returns markdown when entries exist', () => {
  const files = [{ name: 'compat.md', extractedText: 'Chrome 100+' }];
  const r = buildBrowserSupportForFiles(files);
  const md = renderBrowserSupportBlock(r);
  assert.match(md, /^## BROWSER/);
});

test('renderBrowserSupportBlock empty when nothing surfaces', () => {
  assert.equal(renderBrowserSupportBlock({ perFile: [] }), '');
  assert.equal(renderBrowserSupportBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildBrowserSupportForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Chrome 100+' },
  ]);
  assert.equal(r.perFile.length, 1);
});
