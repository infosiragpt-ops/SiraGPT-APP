'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-tlds');
const { extractTlds, buildTldsForFiles, renderTldsBlock, _internal } = engine;
const { classifyTld, extractTldFromHost } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractTlds('').total, 0);
  assert.equal(extractTlds(null).total, 0);
});

test('classifyTld: known buckets', () => {
  assert.equal(classifyTld('com'), 'generic');
  assert.equal(classifyTld('gov'), 'sponsored');
  assert.equal(classifyTld('io'), 'new-gtld');
  assert.equal(classifyTld('us'), 'country');
  assert.equal(classifyTld('zzz'), 'other');
});

test('extractTldFromHost: returns last segment', () => {
  assert.equal(extractTldFromHost('example.com'), 'com');
  assert.equal(extractTldFromHost('foo.bar.io'), 'io');
  assert.equal(extractTldFromHost('localhost'), null);
});

test('counts .com TLDs', () => {
  const r = extractTlds('Visit example.com and otherexample.com today.');
  assert.ok(r.entries.some((e) => e.tld === 'com' && e.count >= 2));
});

test('counts .gov as sponsored', () => {
  const r = extractTlds('See whitehouse.gov for details.');
  assert.ok(r.entries.some((e) => e.tld === 'gov' && e.kind === 'sponsored'));
});

test('counts .io as new-gtld', () => {
  const r = extractTlds('We use openai.io for hosting.');
  assert.ok(r.entries.some((e) => e.tld === 'io' && e.kind === 'new-gtld'));
});

test('counts ccTLDs (.uk, .de)', () => {
  const r = extractTlds('See example.uk and another-site.de today.');
  assert.ok(r.entries.some((e) => e.kind === 'country'));
});

test('dedupes by hostname', () => {
  const r = extractTlds('example.com here. example.com again. Same host.');
  // Same host counts once
  const com = r.entries.find((e) => e.tld === 'com');
  assert.ok(com);
  assert.equal(com.count, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `example${i}.zzz `;
  const r = extractTlds(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by kind', () => {
  const r = extractTlds(
    'a.com and b.io and c.gov and d.us and e.app'
  );
  assert.ok(r.totals.generic >= 1);
  assert.ok(r.totals['new-gtld'] >= 1);
  assert.ok(r.totals.sponsored >= 1);
});

test('buildTldsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'example.com' },
    { name: 'b.md', extractedText: 'openai.io' },
  ];
  const r = buildTldsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('aggregate has cross-file totals', () => {
  const files = [
    { name: 'a.md', extractedText: 'first.com second.com third.com' },
    { name: 'b.md', extractedText: 'fourth.io fifth.io' },
  ];
  const r = buildTldsForFiles(files);
  const com = r.aggregate.find((e) => e.tld === 'com');
  assert.equal(com.count, 3);
});

test('renderTldsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'example.com' }];
  const r = buildTldsForFiles(files);
  const md = renderTldsBlock(r);
  assert.match(md, /^## TOP-LEVEL DOMAIN/);
});

test('renderTldsBlock empty when nothing surfaces', () => {
  assert.equal(renderTldsBlock({ perFile: [] }), '');
  assert.equal(renderTldsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildTldsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'example.com' },
  ]);
  assert.equal(r.perFile.length, 1);
});
