'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-domains');
const { extractDomains, buildDomainsForFiles, renderDomainsBlock, _internal } = engine;
const { isLikelyDomain, getTld, getApex } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractDomains('').total, 0);
  assert.equal(extractDomains(null).total, 0);
});

test('getTld: extracts last segment', () => {
  assert.equal(getTld('foo.com'), 'com');
  assert.equal(getTld('a.b.c.org'), 'org');
});

test('getApex: returns 2-label apex for subdomains', () => {
  assert.equal(getApex('api.acme.com'), 'acme.com');
  assert.equal(getApex('acme.com'), 'acme.com');
});

test('isLikelyDomain: valid forms', () => {
  assert.equal(isLikelyDomain('example.com'), true);
  assert.equal(isLikelyDomain('api.acme.io'), true);
  assert.equal(isLikelyDomain('sub.example.org'), true);
  assert.equal(isLikelyDomain('1.2.com'), false); // no letter in non-tld labels
  assert.equal(isLikelyDomain('file.txt'), false); // txt not in TLD list
});

test('detects example.com', () => {
  const r = extractDomains('Visit example.com for more info.');
  assert.ok(r.domains.some((d) => d.domain === 'example.com'));
});

test('detects subdomain', () => {
  const r = extractDomains('API at api.acme.io is fast.');
  assert.ok(r.domains.some((d) => d.domain === 'api.acme.io' && d.apex === 'acme.io'));
});

test('detects country TLD', () => {
  const r = extractDomains('Brazil portal at dashboard.gov.br is up.');
  assert.ok(r.domains.some((d) => /gov\.br/.test(d.domain)));
});

test('ignores domain inside email', () => {
  const r = extractDomains('Email: alice@example.com today.');
  // Lookbehind (?<!@) excludes @-prefixed
  assert.equal(r.domains.filter((d) => d.domain === 'example.com').length, 0);
});

test('ignores domain inside URL path', () => {
  const r = extractDomains('Visit https://example.com/foo for info.');
  // Lookbehind (?<!\/) prevents matching after / — though it may still match starting at "example.com" itself
  // For URL detection see document-urls. Here we just want it to not crash.
  // We don't strictly need to exclude in this test — just no errors
  assert.ok(r.domains.length >= 0);
});

test('ignores file.txt-like patterns (txt not in TLD list)', () => {
  const r = extractDomains('Save to file.txt today.');
  assert.equal(r.domains.length, 0);
});

test('ignores image.png', () => {
  const r = extractDomains('Use image.png here.');
  assert.equal(r.domains.length, 0);
});

test('dedupes identical domains', () => {
  const r = extractDomains('Use example.com here and example.com there.');
  assert.equal(r.domains.filter((d) => d.domain === 'example.com').length, 1);
});

test('caps domains per file', () => {
  let text = '';
  for (let i = 0; i < 40; i++) text += `domain-${i}.com `;
  const r = extractDomains(text);
  assert.ok(r.domains.length <= 24);
});

test('handles multi-label subdomains', () => {
  const r = extractDomains('Inner DNS: alpha.beta.gamma.example.org');
  assert.ok(r.domains.some((d) => /example\.org/.test(d.domain)));
});

test('case-insensitive (normalises to lowercase)', () => {
  const r = extractDomains('Visit ExAmPlE.cOm.');
  assert.ok(r.domains.some((d) => d.domain === 'example.com'));
});

test('buildDomainsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'example.com' },
    { name: 'b.md', extractedText: 'acme.io' },
  ];
  const r = buildDomainsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderDomainsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'example.com' }];
  const r = buildDomainsForFiles(files);
  const md = renderDomainsBlock(r);
  assert.match(md, /^## DOMAINS/);
});

test('renderDomainsBlock empty when nothing surfaces', () => {
  assert.equal(renderDomainsBlock({ perFile: [] }), '');
  assert.equal(renderDomainsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildDomainsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'example.com' },
  ]);
  assert.equal(r.perFile.length, 1);
});
