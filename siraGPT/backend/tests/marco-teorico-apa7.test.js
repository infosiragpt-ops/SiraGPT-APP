'use strict';

/**
 * Unit tests for services/marco-teorico/apa7.js. The APA 7 formatter
 * is the single source of truth for every citation that the thesis
 * generator emits, so these tests pin the format contract:
 *
 *  - Inline: 1 / 2 / 3+ authors handled per APA rule.
 *  - Reference: surname order, & between last two, et al. past 20.
 *  - DOI/URL appended when available.
 *  - Missing pieces degrade to "(n.d.)" or "(Untitled)" instead of
 *    the literal "undefined".
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const apa7 = require('../src/services/marco-teorico/apa7');

function makeSource(overrides = {}) {
  return {
    doi: '10.1038/nature12373',
    title: 'A scalable approach to thesis generation',
    authors: [{ family: 'Smith', given: 'John' }],
    year: 2024,
    container: 'Nature',
    volume: 615,
    issue: 2,
    pages: '123-130',
    url: 'https://doi.org/10.1038/nature12373',
    ...overrides,
  };
}

// ── inlineCitation ─────────────────────────────────────────────────────

test('inlineCitation: single author → (Smith, 2024)', () => {
  const result = apa7.inlineCitation(makeSource());
  assert.equal(result, '(Smith, 2024)');
});

test('inlineCitation: two authors → (Smith & Jones, 2024) with ampersand', () => {
  const result = apa7.inlineCitation(
    makeSource({
      authors: [
        { family: 'Smith', given: 'John' },
        { family: 'Jones', given: 'Mary' },
      ],
    }),
  );
  assert.equal(result, '(Smith & Jones, 2024)');
});

test('inlineCitation: 3+ authors → (Smith et al., 2024)', () => {
  const result = apa7.inlineCitation(
    makeSource({
      authors: [
        { family: 'Smith', given: 'John' },
        { family: 'Jones', given: 'Mary' },
        { family: 'Brown', given: 'Alice' },
      ],
    }),
  );
  assert.equal(result, '(Smith et al., 2024)');
});

test('inlineCitation: missing year → uses "n.d."', () => {
  const result = apa7.inlineCitation(makeSource({ year: null }));
  assert.equal(result, '(Smith, n.d.)');
});

test('inlineCitation: missing authors → fallback to title prefix', () => {
  const result = apa7.inlineCitation(
    makeSource({ authors: [], title: 'A scalable approach to thesis generation' }),
  );
  assert.equal(result, '(A scalable approach, 2024)');
});

test('inlineCitation: missing authors AND missing title → "(Anonymous, year)"', () => {
  const result = apa7.inlineCitation(makeSource({ authors: [], title: null }));
  assert.equal(result, '(Anonymous, 2024)');
});

test('inlineCitation: author display falls back when family missing', () => {
  const result = apa7.inlineCitation(
    makeSource({ authors: [{ display: 'Hernández y Mendoza' }] }),
  );
  assert.equal(result, '(Hernández y Mendoza, 2024)');
});

// ── formatAuthorsForReference ──────────────────────────────────────────

test('formatAuthorsForReference: single author → "Smith, J."', () => {
  const result = apa7.formatAuthorsForReference([{ family: 'Smith', given: 'John' }]);
  assert.equal(result, 'Smith, J.');
});

test('formatAuthorsForReference: two authors → "Smith, J., & Jones, M."', () => {
  const result = apa7.formatAuthorsForReference([
    { family: 'Smith', given: 'John' },
    { family: 'Jones', given: 'Mary' },
  ]);
  assert.equal(result, 'Smith, J., & Jones, M.');
});

test('formatAuthorsForReference: three authors → Oxford comma + ampersand', () => {
  const result = apa7.formatAuthorsForReference([
    { family: 'Smith', given: 'John' },
    { family: 'Jones', given: 'Mary' },
    { family: 'Brown', given: 'Alice Beth' },
  ]);
  // Two given names → two initials: A. B.
  assert.equal(result, 'Smith, J., Jones, M., & Brown, A. B.');
});

test('formatAuthorsForReference: caps at 20 authors (spec: et al.)', () => {
  const authors = Array.from({ length: 25 }, (_, i) => ({
    family: `Author${i + 1}`,
    given: 'X',
  }));
  const result = apa7.formatAuthorsForReference(authors);
  // 20 names appear; 21..25 dropped (caller adds "et al." if needed)
  assert.ok(result.includes('Author20'));
  assert.ok(!result.includes('Author21'));
});

test('formatAuthorsForReference: handles given already as initial "A."', () => {
  const result = apa7.formatAuthorsForReference([{ family: 'Karpathy', given: 'A.' }]);
  assert.equal(result, 'Karpathy, A.');
});

test('formatAuthorsForReference: empty array → empty string', () => {
  assert.equal(apa7.formatAuthorsForReference([]), '');
});

test('formatAuthorsForReference: missing family → "Unknown"', () => {
  const result = apa7.formatAuthorsForReference([{ given: 'John' }]);
  assert.equal(result, 'Unknown, J.');
});

// ── referenceEntry ─────────────────────────────────────────────────────

test('referenceEntry: full source → authors, year, title, italic venue + vol(issue), pages, DOI URL', () => {
  const result = apa7.referenceEntry(makeSource());
  // "Smith, J. (2024). A scalable approach to thesis generation. *Nature*, *615(2)*, 123-130. https://doi.org/..."
  assert.match(result, /^Smith, J\./);
  assert.match(result, /\(2024\)\./);
  assert.match(result, /A scalable approach to thesis generation\./);
  assert.match(result, /\*Nature\*/);
  assert.match(result, /\*615\(2\)\*/);
  assert.match(result, /123-130/);
  assert.match(result, /https:\/\/doi\.org\/10\.1038\/nature12373/);
});

