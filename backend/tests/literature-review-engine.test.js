'use strict';

// The backend test command maintains an explicit allowlist. Requiring the R2
// suites here keeps DOI resolution and systematic-review contracts in that CI
// gate without duplicating the already very large package script.
require('./doi-resolver.test');
require('./systematic-review-protocol.test');
require('./search-agentic-doi-resolution.test');
require('./research-discipline-routing.test');
require('./research-library.test');

const test = require('node:test');
const assert = require('node:assert/strict');

const qi = require('../src/services/research/research-query-intelligence');
const bib = require('../src/services/research/bibliography-formatter');
const ev = require('../src/services/research/evidence-extractor');
const syn = require('../src/services/research/literature-synthesizer');
const { buildLiteratureReview, applyFilters } = require('../src/services/research/literature-review-engine');

// ── Query intelligence ─────────────────────────────────────────────────

test('analyzeQuery: detects ES, extracts terms, strips command/stopwords', () => {
  const r = qi.analyzeQuery('búscame artículos científicos de la gestión administrativa');
  assert.equal(r.language, 'es');
  assert.ok(r.terms.includes('gestion'), `terms=${r.terms}`);
  assert.ok(r.terms.includes('administrativa'));
  assert.ok(!r.terms.includes('articulos'), 'command/stopwords removed');
  assert.ok(!r.terms.includes('buscame'));
  assert.ok(r.searchQueries.length >= 1);
});

test('analyzeQuery: bilingual expansion adds English synonyms for gestión', () => {
  const r = qi.analyzeQuery('gestión administrativa');
  assert.ok(r.expansions.includes('management'), `expansions=${r.expansions}`);
  // At least one expanded query variant should carry the English term.
  assert.ok(r.searchQueries.some((q) => /management/.test(q)));
});

test('analyzeQuery: separates the scientific topic from ranking and metadata instructions', () => {
  const r = qi.analyzeQuery(
    'Busca 5 artículos científicos publicados entre 2021 y 2026 sobre aprendizaje autorregulado en educación superior. ' +
    'Prioriza revisiones sistemáticas y estudios empíricos, acceso abierto, DOI verificable y alta pertinencia temática.',
  );

  assert.deepEqual(r.terms, ['aprendizaje', 'autorregulado', 'educacion', 'superior']);
  assert.equal(r.filters.yearFrom, 2021);
  assert.equal(r.filters.yearTo, 2026);
  assert.equal(r.filters.openAccessOnly, true);
  assert.ok(r.searchQueries.some((q) => /self-regulated learning/i.test(q)), `queries=${r.searchQueries}`);
  assert.ok(r.searchQueries.some((q) => /higher education/i.test(q)), `queries=${r.searchQueries}`);
  assert.ok(r.searchQueries.every((q) => !/doi|pertinencia|verificable/i.test(q)), `queries=${r.searchQueries}`);
  assert.ok(r.conceptGroups.some((group) => group.includes('aprendizaje autorregulado')));
  assert.ok(r.conceptGroups.some((group) => group.includes('educacion superior')));
});

test('analyzeQuery: does not activate a compound concept from one generic word', () => {
  const collaborative = qi.analyzeQuery('aprendizaje colaborativo en educación inicial');
  assert.ok(!collaborative.expansions.some((term) => /self-regulated/i.test(term)));
  assert.ok(!collaborative.expansions.some((term) => /higher education/i.test(term)));
});

test('extractFilters: year range, recency, study type, open access, language', () => {
  assert.deepEqual(qi.extractFilters('entre 2018 y 2022'), { yearFrom: 2018, yearTo: 2022 });
  const recent = qi.extractFilters('estudios recientes');
  assert.ok(recent.yearFrom >= new Date().getFullYear() - 5);
  assert.equal(qi.extractFilters('una revisión sistemática').studyType, 'systematic_review');
  assert.equal(qi.extractFilters('papers open access').openAccessOnly, true);
  assert.equal(qi.extractFilters('artículos en español').language, 'es');
  assert.equal(qi.extractFilters('solo artículos revisados por pares').peerReviewedOnly, true);
  assert.equal(qi.extractFilters('solo artículos revisados por pares').excludePreprints, true);
  assert.equal(qi.extractFilters('estudio de artículos retractados').includeRetracted, true);
  assert.equal(qi.extractFilters('solo revisiones sistemáticas').studyTypeRequired, true);
});

