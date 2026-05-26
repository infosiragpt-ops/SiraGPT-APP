'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { PARSERS, parserPlanFor, semanticChunkingOptions } = require('../src/orchestration/document-pipeline');

test('parserPlanFor routes PDF to marker/docling/unstructured/surya-ocr', () => {
  const pdfFile = { name: 'thesis.pdf', mimeType: 'application/pdf' };
  assert.deepEqual(parserPlanFor(pdfFile), PARSERS.pdf);
});

test('parserPlanFor routes DOCX to markitdown/mammoth', () => {
  const docxFile = { name: 'report.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  assert.deepEqual(parserPlanFor(docxFile), PARSERS.docx);
});

test('parserPlanFor routes XLSX to markitdown/exceljs', () => {
  const xlsxFile = { name: 'data.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  assert.deepEqual(parserPlanFor(xlsxFile), PARSERS.xlsx);
});

test('parserPlanFor routes PPTX to markitdown/officeparser', () => {
  const pptxFile = { name: 'slides.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
  assert.deepEqual(parserPlanFor(pptxFile), PARSERS.pptx);
});

test('parserPlanFor falls back to internal text extractor for unknown types', () => {
  const unknownFile = { name: 'data.dat', mimeType: 'application/octet-stream' };
  assert.deepEqual(parserPlanFor(unknownFile), ['internal-text-extractor']);
});

test('parserPlanFor uses originalName if present', () => {
  const file = { originalName: 'paper.pdf', mimeType: '' };
  assert.deepEqual(parserPlanFor(file), PARSERS.pdf);
});

test('semanticChunkingOptions returns defaults without env vars', () => {
  const opts = semanticChunkingOptions({});
  assert.equal(opts.chunkSize, 1200);
  assert.equal(opts.overlap, 200);
  assert.equal(opts.embeddingProvider, 'voyage');
  assert.equal(opts.fallbackEmbeddingProvider, 'jina');
});

test('semanticChunkingOptions respects custom env vars', () => {
  const opts = semanticChunkingOptions({
    SIRAGPT_SEMANTIC_CHUNK_SIZE: '800',
    SIRAGPT_SEMANTIC_CHUNK_OVERLAP: '100',
    SIRAGPT_MEMORY_EMBED_PROVIDER: 'jina',
  });
  assert.equal(opts.chunkSize, 800);
  assert.equal(opts.overlap, 100);
  assert.equal(opts.embeddingProvider, 'jina');
});
