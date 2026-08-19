'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normaliseDoi,
  extractDois,
  extractApaCitations,
  buildReferenceIndex,
  verifyCitations,
  markUnverified,
  verifyDoiOnline,
  strictModeEnabled,
} = require('../src/services/thesis/citation-verifier');

const { runThesisPipeline } = require('../src/services/thesis/thesis-engine');

test('normaliseDoi strips doi.org prefix and trailing punctuation', () => {
  assert.equal(normaliseDoi('https://doi.org/10.1234/ABC.x'), '10.1234/abc.x');
  assert.equal(normaliseDoi('http://dx.doi.org/10.5/y;'), '10.5/y');
  assert.equal(normaliseDoi('10.9/Z.'), '10.9/z');
  assert.equal(normaliseDoi(''), null);
  assert.equal(normaliseDoi(undefined), null);
});

test('extractDois finds all unique DOIs', () => {
  const text = 'See 10.1234/foo and also 10.5678/bar. Repeat 10.1234/FOO again.';
  const dois = extractDois(text);
  assert.deepEqual(dois.sort(), ['10.1234/foo', '10.5678/bar'].sort());
});

test('extractDois tolerates surrounding punctuation', () => {
  const text = '(10.9999/abc), [10.8888/xyz], "10.7777/quoted"';
  const dois = extractDois(text);
  assert.ok(dois.includes('10.9999/abc'));
  assert.ok(dois.includes('10.8888/xyz'));
  assert.ok(dois.includes('10.7777/quoted'));
});

test('extractApaCitations finds (Author, Year) and et al variants', () => {
  const text = 'Per (Smith, 2024), and again (García et al., 2023), then (Jones and Lee, 2022).';
  const apa = extractApaCitations(text);
  assert.equal(apa.length, 3);
  const years = apa.map((a) => a.year).sort();
  assert.deepEqual(years, [2022, 2023, 2024]);
});

test('extractApaCitations dedupes same author+year pair', () => {
  const text = 'See (Smith, 2024). Later, (Smith, 2024) again.';
  const apa = extractApaCitations(text);
  assert.equal(apa.length, 1);
});

test('buildReferenceIndex creates DOI and author-year maps', () => {
  const refs = [
    { paper: { doi: '10.1001/a', year: 2024, authors: ['Smith'] } },
    { paper: { doi: '10.1002/b', year: 2023, authors: [{ family: 'García' }] } },
    { doi: '10.1003/c', year: 2022, authors: ['Lee', 'Jones'] },
  ];
  const idx = buildReferenceIndex(refs);
  assert.ok(idx.byDoi.has('10.1001/a'));
  assert.ok(idx.byDoi.has('10.1002/b'));
  assert.ok(idx.byDoi.has('10.1003/c'));
  assert.ok(idx.byAuthorYear.has('smith::2024'));
  assert.ok(idx.byAuthorYear.has('garcía'.normalize('NFKD').replace(/[^\p{Letter}\p{Number}]+/gu, '') + '::2023'));
  assert.ok(idx.byAuthorYear.has('jones::2022'));
});

test('verifyCitations separates verified from invented DOIs', () => {
  const text = 'Real: 10.1234/real. Invented: 10.9999/fake.';
  const refs = [{ paper: { doi: '10.1234/real', year: 2024, authors: ['Smith'] } }];
  const report = verifyCitations(text, refs);
  assert.deepEqual(report.dois.verified, ['10.1234/real']);
  assert.deepEqual(report.dois.unverified, ['10.9999/fake']);
});

test('verifyCitations separates verified from invented APA citations', () => {
  const text = '(Smith, 2024) ok. (Inventado, 2024) no.';
  const refs = [{ paper: { doi: '10.1001/a', year: 2024, authors: ['Smith'] } }];
  const report = verifyCitations(text, refs);
  assert.equal(report.apa.verified.length, 1);
  assert.equal(report.apa.unverified.length, 1);
  assert.equal(report.apa.unverified[0].author, 'Inventado');
});

test('markUnverified appends marker to inventions only', () => {
  const text = 'Verified 10.1001/a stands. Fake 10.1002/b should be flagged. (Smith, 2024) ok. (Ghost, 2099) bad.';
  const refs = [{ paper: { doi: '10.1001/a', year: 2024, authors: ['Smith'] } }];
  const { text: out, report } = markUnverified(text, refs);
  assert.ok(out.includes('10.1001/a stands'), 'verified DOI untouched');
  assert.ok(/10\.1002\/b\s*\[no verificado\]/.test(out), 'fake DOI marked');
  assert.ok(out.includes('(Smith, 2024) ok'), 'verified APA untouched');
  assert.ok(/\(Ghost, 2099\)\s*\[no verificado\]/.test(out), 'fake APA marked');
  assert.equal(report.totalUnverified, 2);
  assert.equal(report.totalVerified, 2);
});

