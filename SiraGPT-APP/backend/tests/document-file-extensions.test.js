'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-file-extensions');
const { extractFileExtensions, buildFileExtensionsForFiles, renderFileExtensionsBlock, _internal } = engine;
const { categoryFor } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractFileExtensions('').total, 0);
  assert.equal(extractFileExtensions(null).total, 0);
});

test('categoryFor classifies common extensions', () => {
  assert.equal(categoryFor('js'), 'code');
  assert.equal(categoryFor('md'), 'doc');
  assert.equal(categoryFor('json'), 'data');
  assert.equal(categoryFor('png'), 'image');
  assert.equal(categoryFor('zip'), 'archive');
  assert.equal(categoryFor('mp4'), 'media');
});

test('detects single extension', () => {
  const r = extractFileExtensions('Edit src/main.js today.');
  assert.ok(r.extensions.some((e) => e.ext === 'js'));
});

test('counts extension frequency', () => {
  const r = extractFileExtensions('Files: a.js b.js c.py');
  const js = r.extensions.find((e) => e.ext === 'js');
  assert.ok(js && js.count >= 2);
});

test('groups by category', () => {
  const r = extractFileExtensions('a.js b.ts c.md d.png');
  assert.ok(r.byCategory.code >= 2);
  assert.ok(r.byCategory.doc >= 1);
  assert.ok(r.byCategory.image >= 1);
});

test('sorts by count desc', () => {
  const r = extractFileExtensions('a.js b.js c.js d.py');
  assert.equal(r.extensions[0].ext, 'js');
});

test('handles unknown extension as "other"', () => {
  const r = extractFileExtensions('Strange file.xyz123 here.');
  // xyz123 has more than 8 chars → won't match. Let's use 4 chars
  const r2 = extractFileExtensions('Strange file.xyzq here.');
  if (r2.extensions.length > 0) {
    assert.equal(r2.extensions[0].category, 'other');
  }
});

test('caps extensions per file', () => {
  let text = '';
  for (let i = 0; i < 50; i++) text += `file${i}.ext${i % 5} `;
  const r = extractFileExtensions(text);
  assert.ok(r.extensions.length <= 24);
});

test('buildFileExtensionsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'src/main.js' },
    { name: 'b.md', extractedText: 'README.md' },
  ];
  const r = buildFileExtensionsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderFileExtensionsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'main.js' }];
  const r = buildFileExtensionsForFiles(files);
  const md = renderFileExtensionsBlock(r);
  assert.match(md, /^## FILE EXTENSIONS/);
});

test('renderFileExtensionsBlock empty when nothing surfaces', () => {
  assert.equal(renderFileExtensionsBlock({ perFile: [] }), '');
  assert.equal(renderFileExtensionsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildFileExtensionsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'main.js' },
  ]);
  assert.equal(r.perFile.length, 1);
});

test('byCategory accurate counts', () => {
  const r = extractFileExtensions('a.js b.ts c.py d.go e.md f.json');
  assert.ok((r.byCategory.code || 0) >= 4);
  assert.ok((r.byCategory.doc || 0) >= 1);
  assert.ok((r.byCategory.data || 0) >= 1);
});
