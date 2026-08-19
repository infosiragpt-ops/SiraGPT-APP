'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-url-extractor');
const { extractURLs, buildURLsForFiles, renderURLsBlock, _internal } = engine;
const { trimTrailingPunct } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractURLs('').total, 0);
  assert.equal(extractURLs(null).total, 0);
});

test('trimTrailingPunct removes trailing punctuation', () => {
  assert.equal(trimTrailingPunct('https://example.com.'), 'https://example.com');
  assert.equal(trimTrailingPunct('https://example.com,'), 'https://example.com');
  assert.equal(trimTrailingPunct('https://example.com)'), 'https://example.com');
});

test('detects plain HTTP / HTTPS URLs', () => {
  const text = 'See https://example.com for details. Also http://docs.example.org/path.';
  const r = extractURLs(text);
  assert.equal(r.urls.length, 2);
  assert.ok(r.urls.some((u) => u.url === 'https://example.com'));
  assert.ok(r.urls.some((u) => u.url === 'http://docs.example.org/path'));
});

test('detects markdown links and pulls anchor text', () => {
  const text = '[Acme docs](https://docs.acme.com/getting-started) explains the API.';
  const r = extractURLs(text);
  assert.ok(r.urls.some((u) => u.url === 'https://docs.acme.com/getting-started'));
  const md = r.urls.find((u) => u.kind === 'markdown');
  assert.ok(md.anchor && /Acme docs/.test(md.anchor));
});

test('dedupes the same URL across patterns', () => {
  const text = '[Site](https://example.com) and bare https://example.com link.';
  const r = extractURLs(text);
  assert.equal(r.urls.length, 1);
});

test('captures context snippet for plain URLs', () => {
  const text = 'For more details, visit https://example.com in your browser.';
  const r = extractURLs(text);
  const plain = r.urls.find((u) => u.kind === 'plain');
  assert.ok(plain.anchor && plain.anchor.length > 0);
});

test('caps URLs per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `https://example.com/${i} `;
  const r = extractURLs(text);
  assert.ok(r.urls.length <= 18);
});

test('handles URLs with ports / paths / fragments', () => {
  const text = 'API at https://api.example.com:8080/v1/users?id=123#anchor.';
  const r = extractURLs(text);
  assert.ok(r.urls.some((u) => /api.example.com:8080/.test(u.url)));
});

test('buildURLsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'See https://a.example.com' },
    { name: 'b.md', extractedText: 'Also https://b.example.com' },
  ];
  const r = buildURLsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderURLsBlock returns markdown when URLs exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'See https://example.com' }];
  const r = buildURLsForFiles(files);
  const md = renderURLsBlock(r);
  assert.match(md, /^## URLs & LINKS/);
});

test('renderURLsBlock empty when nothing surfaces', () => {
  assert.equal(renderURLsBlock({ perFile: [] }), '');
  assert.equal(renderURLsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildURLsForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'https://x.com' }]);
  assert.ok(Array.isArray(r.perFile));
});
