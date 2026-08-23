'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  pdfExportFilterFor,
  buildSofficeConvertArgs,
  isNativePdfFilename,
} = require('../src/services/document-pipeline/soffice-pdf-export');

describe('soffice-pdf-export filters', () => {
  it('uses Writer PDF export for Word (page size + margins)', () => {
    assert.equal(pdfExportFilterFor('tesis.docx'), 'pdf:writer_pdf_Export');
    assert.equal(pdfExportFilterFor('informe.doc'), 'pdf:writer_pdf_Export');
    assert.equal(pdfExportFilterFor('nota.odt'), 'pdf:writer_pdf_Export');
  });

  it('uses Impress PDF export for decks', () => {
    assert.equal(pdfExportFilterFor('deck.pptx'), 'pdf:impress_pdf_Export');
    assert.equal(pdfExportFilterFor('slides.ppt'), 'pdf:impress_pdf_Export');
  });

  it('uses Calc PDF export for spreadsheets', () => {
    assert.equal(pdfExportFilterFor('tabla.xlsx'), 'pdf:calc_pdf_Export');
    assert.equal(pdfExportFilterFor('datos.csv'), 'pdf:calc_pdf_Export');
  });

  it('buildSofficeConvertArgs isolates the profile and keeps page geometry', () => {
    const args = buildSofficeConvertArgs({
      sourcePath: '/tmp/in/tesis.docx',
      outDir: '/tmp/out',
      profileDir: '/tmp/profile',
    });
    assert.ok(args[0].startsWith('-env:UserInstallation=file://'));
    assert.ok(args.includes('--headless'));
    assert.ok(args.includes('--nolockcheck'));
    const convertAt = args.indexOf('--convert-to');
    assert.ok(convertAt >= 0);
    assert.equal(args[convertAt + 1], 'pdf:writer_pdf_Export');
    assert.ok(args.includes('--outdir'));
    assert.ok(args.includes(path.resolve('/tmp/in/tesis.docx')));
  });

  it('recognises native PDFs so soffice is skipped', () => {
    assert.equal(isNativePdfFilename('paper.pdf'), true);
    assert.equal(isNativePdfFilename('paper.PDF'), true);
    assert.equal(isNativePdfFilename('paper.docx'), false);
  });
});
