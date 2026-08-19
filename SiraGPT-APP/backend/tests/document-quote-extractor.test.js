'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-quote-extractor');
const {
  extractQuotes,
  buildQuotesForFiles,
  renderQuotesBlock,
  _internal,
} = engine;

test('extractQuotes: empty / non-string input returns empty', () => {
  assert.deepEqual(extractQuotes('').quotes, []);
  assert.deepEqual(extractQuotes(null).citations, []);
  assert.deepEqual(extractQuotes(undefined).quotes, []);
  assert.deepEqual(extractQuotes(42).quotes, []);
});

test('extractQuotes: straight double quotes', () => {
  const r = extractQuotes('The CEO said "we are doubling down on Q3 growth" yesterday.');
  assert.equal(r.quotes.length, 1);
  assert.equal(r.quotes[0].kind, 'double-straight');
  assert.equal(r.quotes[0].text, 'we are doubling down on Q3 growth');
});

test('extractQuotes: smart double quotes', () => {
  const r = extractQuotes('El reporte señala: “Los ingresos crecieron 24% en 2026”.');
  assert.ok(r.quotes.length >= 1);
  assert.equal(r.quotes[0].kind, 'double-smart');
  assert.ok(r.quotes[0].text.includes('ingresos crecieron'));
});

test('extractQuotes: Spanish angle quotes «...»', () => {
  const r = extractQuotes('El presidente afirmó: «la economía está en recuperación gradual».');
  assert.ok(r.quotes.length >= 1);
  assert.equal(r.quotes[0].kind, 'angle-spanish');
  assert.ok(r.quotes[0].text.includes('economía está en recuperación'));
});

test('extractQuotes: block quote prefix', () => {
  const text = `Some lead-in paragraph.

> This is a block quote that should be picked up.

Following paragraph.`;
  const r = extractQuotes(text);
  assert.ok(r.quotes.some((q) => q.kind === 'block-quote'));
});

test('extractQuotes: ignores too-short quotes', () => {
  const r = extractQuotes('He said "ok" and left.');
  assert.equal(r.quotes.length, 0);
});

test('extractQuotes: parenthetical author-year citations', () => {
  const r = extractQuotes('As prior work has shown (Smith 2020), revenue is volatile (García y Pérez, 2021).');
  const parens = r.citations.filter((c) => c.kind === 'parenthetical-author-year');
  assert.ok(parens.length >= 2, `expected ≥2 author-year cites, got ${parens.length}: ${JSON.stringify(parens)}`);
  assert.ok(parens.some((c) => c.author === 'Smith' && c.year === '2020'));
});

test('extractQuotes: bracketed numeric citations', () => {
  const r = extractQuotes('This is documented in prior literature [1] [2] [12].');
  const nums = r.citations.filter((c) => c.kind === 'bracketed-numeric');
  assert.ok(nums.length >= 3);
});

test('extractQuotes: et al. citations', () => {
  const r = extractQuotes('Smith et al. (2020) found that the trend was significant.');
  const et = r.citations.filter((c) => c.kind === 'inline-et-al');
  assert.ok(et.length >= 1);
  assert.equal(et[0].author, 'Smith');
  assert.equal(et[0].year, '2020');
});

test('extractQuotes: footnote markers and superscripts', () => {
  const r = extractQuotes('See note [^1] and the earlier discussion[^foo-bar]. Superscript marker example¹ here.');
  const foot = r.citations.filter((c) => c.kind === 'footnote-marker');
  const sup = r.citations.filter((c) => c.kind === 'superscript-footnote');
  assert.ok(foot.length >= 2);
  assert.ok(sup.length >= 1);
});

test('extractQuotes: dedupes identical quotes', () => {
  const t = 'A "key insight" reappears. Later again: "key insight" surfaces.';
  const r = extractQuotes(t);
  // Both have inner text "key insight" → dedupe to 1.
  assert.equal(r.quotes.filter((q) => q.text === 'key insight').length, 1);
});

