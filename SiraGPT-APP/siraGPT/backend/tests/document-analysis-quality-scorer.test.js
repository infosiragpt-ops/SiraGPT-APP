'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const scorer = require('../src/services/document-analysis-quality-scorer');
const { extractDocumentInsights } = require('../src/services/document-insights-engine');

// Build a small but realistic insights report that exercises multiple
// extractor categories at once.
function buildSampleReport() {
  const text = `
Dr. Carlos Pérez prepared a 2026-Q1 budget for Acme Corp.
Q1 revenue grew 12.5% YoY to $1,200,000 USD.
The team includes 32 engineers (DOI: 10.1234/example.abcd).
PostgreSQL hosts are at 10.0.0.42 and 192.168.1.100.
The Health Insurance Portability and Accountability Act (HIPAA) is referenced in Section 3.2.
We will deliver the proposal by Friday — risk: vendor concentration.
The launch was an outstanding success.
`.trim();
  return extractDocumentInsights(text);
}

test('scoreInsightsReport: emits coverage / density / breadth / overall for a typical report', () => {
  const report = buildSampleReport();
  const score = scorer.scoreInsightsReport(report);
  assert.ok(score.coverage > 0, `coverage should be > 0, got ${score.coverage}`);
  assert.ok(score.breadth > 0, `breadth should be > 0, got ${score.breadth}`);
  assert.ok(score.overall > 0);
  assert.ok(['A', 'B', 'C', 'D', 'F'].includes(score.grade));
});

test('scoreInsightsReport: returns zero scores for empty report', () => {
  const empty = extractDocumentInsights('');
  const score = scorer.scoreInsightsReport(empty);
  assert.equal(score.coverage, 0);
  assert.equal(score.density, 0);
  assert.equal(score.breadth, 0);
  assert.equal(score.findings, 0);
  assert.equal(score.grade, 'F');
});

test('scoreInsightsReport: tolerates null / non-object inputs', () => {
  assert.equal(scorer.scoreInsightsReport(null).overall, 0);
  assert.equal(scorer.scoreInsightsReport(undefined).overall, 0);
  assert.equal(scorer.scoreInsightsReport('text').overall, 0);
});

test('scoreInsightsReport: coverage = 100% when document fits inside scan window', () => {
  // Document under 32 KB → coverage 100
  const report = extractDocumentInsights('a short document with a date 2026-01-01 and $100 USD.');
  const score = scorer.scoreInsightsReport(report);
  assert.equal(score.coverage, 100);
});

test('scoreInsightsReport: coverage drops below 100 when document exceeds scan window', () => {
  // Force metrics.chars > 32_000 by spoofing the report
  const fakeReport = {
    metrics: { chars: 100_000, words: 16_000, sentences: 1000, paragraphs: 100, headings: 5, lists: 10, tables: 0, codeBlocks: 0, inlineCode: 0, avgSentenceLength: 16, readingMinutes: 73, readabilityScore: 42 },
    entities: { persons: ['Ada'], organizations: [], places: [] },
    contacts: { urls: [], emails: [], phones: [] },
    dates: { absolute: [], relative: [] },
    numbers: { money: [], percentages: [], largeNumbers: [] },
    actionItems: [],
    questions: [],
    risks: [],
    claims: [],
    identifiers: { ipv4: [], ipv6: [], macAddresses: [], uuids: [], hashes: { md5: [], sha1: [], sha256: [] }, jwts: [], ibans: [], swiftCodes: [], awsArns: [] },
    bibliographic: { dois: [], isbns: [], arxivIds: [], rfcs: [], pubmedIds: [], pmcIds: [] },
    geographic: { coordinatesDecimal: [], coordinatesDms: [], postalCodes: [] },
    statistical: { sampleSizes: [], pValues: [], correlations: [], confidenceIntervals: [], effectSizes: [], meansAndSd: [] },
    acronyms: [],
    trends: [],
    crossReferences: [],
    sentiment: { positive: [], negative: [] },
  };
  const score = scorer.scoreInsightsReport(fakeReport);
  assert.ok(score.coverage < 100);
  assert.ok(score.coverage >= 30);
});

// ─── Coherence ─────────────────────────────────────────────────────────

test('scoreClassificationCoherence: academic_paper with DOI + stats scores high', () => {
  const text = `
We propose a new method. Smith et al. doi:10.1038/nature12373 introduced the baseline.
Our study (n=1,247) found a strong effect (p < 0.001, r = 0.82).
The General Data Protection Regulation (GDPR) applies. See Section 3.2 for details.
`.trim();
  const report = extractDocumentInsights(text);
  const coherence = scorer.scoreClassificationCoherence(report, { type: 'academic_paper' });
  assert.equal(coherence.type, 'academic_paper');
  assert.ok(coherence.score >= 60, `expected ≥60, got ${coherence.score}`);
  assert.ok(['high', 'medium'].includes(coherence.verdict));
});

test('scoreClassificationCoherence: academic_paper missing bibliography scores lower', () => {
  // No DOIs, no statistics, no acronyms
  const report = extractDocumentInsights('A short note about a paper. We will write more later.');
  const coherence = scorer.scoreClassificationCoherence(report, { type: 'academic_paper' });
  assert.ok(coherence.score < 50);
  assert.ok(coherence.misses.includes('bibliographic'));
});