test('analyzeQuery: "últimos 3 años" sets a recent yearFrom', () => {
  const r = qi.analyzeQuery('innovación en los últimos 3 años');
  assert.equal(r.filters.yearFrom, new Date().getFullYear() - 3);
});

// ── Bibliography formatter ─────────────────────────────────────────────

const paper = {
  title: 'Administrative management in public institutions',
  authors: [{ name: 'María García' }, { name: 'John Smith' }],
  year: 2021,
  venue: 'Journal of Public Administration',
  doi: '10.1234/abc',
};

test('formatAPA: authors inverted with initials, year, DOI link', () => {
  const apa = bib.formatAPA(paper);
  assert.match(apa, /García, M\./);
  assert.match(apa, /& Smith, J\./);
  assert.match(apa, /\(2021\)/);
  assert.match(apa, /https:\/\/doi\.org\/10\.1234\/abc/);
});

test('formatIEEE: numbered, initials-first, quoted title', () => {
  const ieee = bib.formatIEEE(paper, 1);
  assert.match(ieee, /^\[1\]/);
  assert.match(ieee, /M\. García and J\. Smith/);
  assert.match(ieee, /"Administrative management in public institutions,"/);
});

test('formatMLA: surname-first primary author, et al for 3+', () => {
  assert.match(bib.formatMLA(paper), /^García, María, and John Smith\./);
  const many = { ...paper, authors: [{ name: 'A B' }, { name: 'C D' }, { name: 'E F' }] };
  assert.match(bib.formatMLA(many), /^B, A, et al\./);
});

test('inTextCitation: (Author & Author, year) / et al.', () => {
  assert.equal(bib.inTextCitation(paper), '(García & Smith, 2021)');
  const three = { ...paper, authors: [{ name: 'A X' }, { name: 'B Y' }, { name: 'C Z' }] };
  assert.equal(bib.inTextCitation(three), '(X et al., 2021)');
});

test('formatBibliography(apa) is alphabetised', () => {
  const list = bib.formatBibliography([
    { title: 'Z', authors: [{ name: 'Zoe Zen' }], year: 2020 },
    { title: 'A', authors: [{ name: 'Ana Avila' }], year: 2019 },
  ], 'apa');
  assert.match(list[0], /Avila/);
});

// ── Evidence extractor ─────────────────────────────────────────────────

test('extractEvidence: ranks result sentences, detects direction + stats', () => {
  const p = {
    title: 'Effect of leadership on productivity',
    abstract: 'This paper studies leadership. We surveyed 300 firms. Results show productivity increased by 23% (p < 0.01) under transformational leadership. Future research is needed on small firms.',
  };
  const e = ev.extractEvidence(p, ['leadership', 'productivity']);
  assert.ok(e.topFinding && /23%/.test(e.topFinding), `topFinding=${e.topFinding}`);
  assert.equal(e.hasStats, true);
  assert.equal(e.findings[0].direction, 'positive');
  assert.ok(e.futureWork && /Future research/.test(e.futureWork));
});

test('detectStudyType: recognises meta-analysis / RCT (bilingual)', () => {
  assert.equal(ev.detectStudyType('A meta-analysis of 40 trials'), 'meta_analysis');
  assert.equal(ev.detectStudyType('un ensayo clínico aleatorizado'), 'rct');
});

// ── Synthesizer ────────────────────────────────────────────────────────

function enrich(papers, terms) {
  return papers.map((p) => ({ ...p, evidence: ev.extractEvidence(p, terms) }));
}

test('computeStats: counts, year range, OA rate, citations', () => {
  const s = syn.computeStats([
    { year: 2019, citations: 10, openAccess: true, doi: '10/a' },
    { year: 2021, citations: 5, openAccess: false, doi: null },
  ]);
  assert.equal(s.count, 2);
  assert.deepEqual(s.yearRange, { from: 2019, to: 2021 });
  assert.equal(s.openAccessRate, 50);
  assert.equal(s.totalCitations, 15);
  assert.equal(s.withDoi, 1);
});

