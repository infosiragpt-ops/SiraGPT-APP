'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-title-extractor');
const { extractTitle, buildTitlesForFiles, renderTitlesBlock, _internal } = engine;
const { tryMarkdownTitle, tryHtmlTitle, tryPdfHeuristic, stemFilename } = _internal;

test('stemFilename strips extensions + version suffixes', () => {
  assert.equal(stemFilename('contract-v1.pdf'), 'contract');
  assert.equal(stemFilename('plan_draft.docx'), 'plan');
  assert.equal(stemFilename('report-2026-05-12.docx'), 'report');
});

test('tryMarkdownTitle finds # Title', () => {
  const r = tryMarkdownTitle('# Acme Annual Report\nFirst paragraph follows.');
  assert.equal(r.source, 'markdown');
  assert.equal(r.title, 'Acme Annual Report');
});

test('tryHtmlTitle finds <title>', () => {
  const r = tryHtmlTitle('<html><head><title>Acme Annual Report</title></head>');
  assert.equal(r.source, 'html-title');
  assert.match(r.title, /Acme Annual Report/);
});

test('tryHtmlTitle falls back to <h1>', () => {
  const r = tryHtmlTitle('<body><h1>Q1 Recap</h1><p>Text.</p></body>');
  assert.equal(r.source, 'html-h1');
});

test('tryPdfHeuristic catches ALL-CAPS title-like line', () => {
  const r = tryPdfHeuristic('ANNUAL REPORT 2026\nDetails follow on the next page.');
  assert.equal(r?.source, 'pdf-heuristic');
  assert.match(r.title, /ANNUAL REPORT/);
});

test('extractTitle falls back to filename when nothing matches', () => {
  const r = extractTitle('Just plain prose, no obvious title here.', 'contract-v2.pdf');
  assert.equal(r.source, 'filename');
  assert.match(r.title, /contract/);
});

test('extractTitle returns confidence levels', () => {
  const md = extractTitle('# Title\nbody', 'a.md');
  assert.ok(md.confidence > 0.9);
  const fb = extractTitle('No title body', 'plain.pdf');
  assert.ok(fb.confidence <= 0.5);
});

test('extractTitle: empty input → filename fallback', () => {
  const r = extractTitle('', 'memo-v1.txt');
  assert.equal(r.source, 'filename');
  assert.equal(r.title, 'memo');
});

test('buildTitlesForFiles produces one entry per file', () => {
  const files = [
    { name: 'a.md', extractedText: '# Title A\nBody A' },
    { name: 'b.md', extractedText: 'Body without title.' },
  ];
  const r = buildTitlesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderTitlesBlock outputs markdown when at least one title detected', () => {
  const files = [{ name: 'a.md', extractedText: '# Annual Report' }];
  const r = buildTitlesForFiles(files);
  const md = renderTitlesBlock(r);
  assert.match(md, /^## DOCUMENT TITLES/);
  assert.match(md, /Annual Report/);
});

test('renderTitlesBlock empty when no files', () => {
  assert.equal(renderTitlesBlock({ perFile: [] }), '');
  assert.equal(renderTitlesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const files = [{ name: 'a', extractedText: null }];
  const r = buildTitlesForFiles(files);
  assert.equal(r.perFile.length, 1);
  assert.equal(r.perFile[0].source, 'filename');
});

test('title length is clipped to safe max', () => {
  const longTitle = 'A '.repeat(120) + 'long title';
  const r = extractTitle(`# ${longTitle}`, 'doc.md');
  assert.ok(r.title.length <= 141);
});

test('prefers markdown over HTML over PDF heuristic when multiple present', () => {
  const text = '# Markdown Wins\n<title>HTML Loses</title>\nPDF HEURISTIC LOSES';
  const r = extractTitle(text, 'doc.md');
  assert.equal(r.source, 'markdown');
});