test('referenceEntry: missing year → "(n.d.)"', () => {
  const result = apa7.referenceEntry(makeSource({ year: null }));
  assert.match(result, /\(n\.d\.\)/);
  assert.ok(!result.includes('undefined'));
});

test('referenceEntry: missing title → "(Untitled)"', () => {
  const result = apa7.referenceEntry(makeSource({ title: null }));
  assert.match(result, /\(Untitled\)/);
});

test('referenceEntry: DOI but no url → builds doi.org URL', () => {
  const result = apa7.referenceEntry(makeSource({ url: null }));
  assert.match(result, /https:\/\/doi\.org\/10\.1038\/nature12373/);
});

test('referenceEntry: no DOI and no URL → no URL block', () => {
  const result = apa7.referenceEntry(makeSource({ url: null, doi: null }));
  assert.ok(!result.includes('https://doi.org/'));
});

test('referenceEntry: title without trailing period gets one appended', () => {
  const result = apa7.referenceEntry(makeSource({ title: 'Foo bar' }));
  assert.match(result, /Foo bar\./);
  // Doesn't double-add
  const result2 = apa7.referenceEntry(makeSource({ title: 'Foo bar.' }));
  assert.ok(!result2.includes('Foo bar..'));
});

test('referenceEntry: volume without issue → italic *615* (no parens)', () => {
  const result = apa7.referenceEntry(makeSource({ issue: null }));
  assert.match(result, /\*615\*/);
  assert.ok(!result.includes('(2)'));
});

// ── referenceList ──────────────────────────────────────────────────────

test('referenceList: sorts by author surname, then year', () => {
  const sources = [
    makeSource({ authors: [{ family: 'Zebra' }], year: 2023, title: 'Z' }),
    makeSource({ authors: [{ family: 'Apple' }], year: 2024, title: 'A2024' }),
    makeSource({ authors: [{ family: 'Apple' }], year: 2022, title: 'A2022' }),
  ];
  const list = apa7.referenceList(sources);
  const lines = list.split('\n');
  assert.equal(lines.length, 3);
  // Apple 2022 first, then Apple 2024, then Zebra 2023
  assert.match(lines[0], /Apple.*A2022/);
  assert.match(lines[1], /Apple.*A2024/);
  assert.match(lines[2], /Zebra/);
});

test('referenceList: each entry prefixed with markdown bullet', () => {
  const list = apa7.referenceList([makeSource()]);
  assert.match(list, /^- /);
});

test('referenceList: missing author surname sorts to the end (ZZZ sentinel)', () => {
  const sources = [
    makeSource({ authors: [] }),
    makeSource({ authors: [{ family: 'Apple' }] }),
  ];
  const list = apa7.referenceList(sources);
  const lines = list.split('\n');
  assert.match(lines[0], /Apple/);
});

// ── splitName ──────────────────────────────────────────────────────────

test('splitName: "Andrew Ng" → family Ng, given Andrew', () => {
  const result = apa7.splitName('Andrew Ng');
  assert.equal(result.family, 'Ng');
  assert.equal(result.given, 'Andrew');
});

test('splitName: "A. Karpathy" → family Karpathy, given A.', () => {
  const result = apa7.splitName('A. Karpathy');
  assert.equal(result.family, 'Karpathy');
  assert.equal(result.given, 'A.');
});

test('splitName: single token → family only', () => {
  const result = apa7.splitName('Madonna');
  assert.equal(result.family, 'Madonna');
  assert.equal(result.given, null);
});

test('splitName: empty string → both null', () => {
  const result = apa7.splitName('');
  assert.equal(result.family, null);
  assert.equal(result.given, null);
});