test('synthesize: builds themes + consensus from aligned findings', () => {
  const papers = enrich([
    { title: 'Leadership boosts motivation', abstract: 'Transformational leadership increased motivation significantly in 200 teams.', year: 2020, openAccess: true },
    { title: 'Leadership and motivation in schools', abstract: 'We found leadership improved motivation and performance (p<0.05).', year: 2021, openAccess: true },
  ], ['leadership']);
  const out = syn.synthesize(papers, { language: 'es', terms: ['leadership'], normalized: 'leadership motivation' });
  assert.ok(out.stats.count === 2);
  assert.ok(out.themes.some((t) => t.keyword === 'motivation'), `themes=${out.themes.map((t) => t.keyword)}`);
  assert.ok(out.overview.includes('estudios'));
  assert.ok(out.consensusEvidence.length >= 1);
  assert.ok(out.consensusEvidence[0].paperIndexes.length >= 2);
});

// ── End-to-end engine (offline, injected search) ───────────────────────

const FIXTURE = [
  { source: 'arxiv', doi: '10.1/a', title: 'Administrative management improves public sector performance', authors: [{ name: 'María García' }, { name: 'John Smith' }], year: 2021, venue: 'J. Public Admin', citations: 40, openAccess: true, pdfUrl: 'http://pdf/a', abstract: 'We analyse administrative management in 120 public institutions. Results show performance increased by 18% (p<0.05) with better management practices.' },
  { source: 'crossref', doi: '10.1/b', title: 'Strategic management and innovation in administration', authors: [{ name: 'Ana López' }], year: 2019, venue: 'Management Review', citations: 90, openAccess: false, abstract: 'This study of strategic management finds innovation drives administrative efficiency. Further research is needed.' },
  { source: 'openalex', doi: '10.1/c', title: 'Public administration reform: a systematic review', authors: [{ name: 'Lee Choi' }, { name: 'Sara Kim' }, { name: 'Tom Park' }], year: 2023, venue: 'Gov Studies', citations: 12, openAccess: true, pdfUrl: 'http://pdf/c', abstract: 'A systematic review of 60 studies. Management quality is consistently associated with higher institutional performance.' },
];

