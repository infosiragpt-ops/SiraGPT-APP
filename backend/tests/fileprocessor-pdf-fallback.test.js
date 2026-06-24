/**
 * Regression tests for the scanned/image-only PDF fallback in
 * fileProcessor.processPDF.
 *
 * Bug: when the streaming PDF extractor reported pages (pageCount > 0) but no
 * text layer (every page's text empty — a scanned/photographed PDF), processPDF
 * returned a header-only "0 characters" result and NEVER ran OCR, so the user's
 * scan was silently un-analyzable. The fix makes the streaming early-return
 * conditional on actually capturing text; otherwise control falls through to the
 * pdf-parse + hybrid-OCR path.
 *
 * Everything is stubbed via require.cache BEFORE fileProcessor is required, so
 * there is no real PDF parsing, OCR, or network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- Stubs installed before requiring fileProcessor ---

// 1) Streaming extractor: pretend the PDF has pages but NO text layer.
let streamingResult = { pageCount: 3, totalPages: 3, totalChars: 0, partial: false, pages: [] };
require.cache[require.resolve('../src/services/document/streaming-pdf')] = {
  exports: {
    extractPdfStreaming: async () => streamingResult,
  },
};

// 2) pdf-parse fallback: controllable text length.
let pdfParseText = '';
require.cache[require.resolve('pdf-parse')] = {
  exports: async () => ({ text: pdfParseText, numpages: 3 }),
};

// 3) OCR engine: returns a recognizable string so we can assert OCR ran.
let ocrText = 'OCR-RECOVERED-TEXT';
require.cache[require.resolve('../src/services/ocr-engine')] = {
  exports: {
    extractFromImage: async () => ({ text: '', ocr: {} }),
    extractFromPdfImages: async () => ({ text: ocrText, ocr: { provider: 'tesseract', confidence: 0.8 } }),
    hasUsefulText: (t) => !!t && t.length > 0,
    skipped: (reason) => ({ text: '', ocr: { reason, status: 'skipped' } }),
  },
};

const fileProcessor = require('../src/services/fileProcessor');

function tempPdf() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-pdf-'));
  const file = path.join(dir, 'in.pdf');
  fs.writeFileSync(file, '%PDF-1.4 dummy');
  return file;
}

test('image-only PDF (streaming yields 0 chars) falls through to OCR instead of returning an empty result', async () => {
  streamingResult = { pageCount: 3, totalPages: 3, totalChars: 0, partial: false, pages: [{ page: 1, text: '' }, { page: 2, text: '   ' }, { page: 3, text: '' }] };
  pdfParseText = '';        // pdf-parse also finds no text layer → triggers OCR
  ocrText = 'OCR-RECOVERED-TEXT';

  const out = await fileProcessor.processPDF(tempPdf(), { detailed: true });
  assert.match(out.extractedText, /OCR-RECOVERED-TEXT/, 'scanned PDF must be OCR-ed, not returned empty');
  assert.equal(/0 characters/.test(out.extractedText), false, 'must NOT return the header-only "0 characters" result');
});

test('image-only streaming but a recoverable text layer via pdf-parse is used (no false OCR)', async () => {
  streamingResult = { pageCount: 2, totalPages: 2, totalChars: 0, partial: false, pages: [{ page: 1, text: '' }, { page: 2, text: '' }] };
  pdfParseText = 'R'.repeat(250); // pdf-parse recovers real text (>100 chars)
  ocrText = 'SHOULD-NOT-BE-USED';

  const out = await fileProcessor.processPDF(tempPdf(), { detailed: true });
  assert.match(out.extractedText, /R{250}/, 'pdf-parse-recovered text must be used');
  assert.equal(/SHOULD-NOT-BE-USED/.test(out.extractedText), false, 'OCR must not run when pdf-parse recovers text');
});

test('streaming WITH a real text layer still returns directly (no regression)', async () => {
  streamingResult = {
    pageCount: 2, totalPages: 2, totalChars: 40, partial: false,
    pages: [{ page: 1, text: 'Contenido real de la página uno.' }, { page: 2, text: '' }],
  };
  pdfParseText = 'SHOULD-NOT-BE-USED';
  ocrText = 'SHOULD-NOT-BE-USED';

  const out = await fileProcessor.processPDF(tempPdf(), { detailed: true });
  assert.match(out.extractedText, /Contenido real de la página uno/);
  assert.equal(out.ocr.streaming, true, 'kept the fast streaming path');
  assert.equal(/SHOULD-NOT-BE-USED/.test(out.extractedText), false);
});
