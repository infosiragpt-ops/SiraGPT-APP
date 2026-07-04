'use strict';

// Stage 4 of the DocumentEditingService: SAFE PDF operations (rotate /
// extract / remove pages, merge, text overlay) via pdf-lib. Deep content
// edits stay on the legacy path — PDF is not editable like Office.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const adapter = require('../src/services/document-editing/pdf-adapter');
const editor = require('../src/services/source-preserving-document-edit');
const { parsePdfEditRequest, tryGenerateSourcePreservingDocumentEdit } = editor;

async function makePdf(pages = 3) {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i += 1) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Página ${i} contenido`, { x: 50, y: 780, size: 18, font });
  }
  return Buffer.from(await doc.save());
}

function prismaFakeFor(rows) {
  return {
    file: { async findMany() { return rows; } },
    generatedArtifact: { async findMany() { return []; } },
    message: { async findMany() { return []; } },
  };
}

describe('pdf-adapter', () => {
  test('rotate all pages 90°', async () => {
    const buf = await makePdf(2);
    const r = await adapter.rotatePdfPages({ buffer: buf, degrees: 90 });
    assert.equal(r.pageCount, 2);
    const { PDFDocument } = require('pdf-lib');
    const doc = await PDFDocument.load(r.buffer);
    assert.equal(doc.getPage(0).getRotation().angle, 90);
    assert.equal(doc.getPage(1).getRotation().angle, 90);
  });

  test('extract pages 2-3 produces a 2-page pdf; remove page 2 leaves 2', async () => {
    const buf = await makePdf(3);
    const ex = await adapter.extractPdfPages({ buffer: buf, pages: [2, 3] });
    assert.equal(ex.pageCount, 2);
    const rm = await adapter.removePdfPages({ buffer: buf, pages: [2] });
    assert.equal(rm.pageCount, 2);
  });

  test('merge two pdfs concatenates pages in order', async () => {
    const a = await makePdf(2);
    const b = await makePdf(3);
    const m = await adapter.mergePdfBuffers({ buffers: [a, b] });
    assert.equal(m.pageCount, 5);
    assert.equal(m.merged, 2);
  });

  test('text overlay keeps the pdf valid and page count intact', async () => {
    const buf = await makePdf(1);
    const r = await adapter.addPdfTextOverlay({ buffer: buf, page: 1, text: 'REVISADO por Dirección' });
    assert.equal(r.page, 1);
    const { PDFDocument } = require('pdf-lib');
    const doc = await PDFDocument.load(r.buffer);
    assert.equal(doc.getPageCount(), 1);
  });

  test('clear errors: out-of-range page, removing every page, non-pdf bytes', async () => {
    const buf = await makePdf(2);
    await assert.rejects(() => adapter.removePdfPages({ buffer: buf, pages: [9] }), /no existe/);
    await assert.rejects(() => adapter.removePdfPages({ buffer: buf, pages: [1, 2] }), /todas las p/);
    await assert.rejects(() => adapter.getPdfInfo(Buffer.from('hola')), /no es un PDF/);
  });
});

describe('parsePdfEditRequest', () => {
  test('rotate / remove / extract / merge / overlay phrasings', () => {
    assert.equal(parsePdfEditRequest('rota la página 2 del pdf').kind, 'rotate_pages');
    assert.deepEqual(parsePdfEditRequest('elimina las páginas 2 y 4').pages, [2, 4]);
    assert.deepEqual(parsePdfEditRequest('extrae las páginas 2 a 5').pages, [2, 3, 4, 5]);
    assert.equal(parsePdfEditRequest('une los pdf en uno solo').kind, 'merge_pdfs');
    const ov = parsePdfEditRequest('agrega el texto "BORRADOR" en la página 1');
    assert.equal(ov.kind, 'text_overlay');
    assert.equal(ov.text, 'BORRADOR');
  });

  test('deep-edit and unrelated phrasings return null (legacy path keeps them)', () => {
    assert.equal(parsePdfEditRequest('corrige la redacción del segundo párrafo'), null);
    assert.equal(parsePdfEditRequest('¿de qué trata este pdf?'), null);
  });
});

describe('pdf surgical edit — end to end', () => {
  test('rotate through the chat flow: artifact persisted, original untouched', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-e2e-'));
    const p = path.join(tmp, 'informe.pdf');
    const original = await makePdf(3);
    fs.writeFileSync(p, original);

    const prisma = prismaFakeFor([
      { id: 'file-pdf', userId: 'user-1', filename: 'informe.pdf', originalName: 'informe.pdf', mimeType: 'application/pdf', size: original.length, path: p },
    ]);

    const result = await tryGenerateSourcePreservingDocumentEdit({
      prisma,
      userId: 'user-1',
      chatId: 'chat-1',
      fileIds: ['file-pdf'],
      prompt: 'rota la página 2 del pdf 90 grados',
      displayPrompt: 'rota la página 2 del pdf 90 grados',
    });

    assert.equal(result.format, 'pdf');
    assert.equal(result.clarification, undefined);
    assert.equal(result.validation.passed, true, JSON.stringify(result.validation.checks));
    assert.match(result.file.filename, /rotado\.pdf$/);
    const { PDFDocument } = require('pdf-lib');
    const doc = await PDFDocument.load(fs.readFileSync(result.artifact.path));
    assert.equal(doc.getPage(1).getRotation().angle, 90, 'page 2 rotated');
    assert.equal(doc.getPage(0).getRotation().angle, 0, 'page 1 untouched');
    assert.ok(fs.readFileSync(p).equals(original), 'original upload never changes');
  });
});
