'use strict';

// QA acceptance suite for in-place document editing (CEO Office mission: QA
// Suite Edicion Documentos y CI Pipeline, 2026-08-19).
//
// Covers the exact acceptance scenarios for throughput-critical editing:
//   - change text in a SPECIFIC element (slide / cell / paragraph) without
//     touching the rest of the file (PPTX/DOCX/XLSX),
//   - ADD an element (row / paragraph) without altering the layout.
//
// All tests are offline: decks are built with pptxgenjs, workbooks with
// exceljs, DOCX fixtures with the docx packer. No LLM, no network.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const PptxGenJS = require('pptxgenjs');
const ExcelJS = require('exceljs');
const PizZip = require('pizzip');
const { Document, Packer, Paragraph, TextRun } = require('docx');

const pptxAdapter = require('../src/services/document-editing/pptx-adapter');
const xlsxAdapter = require('../src/services/document-editing/xlsx-adapter');
const { appendToDocxBuffer } = require('../src/services/source-preserving-document-edit');

function zipSnapshot(buffer) {
  const zip = new PizZip(buffer);
  const map = {};
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    map[name] = zip.files[name].asText();
  }
  return map;
}

async function makeDeck() {
  const pptx = new PptxGenJS();
  pptx.defineSlideMaster({ title: 'MASTER_SLIDE', bkgd: 'FFFFFF', objects: [] });
  pptx.layout = 'LAYOUT_WIDE';
  const slide1 = pptx.addSlide();
  slide1.addText('Nuevo presupuesto', { x: 0.5, y: 0.3, w: 8, h: 0.6, bold: true, fontSize: 28 });
  slide1.addText('Aumentar ingresos', { x: 0.5, y: 1.2, w: 8, h: 0.6, fontSize: 18 });
  const slide2 = pptx.addSlide();
  slide2.addText('Cierre', { x: 0.5, y: 0.3, w: 8, h: 0.6, bold: true, fontSize: 28 });
  return Buffer.from(await pptx.write({ outputType: 'nodebuffer' }));
}

async function makeWorkbook() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Ventas');
  ws.addRow(['Mes', 'Total', 'Estado']);
  ws.addRow(['Enero', 1200, 'pendiente']);
  ws.addRow(['Febrero', 800, 'pendiente']);
  ws.getCell('A1').font = { bold: true };
  ws.mergeCells('A1:C1');
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('QA · in-place text change does not touch the rest of the file', () => {
  test('PPTX: replaceSlideText changes body text ONLY in the requested slide', async () => {
    const deck = await makeDeck();
    const result = pptxAdapter.replaceSlideText({
      buffer: deck,
      slideNumber: 1,
      needle: 'Aumentar ingresos',
      replacement: 'reemplazado limpio',
    });
    const after = zipSnapshot(result.buffer);
    assert.match(after['ppt/slides/slide1.xml'], /reemplazado limpio/);
    assert.doesNotMatch(after['ppt/slides/slide1.xml'], /Aumentar ingresos/);
    assert.match(after['ppt/slides/slide2.xml'], /Cierre/);
    assert.doesNotMatch(after['ppt/slides/slide2.xml'], /reemplazado limpio/);
  });

  test('XLSX: setCellValue edits ONLY the target cell', async () => {
    const buf = await makeWorkbook();
    const r = xlsxAdapter.setCellValue({ buffer: buf, sheet: 'Ventas', cellRef: 'C3', value: 'Completado' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.buffer);
    const ws = wb.getWorksheet('Ventas');
    assert.equal(ws.getCell('C3').value, 'Completado');
    assert.equal(ws.getCell('C2').value, 'pendiente');
    assert.equal(ws.getCell('A2').value, 'Enero');
    assert.equal(ws.getCell('A1').value, 'Mes');
  });

  test('DOCX: title span replaced, rest of the body byte-identical', async () => {
    const source = Buffer.from(await Packer.toBuffer(new Document({
      sections: [{
        children: [
          new Paragraph({ alignment: 1, children: [new TextRun({ text: 'Poder Judicial de Ayacucho — Aspectos', bold: true })] }),
          new Paragraph('Cuerpo base que no debe mutar.'),
        ],
      }],
    })));
    const editor = require('../src/services/source-preserving-document-edit');
    const { replaceTextInDocxBuffer } = editor.INTERNAL;
    const { buffer: edited, changedCount } = replaceTextInDocxBuffer(source, 'Ayacucho', 'Cajamarca');
    const xml = zipSnapshot(edited)['word/document.xml'];
    assert.ok(changedCount >= 1);
    assert.match(xml, /Cajamarca/);
    assert.doesNotMatch(xml, /Ayacucho/);
    assert.match(xml, /Cuerpo base que no debe mutar\./);
    assert.match(xml, /Poder /);
  });
});

describe('QA · adding an element preserves the surrounding layout', () => {
  test('XLSX: append a row without disturbing the header and other rows', async () => {
    const buf = await makeWorkbook();
    const editor = require('../src/services/source-preserving-document-edit');
    const { appendRowsToXlsxBuffer } = editor.INTERNAL;
    const { buffer, added } = await appendRowsToXlsxBuffer(buf, {
      sheetName: 'Ventas',
      rows: [['Marzo', 1500, 'pagado']],
    });
    assert.equal(added, 1);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet('Ventas');
    assert.equal(ws.getCell('A4').value, 'Marzo');
    assert.equal(ws.getCell('B4').value, 1500);
    assert.equal(ws.getCell('A1').value, 'Mes');
    assert.equal(ws.getCell('A2').value, 'Enero');
    assert.equal(ws.getCell('A3').value, 'Febrero');
  });

  test('DOCX: appendToDocxBuffer adds a paragraph keeping the original body', async () => {
    const source = Buffer.from(await Packer.toBuffer(new Document({
      sections: [{
        children: [
          new Paragraph('Capítulo 1. Introducción original'),
          new Paragraph('La informalidad afecta la recaudación fiscal.'),
        ],
      }],
    })));
    const edited = appendToDocxBuffer(source, [
      { type: 'paragraph', text: 'ANEXOS' },
      { type: 'paragraph', text: 'Instrumento de recolección de datos' },
    ]);
    const xml = zipSnapshot(edited)['word/document.xml'];
    assert.match(xml, /Capítulo 1\. Introducción original/);
    assert.match(xml, /La informalidad afecta la recaudación fiscal/);
    assert.match(xml, /ANEXOS/);
    assert.match(xml, /Instrumento de recolección de datos/);
  });
});