test('buildLiteratureReview: full deliverable from an injected search', async () => {
  const searchImpl = async () => ({ papers: FIXTURE, errors: [], providers: ['arxiv', 'crossref', 'openalex'] });
  const review = await buildLiteratureReview('búscame artículos de la gestión administrativa', { searchImpl, maxPapers: 10 });

  assert.equal(review.query.language, 'es');
  assert.equal(review.papers.length, 3, 'deduped + ranked papers');
  // Each paper enriched with evidence + in-text citation.
  assert.ok(review.papers.every((p) => p.evidence && p.inTextCitation));
  // Bibliography in all three styles.
  assert.equal(review.bibliography.apa.length, 3);
  assert.equal(review.bibliography.ieee.length, 3);
  assert.equal(review.bibliography.mla.length, 3);
  // Markdown report contains the major sections + a comparison table.
  assert.match(review.report, /# Revisión de literatura/);
  assert.match(review.report, /## Referencias \(APA\)/);
  assert.match(review.report, /\| # \| Autores \|/);
  assert.match(review.comparisonTable, /Hallazgo clave/);
  // Synthesis stats are real.
  assert.equal(review.synthesis.stats.count, 3);
  assert.ok(review.meta.durationMs >= 0);
});

test('buildLiteratureReview: applies a year filter from the query', async () => {
  const searchImpl = async () => ({ papers: FIXTURE, errors: [], providers: ['arxiv'] });
  const review = await buildLiteratureReview('gestión administrativa entre 2020 y 2024', { searchImpl });
  // Only 2021 + 2023 papers survive the 2020-2024 filter.
  assert.equal(review.papers.length, 2);
  assert.ok(review.papers.every((p) => p.year >= 2020 && p.year <= 2024));
});

test('applyFilters: openAccessOnly keeps OA + pdf, drops closed', () => {
  const out = applyFilters([
    { year: 2020, openAccess: true },
    { year: 2020, openAccess: false },
    { year: 2020, openAccess: null, pdfUrl: 'x' },
  ], { openAccessOnly: true });
  assert.equal(out.length, 2);
});

test('applyFilters: excludes retracted records by default and preserves integrity metadata', () => {
  const out = applyFilters([
    { source: 'openalex', title: 'Retracted result', raw: { is_retracted: true } },
    { source: 'pubmed', title: 'Published result', journal: 'Journal of Evidence' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].integrityStatus, 'unknown');
  assert.equal(out[0].publicationStage, 'published_article');
});

test('buildLiteratureReview: reports how many unsafe records were excluded', async () => {
  const searchImpl = async () => ({
    papers: [
      ...FIXTURE,
      { source: 'openalex', doi: '10.1/retracted', title: 'Retracted administrative study', raw: { is_retracted: true } },
    ],
    errors: [],
    providers: ['openalex'],
  });
  const review = await buildLiteratureReview('gestión administrativa', { searchImpl });
  assert.equal(review.papers.some((p) => p.integrityStatus === 'retracted'), false);
  assert.equal(review.meta.integrityExcluded, 1);
});

test('buildLiteratureReview: resolves selected DOI through an injected verifier', async () => {
  const searchImpl = async () => ({
    papers: [{ ...FIXTURE[0], doi: '10.1234/live-doi' }],
    errors: [],
    providers: ['crossref'],
  });
  const doiResolver = async (papers) => papers.map((item) => ({
    ...item,
    doiResolutionStatus: 'resolved',
    doiResolvedUrl: 'https://publisher.example/live-doi',
  }));
  const review = await buildLiteratureReview('gestión administrativa', { searchImpl, doiResolver });
  assert.equal(review.papers[0].doiResolutionStatus, 'resolved');
  assert.equal(review.meta.doiResolved, 1);
  assert.match(review.comparisonTable, /\| ✓ \|/);
});

test('buildLiteratureReview: degrades safely when the DOI resolver is unavailable', async () => {
  const searchImpl = async () => ({ papers: [{ ...FIXTURE[0], doi: '10.1234/transient' }], errors: [], providers: ['crossref'] });
  const review = await buildLiteratureReview('gestión administrativa', {
    searchImpl,
    doiResolver: async () => { throw new Error('resolver unavailable'); },
  });
  assert.equal(review.papers.length, 1);
  assert.equal(review.meta.doiResolved, 0);
  assert.equal(review.meta.doiResolutionError, 'resolver unavailable');
  assert.ok(review.meta.errors.some((error) => error.provider === 'doi-resolver'));
});

test('buildLiteratureReview: produces PICO, screening, PRISMA and preliminary certainty', async () => {
  const searchImpl = async (query) => ({
    papers: [
      { source: 'pubmed', doi: '10.1234/telemedicine', title: 'Telemedicine for adults with diabetes', year: 2024, journal: 'Clinical Evidence', abstract: 'Adults with diabetes received telemedicine compared with usual care. Glycemic control improved significantly (p<0.05).' },
      { source: 'openalex', doi: '10.1234/old', title: 'Older diabetes study', year: 2017, abstract: 'Adults with diabetes received telemedicine.' },
    ],
    errors: [],
    providers: ['pubmed'],
    query,
  });
  const raw = 'Revisión sistemática PICO entre 2020 y 2026; Población: adultos con diabetes; Intervención: telemedicina; Comparación: atención habitual; Resultado: control glucémico';
  const review = await buildLiteratureReview(raw, { searchImpl, resolveDois: false });
  assert.equal(review.protocol.framework, 'pico');
  assert.match(review.meta.queriesRun[0], /"adultos con diabetes" AND "telemedicina"/);
  assert.equal(review.prisma.screening.recordsExcluded, 1);
  assert.equal(review.screeningDecisions.find((item) => item.year === 2017).screening.decision, 'exclude');
  assert.equal(review.papers[0].riskOfBias.requiresFullTextAssessment, true);
  assert.ok(['very_low', 'low', 'moderate'].includes(review.certainty.level));
  assert.match(review.report, /Protocolo de búsqueda/);
  assert.match(review.report, /Flujo PRISMA preliminar/);
  assert.match(review.report, /Riesgo de sesgo preliminar/);
  assert.match(review.protocolExport.content, /```mermaid/);
  assert.match(review.protocolExport.filename, /^protocolo-/);
});

test('buildLiteratureReview: empty query returns a graceful empty review', async () => {
  const review = await buildLiteratureReview('   ', { searchImpl: async () => ({ papers: [], errors: [], providers: [] }) });
  assert.equal(review.papers.length, 0);
  assert.match(review.report, /No se identificaron resultados|No results/);
});