test('markUnverified handles empty inputs gracefully', () => {
  const { text, report } = markUnverified('', []);
  assert.equal(text, '');
  assert.equal(report.totalUnverified, 0);
  assert.equal(report.totalVerified, 0);
});

test('verifyDoiOnline returns ok when CrossRef confirms the DOI', async () => {
  const fakeFetcher = async (url) => {
    assert.ok(url.startsWith('https://api.crossref.org/works/'));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        message: {
          DOI: '10.1234/real',
          title: ['Real paper'],
          issued: { 'date-parts': [[2024]] },
          'container-title': ['Some Journal'],
          author: [{ family: 'Smith', given: 'A.' }],
        },
      }),
    };
  };
  const result = await verifyDoiOnline('10.1234/real', { fetcher: fakeFetcher });
  assert.equal(result.ok, true);
  assert.equal(result.paper.title, 'Real paper');
  assert.equal(result.paper.year, 2024);
});

test('verifyDoiOnline returns error on 404', async () => {
  const fakeFetcher = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const result = await verifyDoiOnline('10.9999/fake', { fetcher: fakeFetcher });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'http_404');
});

test('verifyDoiOnline rejects invalid input', async () => {
  const result = await verifyDoiOnline('', { fetcher: async () => ({}) });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_doi');
});

test('strictModeEnabled defaults to true', () => {
  const prev = process.env.THESIS_STRICT_CITATIONS;
  delete process.env.THESIS_STRICT_CITATIONS;
  assert.equal(strictModeEnabled(), true);
  process.env.THESIS_STRICT_CITATIONS = 'false';
  assert.equal(strictModeEnabled(), false);
  process.env.THESIS_STRICT_CITATIONS = '0';
  assert.equal(strictModeEnabled(), false);
  process.env.THESIS_STRICT_CITATIONS = 'true';
  assert.equal(strictModeEnabled(), true);
  if (prev === undefined) delete process.env.THESIS_STRICT_CITATIONS;
  else process.env.THESIS_STRICT_CITATIONS = prev;
});

test('thesis pipeline marks invented citations when strict', async () => {
  const prev = process.env.THESIS_STRICT_CITATIONS;
  process.env.THESIS_STRICT_CITATIONS = 'true';
  try {
    const report = await runThesisPipeline(
      { topic: 'AI in medicine', chapterIds: ['introduction'] },
      {
        researchPhase: async () => ({
          papers: [{ doi: '10.1001/real', year: 2024, title: 'Real', authors: ['Smith'] }],
          providers: ['mock'],
          rejected: 0,
        }),
        generateChapter: async () => {
          return 'According to (Smith, 2024) and also (Ghost, 2099) and 10.9999/invented, AI helps.';
        },
      },
    );
    const chapter = report.chapters[0];
    assert.ok(chapter.content.includes('[no verificado]'), 'unverified marker present');
    assert.equal(chapter.citations.totalUnverified, 2);
    assert.equal(chapter.citations.totalVerified, 1);
    assert.equal(report.citationVerification.strict, true);
    assert.equal(report.citationVerification.totalUnverified, 2);
  } finally {
    if (prev === undefined) delete process.env.THESIS_STRICT_CITATIONS;
    else process.env.THESIS_STRICT_CITATIONS = prev;
  }
});

test('thesis pipeline passes through unverified when strict=false', async () => {
  const report = await runThesisPipeline(
    {
      topic: 'AI in medicine',
      chapterIds: ['introduction'],
      strictCitations: false,
    },
    {
      researchPhase: async () => ({
        papers: [{ doi: '10.1001/real', year: 2024, title: 'Real', authors: ['Smith'] }],
        providers: ['mock'],
        rejected: 0,
      }),
      generateChapter: async () => 'Per (Ghost, 2099) AI helps. 10.9999/fake also.',
    },
  );
  const chapter = report.chapters[0];
  assert.ok(!chapter.content.includes('[no verificado]'), 'no marker when strict=false');
  assert.equal(report.citationVerification.strict, false);
});