test('scoreClassificationCoherence: unknown type returns neutral score', () => {
  const report = extractDocumentInsights('some content');
  const coherence = scorer.scoreClassificationCoherence(report, { type: 'unknown_unicorn_doctype' });
  assert.equal(coherence.score, 50);
});

test('scoreClassificationCoherence: bank_statement with money + dates + identifiers scores high', () => {
  const text = `
BANK STATEMENT, period 2026-04-01 to 2026-04-30. IBAN DE89 3704 0044 0532 0130 00.
04/02 Salary $3,500.00. 04/15 Grocery -$245.30. 04/30 Closing $4,875.42.
Recurring fees increased 4% YoY.
`.trim();
  const report = extractDocumentInsights(text);
  const coherence = scorer.scoreClassificationCoherence(report, { type: 'bank_statement' });
  assert.ok(coherence.score >= 60);
});

// ─── Render ─────────────────────────────────────────────────────────────

test('renderQualityBlock: includes overall grade, coverage, breadth columns', () => {
  const report = buildSampleReport();
  const score = scorer.scoreInsightsReport(report);
  const block = scorer.renderQualityBlock(score, { fileLabel: 'demo.pdf' });
  assert.match(block, /## ANALYSIS QUALITY ASSURANCE/);
  assert.match(block, /demo\.pdf/);
  assert.match(block, /Overall:/);
  assert.match(block, /Coverage/);
  assert.match(block, /Breadth/);
  assert.match(block, /Density/);
});

test('renderQualityBlock: returns empty string when no score given', () => {
  assert.equal(scorer.renderQualityBlock(null), '');
});

test('renderQualityBlock: warns the model when coverage is low', () => {
  // Force a low coverage by spoofing huge document size
  const fakeReport = {
    metrics: { chars: 1_000_000, words: 160_000, sentences: 10000, paragraphs: 1000, headings: 50, lists: 100, tables: 5, codeBlocks: 0, inlineCode: 0, avgSentenceLength: 16, readingMinutes: 730, readabilityScore: 42 },
    entities: { persons: [], organizations: [], places: [] },
    contacts: { urls: [], emails: [], phones: [] },
    dates: { absolute: [], relative: [] },
    numbers: { money: [], percentages: [], largeNumbers: [] },
    actionItems: [], questions: [], risks: [], claims: [],
    identifiers: { ipv4: [], ipv6: [], macAddresses: [], uuids: [], hashes: { md5: [], sha1: [], sha256: [] }, jwts: [], ibans: [], swiftCodes: [], awsArns: [] },
    bibliographic: { dois: [], isbns: [], arxivIds: [], rfcs: [], pubmedIds: [], pmcIds: [] },
    geographic: { coordinatesDecimal: [], coordinatesDms: [], postalCodes: [] },
    statistical: { sampleSizes: [], pValues: [], correlations: [], confidenceIntervals: [], effectSizes: [], meansAndSd: [] },
    acronyms: [], trends: [], crossReferences: [], sentiment: { positive: [], negative: [] },
  };
  const score = scorer.scoreInsightsReport(fakeReport);
  const block = scorer.renderQualityBlock(score);
  assert.match(block, /first ~32 KB/);
});

// ─── Multi-file aggregator ─────────────────────────────────────────────

test('buildQualityForFiles: single file yields detailed per-file block', () => {
  const report = buildSampleReport();
  const block = scorer.buildQualityForFiles([{ file: 'memo.txt', report }]);
  assert.match(block, /memo\.txt/);
  assert.match(block, /Overall:/);
});

test('buildQualityForFiles: multi-file yields aggregate table with one row per file', () => {
  const r1 = extractDocumentInsights('Acme Corp grew revenue 12% YoY to $1,200,000.');
  const r2 = extractDocumentInsights('Bank statement, IBAN DE89 3704 0044 0532 0130 00, balance $4,875.42.');
  const block = scorer.buildQualityForFiles([
    { file: 'a.txt', report: r1 },
    { file: 'b.txt', report: r2 },
  ]);
  assert.match(block, /a\.txt/);
  assert.match(block, /b\.txt/);
  assert.match(block, /Aggregate:/);
});

test('buildQualityForFiles: empty list returns empty string', () => {
  assert.equal(scorer.buildQualityForFiles([]), '');
  assert.equal(scorer.buildQualityForFiles(null), '');
});

test('buildQualityForFiles: respects MAX_QUALITY_BLOCK_CHARS budget', () => {
  // 50 files → must truncate
  const reports = Array.from({ length: 50 }, (_, i) => ({
    file: `file-${i}.txt`,
    report: buildSampleReport(),
  }));
  const block = scorer.buildQualityForFiles(reports);
  assert.ok(block.length <= 2500, `expected ≤2500 chars, got ${block.length}`);
});

// ─── Grades ──────────────────────────────────────────────────────────

test('gradeFromScore: maps scores to A/B/C/D/F', () => {
  const { gradeFromScore } = scorer._internal;
  assert.equal(gradeFromScore(95), 'A');
  assert.equal(gradeFromScore(85), 'A');
  assert.equal(gradeFromScore(75), 'B');
  assert.equal(gradeFromScore(60), 'C');
  assert.equal(gradeFromScore(45), 'D');
  assert.equal(gradeFromScore(20), 'F');
});
