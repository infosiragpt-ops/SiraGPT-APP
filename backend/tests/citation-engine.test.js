/**
 * Unit tests for services/citation-engine.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractCitations,
  renderAnnotated,
  buildCitationSystemBlock,
} = require('../src/services/citation-engine');

const CHUNKS = [
  { text: 'The pricing plan is $10 per month for the Pro tier.', title: 'pricing.md', source: 'pricing.md', score: 0.91 },
  { text: 'Refunds are processed within 30 days of purchase.', title: 'refunds.md', source: 'refunds.md', score: 0.85 },
  { text: 'Annual subscriptions save 20% versus monthly billing.', title: 'billing.md', source: 'billing.md', score: 0.80 },
];

test('buildCitationSystemBlock: numbers chunks starting at 1', () => {
  const block = buildCitationSystemBlock(CHUNKS);
  assert.ok(block.startsWith('SOURCES'));
  assert.ok(block.includes('[1] pricing.md'));
  assert.ok(block.includes('[2] refunds.md'));
  assert.ok(block.includes('[3] billing.md'));
  assert.ok(block.includes('Do not invent sources, DOIs, authors, URLs, or metrics'));
});

test('buildCitationSystemBlock: Spanish header when language=es', () => {
  const block = buildCitationSystemBlock(CHUNKS, { language: 'es' });
  assert.ok(block.startsWith('FUENTES'));
  assert.ok(block.includes('[Fuente: N]'));
  assert.ok(block.includes('No inventes fuentes, DOI, autores, URLs ni métricas'));
});

test('buildCitationSystemBlock: includes traceable provenance when available', () => {
  const block = buildCitationSystemBlock([
    {
      text: 'Study summary.',
      title: 'Research paper',
      source: 'OpenAlex',
      doi: '10.5555/source.1',
      url: 'https://doi.org/10.5555/source.1',
    },
  ]);

  assert.ok(block.includes('Research paper (OpenAlex | https://doi.org/10.5555/source.1 | 10.5555/source.1)'));
});

test('buildCitationSystemBlock: empty chunks → empty string', () => {
  assert.equal(buildCitationSystemBlock([]), '');
});

test('extractCitations: replaces [Source: N] with [N]', () => {
  const resp = 'The Pro tier is $10/mo [Source: 1] and refunds take 30 days [Source: 2].';
  const { annotatedText, citations, hasCitations } = extractCitations(resp, CHUNKS);
  assert.ok(annotatedText.includes('[1]'));
  assert.ok(annotatedText.includes('[2]'));
  assert.ok(!annotatedText.includes('[Source:'));
  assert.equal(citations.length, 2);
  assert.equal(hasCitations, true);
});

test('extractCitations: accepts Spanish [Fuente: N]', () => {
  const resp = 'El plan Pro cuesta $10 [Fuente: 1].';
  const { citations, annotatedText } = extractCitations(resp, CHUNKS);
  assert.equal(citations.length, 1);
  assert.equal(citations[0].index, 1);
  assert.ok(annotatedText.includes('[1]'));
});

test('extractCitations: drops out-of-range marker numbers', () => {
  const resp = 'Claim [Source: 99] is bogus, [Source: 1] is fine.';
  const { citations, annotatedText } = extractCitations(resp, CHUNKS);
  assert.equal(citations.length, 1);
  assert.equal(citations[0].index, 1);
  assert.ok(!annotatedText.includes('99'));
});

test('extractCitations: collapses duplicate adjacent markers', () => {
  const resp = 'The price [Source: 1][Source: 1] is stable.';
  const { annotatedText } = extractCitations(resp, CHUNKS);
  const matches = annotatedText.match(/\[1\]/g) || [];
  assert.equal(matches.length, 1);
});

test('extractCitations: citations listed in ascending order', () => {
  const resp = 'First [Source: 3] then [Source: 1] then [Source: 2].';
  const { citations } = extractCitations(resp, CHUNKS);
  assert.deepEqual(citations.map(c => c.index), [1, 2, 3]);
});

test('extractCitations: empty response stays empty', () => {
  const { hasCitations, annotatedText } = extractCitations('', CHUNKS);
  assert.equal(hasCitations, false);
  assert.equal(annotatedText, '');
});

test('extractCitations: empty chunks → no citations', () => {
  const { hasCitations } = extractCitations('The price is stable [Source: 1].', []);
  assert.equal(hasCitations, false);
});

test('extractCitations: populates snippet and relevanceScore on citation', () => {
  const resp = 'Citing [Source: 1].';
  const { citations } = extractCitations(resp, CHUNKS);
  assert.ok(citations[0].snippet.length > 0);
  assert.equal(citations[0].relevanceScore, 0.91);
});

test('renderAnnotated: returns body unchanged when no citations found', () => {
  const resp = 'No citations here.';
  assert.equal(renderAnnotated(resp, CHUNKS), resp);
});

test('renderAnnotated: appends footnotes block when citations present', () => {
  const resp = 'Pro is $10 [Source: 1].';
  const out = renderAnnotated(resp, CHUNKS);
  assert.ok(out.includes('\n\nSources:\n'));
  assert.ok(out.includes('[1] pricing.md'));
});

test('renderAnnotated: honours custom footnotes header', () => {
  const resp = 'Pro is $10 [Source: 1].';
  const out = renderAnnotated(resp, CHUNKS, { footnotesHeader: 'Fuentes' });
  assert.ok(out.includes('\n\nFuentes:\n'));
});