test('extractQuotes: caps quotes and citations', () => {
  const lines = [];
  for (let i = 0; i < 30; i += 1) {
    lines.push(`Statement number ${i} of the long report. "Quote number ${i} appears here verbatim."`);
    lines.push(`Reference [${i + 1}].`);
  }
  const r = extractQuotes(lines.join('\n'));
  assert.ok(r.quotes.length <= _internal.MAX_QUOTES_PER_FILE);
  assert.ok(r.citations.length <= _internal.MAX_CITATIONS_PER_FILE);
});

test('extractQuotes: truncates over-long quotes', () => {
  const longInner = 'lorem ipsum '.repeat(60).trim();
  const r = extractQuotes(`Lead-in "${longInner}" tail.`);
  assert.ok(r.quotes[0].text.endsWith('…'));
  assert.ok(r.quotes[0].text.length <= 400, `expected truncated, got len=${r.quotes[0].text.length}`);
});

test('buildQuotesForFiles: aggregates across files', () => {
  const files = [
    { originalName: 'a.txt', extractedText: 'The CEO said "we will grow 24%" today (Smith 2020).' },
    { originalName: 'b.txt', extractedText: 'El presidente afirmó: «la economía mejora» (García 2021).' },
  ];
  const { perFile, aggregate } = buildQuotesForFiles(files);
  assert.equal(perFile.length, 2);
  assert.ok(aggregate.quotes.length >= 2);
  assert.ok(aggregate.citations.length >= 2);
});

test('buildQuotesForFiles: skips empty files', () => {
  const { perFile } = buildQuotesForFiles([
    { originalName: 'empty.txt', extractedText: '' },
    { originalName: 'nothing.txt', extractedText: 'plain text without quotes or citations.' },
    { originalName: 'ok.txt', extractedText: 'Some lead-in "with quoted content here" indeed.' },
  ]);
  assert.equal(perFile.length, 1);
  assert.equal(perFile[0].file, 'ok.txt');
});

test('renderQuotesBlock: empty report → empty string', () => {
  assert.equal(renderQuotesBlock(null), '');
  assert.equal(renderQuotesBlock({ perFile: [], aggregate: {} }), '');
});

test('renderQuotesBlock: single-file rendering', () => {
  const r = buildQuotesForFiles([{
    originalName: 'paper.txt',
    extractedText: 'As (Smith 2020) showed, "the trend persists" across years.',
  }]);
  const md = renderQuotesBlock(r);
  assert.ok(md.includes('## QUOTES & CITATIONS'));
  assert.ok(md.includes('### File: paper.txt'));
  assert.ok(md.includes('the trend persists'));
});

test('renderQuotesBlock: multi-file rendering has aggregate + per-file', () => {
  const files = [
    { originalName: 'a.txt', extractedText: 'See "growth narrative continues" [1].' },
    { originalName: 'b.txt', extractedText: '(Smith 2020) shows otherwise: "stagnation looms".' },
  ];
  const md = renderQuotesBlock(buildQuotesForFiles(files));
  assert.ok(md.includes('Aggregate across all files'));
  assert.ok(md.includes('### File: a.txt'));
  assert.ok(md.includes('### File: b.txt'));
});

test('renderQuotesBlock: respects MAX_BLOCK_CHARS budget', () => {
  const lines = [];
  for (let i = 0; i < 200; i += 1) {
    lines.push(`Statement ${i}: "Quote number ${i} appears here verbatim with extra context to inflate length." (Author${i} ${2000 + i}). [${i + 1}].`);
  }
  const files = [{ originalName: 'huge.txt', extractedText: lines.join('\n') }];
  const md = renderQuotesBlock(buildQuotesForFiles(files));
  assert.ok(md.length <= _internal.MAX_BLOCK_CHARS,
    `block exceeded budget: ${md.length} > ${_internal.MAX_BLOCK_CHARS}`);
});

test('integration: professional-analyzer exposes quotesBlock', async () => {
  const pa = require('../src/services/document-professional-analyzer');
  const result = await pa.buildEnrichedFileContext({
    prisma: null,
    processedFiles: [{
      id: 'q1',
      originalName: 'paper.txt',
      extractedText: 'In (Smith 2020) the authors argued "the trend persists" across multiple years.',
    }],
  });
  assert.ok(typeof result.quotesBlock === 'string');
  assert.ok(result.quotesBlock.includes('QUOTES & CITATIONS'));
});
