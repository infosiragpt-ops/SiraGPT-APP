'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-images');
const { extractImages, buildImagesForFiles, renderImagesBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractImages('').total, 0);
  assert.equal(extractImages(null).total, 0);
});

test('detects markdown image with alt', () => {
  const r = extractImages('![A nice cat](https://example.com/cat.jpg)');
  assert.ok(r.images.some((i) => i.kind === 'md' && /nice cat/.test(i.alt)));
});

test('detects markdown image with empty alt (decorative)', () => {
  const r = extractImages('![](https://example.com/img.png)');
  assert.ok(r.images.some((i) => i.hasAlt === false));
});

test('detects markdown reference-style image', () => {
  const r = extractImages('![alt text][ref1]');
  assert.ok(r.images.some((i) => i.kind === 'md'));
});

test('detects HTML img with alt', () => {
  const r = extractImages('<img src="foo.png" alt="logo">');
  assert.ok(r.images.some((i) => i.kind === 'html' && /logo/.test(i.alt)));
});

test('detects HTML img without alt', () => {
  const r = extractImages('<img src="foo.png">');
  assert.ok(r.images.some((i) => i.kind === 'html' && !i.hasAlt));
});

test('detects emoji shortcode', () => {
  const r = extractImages('Great work :tada: shipping today');
  assert.ok(r.images.some((i) => i.kind === 'emoji' && /tada/.test(i.alt)));
});

test('dedupes identical images', () => {
  const r = extractImages('![a](x.png) and again ![a](x.png)');
  assert.equal(r.images.filter((i) => /x\.png/.test(i.src)).length, 1);
});

test('counts totals withAlt vs missingAlt', () => {
  const r = extractImages('![alt](a.png)\n![](b.png)\n<img src="c.png">');
  assert.ok(r.totals.withAlt >= 1);
  assert.ok(r.totals.missingAlt >= 2);
});

test('caps images per file', () => {
  let text = '';
  for (let i = 0; i < 40; i++) text += `![alt${i}](img${i}.png) `;
  const r = extractImages(text);
  assert.ok(r.images.length <= 24);
});

test('buildImagesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '![alt](a.png)' },
    { name: 'b.md', extractedText: '<img src="b.png" alt="b">' },
  ];
  const r = buildImagesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderImagesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: '![alt](a.png)' }];
  const r = buildImagesForFiles(files);
  const md = renderImagesBlock(r);
  assert.match(md, /^## IMAGES/);
});

test('renderImagesBlock shows accessibility flag', () => {
  const files = [{ name: 'doc.md', extractedText: '![](no-alt.png)' }];
  const r = buildImagesForFiles(files);
  const md = renderImagesBlock(r);
  assert.match(md, /no-alt/);
});

test('renderImagesBlock empty when nothing surfaces', () => {
  assert.equal(renderImagesBlock({ perFile: [] }), '');
  assert.equal(renderImagesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildImagesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '![alt](a.png)' },
  ]);
  assert.equal(r.perFile.length, 1);
});
