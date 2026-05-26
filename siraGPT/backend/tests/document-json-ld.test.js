'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-json-ld');
const { extractJsonLd, buildJsonLdForFiles, renderJsonLdBlock, _internal } = engine;
const { isJsonLdLike, previewValue } = _internal;

const JSONLD_FIXTURE = `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Article",
  "@id": "https://example.com/article/1",
  "headline": "Breaking news",
  "datePublished": "2026-05-14",
  "author": { "@type": "Person", "name": "Alice" },
  "publisher": { "@type": "Organization", "name": "ACME" },
  "image": "https://example.com/img.jpg"
}
</script>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "Product", "name": "Widget", "price": 9.99, "priceCurrency": "USD" },
    { "@type": "BreadcrumbList", "itemListElement": [] }
  ]
}
</script>`;

test('empty / non-string tolerated', () => {
  assert.equal(extractJsonLd('').total, 0);
  assert.equal(extractJsonLd(null).total, 0);
});

test('non-JSON-LD text returns empty', () => {
  const r = extractJsonLd('Just regular HTML with no LD markers');
  assert.equal(r.total, 0);
});

test('isJsonLdLike heuristic', () => {
  assert.ok(isJsonLdLike('{"@type": "Article"}'));
  assert.ok(isJsonLdLike('application/ld+json'));
  assert.ok(!isJsonLdLike('plain text'));
});

test('previewValue truncates long', () => {
  assert.equal(previewValue('short'), 'short');
  const long = 'x'.repeat(60);
  assert.ok(previewValue(long).includes('…'));
});

test('detects @context', () => {
  const r = extractJsonLd(JSONLD_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'context'));
});

test('detects @type values', () => {
  const r = extractJsonLd(JSONLD_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'type' && e.name === 'Article'));
  assert.ok(r.entries.some((e) => e.kind === 'type' && e.name === 'Person'));
  assert.ok(r.entries.some((e) => e.kind === 'type' && e.name === 'Organization'));
  assert.ok(r.entries.some((e) => e.kind === 'type' && e.name === 'Product'));
});

test('detects @id', () => {
  const r = extractJsonLd(JSONLD_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'id'));
});

test('detects @graph arrays', () => {
  const r = extractJsonLd(JSONLD_FIXTURE);
  assert.ok(r.totals.graph >= 1);
  assert.ok(r.entries.some((e) => e.kind === 'graph'));
});

test('counts script type=application/ld+json tags', () => {
  const r = extractJsonLd(JSONLD_FIXTURE);
  assert.ok(r.totals.scriptTag >= 2);
});

test('detects schema.org properties', () => {
  const r = extractJsonLd(JSONLD_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'property' && e.name === 'headline'));
  assert.ok(r.entries.some((e) => e.kind === 'property' && e.name === 'datePublished'));
  assert.ok(r.entries.some((e) => e.kind === 'property' && e.name === 'author'));
});

test('detects price/currency on Product', () => {
  const r = extractJsonLd(JSONLD_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'property' && e.name === 'price'));
  assert.ok(r.entries.some((e) => e.kind === 'property' && e.name === 'priceCurrency'));
});

test('dedupes identical types', () => {
  const r = extractJsonLd('"@type": "Person" "@type": "Person"');
  assert.equal(r.entries.filter((e) => e.kind === 'type' && e.name === 'Person').length, 1);
});

test('caps entries per file', () => {
  let text = '"@context": "https://schema.org" ';
  const types = ['Person', 'Organization', 'Product', 'Article', 'Event', 'Recipe', 'Place', 'Book', 'Movie', 'Course', 'JobPosting', 'LocalBusiness', 'Review', 'Service', 'Action'];
  for (const t of types) text += `"@type": "${t}" `;
  const r = extractJsonLd(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractJsonLd(JSONLD_FIXTURE);
  assert.ok(r.totals.context >= 1);
  assert.ok(r.totals.type >= 3);
  assert.ok(r.totals.property >= 3);
});

test('buildJsonLdForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.html', extractedText: '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article"}</script>' },
    { name: 'b.html', extractedText: '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product"}</script>' },
  ];
  const r = buildJsonLdForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderJsonLdBlock returns markdown when entries exist', () => {
  const files = [{ name: 'page.html', extractedText: JSONLD_FIXTURE }];
  const r = buildJsonLdForFiles(files);
  const md = renderJsonLdBlock(r);
  assert.match(md, /^## JSON-LD/);
});

test('renderJsonLdBlock empty when nothing surfaces', () => {
  assert.equal(renderJsonLdBlock({ perFile: [] }), '');
  assert.equal(renderJsonLdBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildJsonLdForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: JSONLD_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
