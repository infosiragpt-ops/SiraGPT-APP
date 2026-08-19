'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-md-ref-links');
const { extractMdRefLinks, buildMdRefLinksForFiles, renderMdRefLinksBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractMdRefLinks('').total, 0);
  assert.equal(extractMdRefLinks(null).total, 0);
});

test('detects reference link definition', () => {
  const r = extractMdRefLinks('[foo]: https://example.com');
  assert.ok(r.entries.some((e) => e.kind === 'def' && e.label === 'foo'));
});

test('detects link with title', () => {
  const r = extractMdRefLinks('[foo]: https://example.com "Example Site"');
  const entry = r.entries.find((e) => e.kind === 'def');
  assert.equal(entry.title, 'Example Site');
});

test('detects angle-bracket URL', () => {
  const r = extractMdRefLinks('[bar]: <https://example.com/path>');
  assert.ok(r.entries.some((e) => e.kind === 'def'));
});

test('detects footnote definition', () => {
  const r = extractMdRefLinks('[^1]: This is the footnote text.');
  assert.ok(r.entries.some((e) => e.kind === 'footnoteDef'));
});

test('detects in-text reference usage', () => {
  const r = extractMdRefLinks('See [the docs][foo] for details');
  assert.ok(r.entries.some((e) => e.kind === 'usage'));
});

test('detects footnote usage', () => {
  const r = extractMdRefLinks('This claim[^1] needs evidence.');
  assert.ok(r.entries.some((e) => e.kind === 'footnoteUsage'));
});

test('dedupes identical labels', () => {
  const r = extractMdRefLinks('[foo]: https://x\n[foo]: https://y');
  assert.equal(r.entries.filter((e) => e.kind === 'def' && e.label === 'foo').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `[ref${i}]: https://example.com/${i}\n`;
  const r = extractMdRefLinks(text);
  assert.ok(r.entries.length <= 20);
});

test('counts totals by kind', () => {
  const r = extractMdRefLinks(
    '[a]: https://x\n[^1]: note\n[link][a] and ref[^1]'
  );
  assert.ok(r.totals.def >= 1);
  assert.ok(r.totals.footnoteDef >= 1);
});

test('buildMdRefLinksForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '[foo]: https://example.com' },
    { name: 'b.md', extractedText: '[bar]: https://example.org' },
  ];
  const r = buildMdRefLinksForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderMdRefLinksBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: '[foo]: https://example.com' }];
  const r = buildMdRefLinksForFiles(files);
  const md = renderMdRefLinksBlock(r);
  assert.match(md, /^## MARKDOWN REFERENCE/);
});

test('renderMdRefLinksBlock empty when nothing surfaces', () => {
  assert.equal(renderMdRefLinksBlock({ perFile: [] }), '');
  assert.equal(renderMdRefLinksBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildMdRefLinksForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '[foo]: https://example.com' },
  ]);
  assert.equal(r.perFile.length, 1);
});
