'use strict';

// Source-preserving Excel/PowerPoint editing — parity with the DOCX editor.
//
// Before this change, XLSX/PPTX edit requests that the regex planner could
// not parse degraded to a generic appendix sheet/slide. Now:
//   - new executor ops with REAL content: append_rows / add_sheet (xlsx,
//     via exceljs so styles, widths, formulas and other sheets round-trip)
//     and add_slide (pptx, appended through the existing XML machinery that
//     clones the deck's relationships/content-types).
//   - sanitizeOfficeOperations: the LLM plan is validated and bounded before
//     touching the file (unknown kinds dropped, grids capped, strings cut).
//   - the smart planner only takes over when the heuristic produced nothing
//     more specific than append_generic, and fails open to the heuristic.
//
// All tests are offline: workbooks are built with exceljs, decks with
// pptxgenjs, and the LLM planner is never called (no OPENAI key needed).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const PizZip = require('pizzip');

const editor = require('../src/services/source-preserving-document-edit');
const {
  appendRowsToXlsxBuffer,
  addSheetToXlsxBuffer,
  buildXlsxSummaryForPrompt,
  executeXlsxOperations,
  executePptxOperations,
  sanitizeOfficeOperations,
} = editor.INTERNAL;

async function buildWorkbookFixture() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Ventas');
  const header = sheet.addRow(['Mes', 'Total', 'Estado']);
  header.font = { bold: true };
  sheet.addRow(['Enero', 1200, 'pagado']);
  sheet.addRow(['Febrero', 900, 'pendiente']);
  sheet.getColumn(1).width = 18;
  const wb2 = wb.addWorksheet('Notas');
  wb2.addRow(['no tocar esta hoja']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function loadWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

describe('XLSX — append_rows / add_sheet preserve the original workbook', () => {
  test('append_rows adds data to the named sheet and keeps styles + other sheets', async () => {
    const input = await buildWorkbookFixture();
    const { buffer, sheetName, added } = await appendRowsToXlsxBuffer(input, {
      sheetName: 'Ventas',
      rows: [['Marzo', 1500, 'pagado'], ['Abril', 700, 'pendiente']],
    });
    assert.equal(sheetName, 'Ventas');
    assert.equal(added, 2);

    const wb = await loadWorkbook(buffer);
    const ventas = wb.getWorksheet('Ventas');
    assert.equal(ventas.getCell('A4').value, 'Marzo');
    assert.equal(ventas.getCell('B5').value, 700);
    // Original content and formatting survive the round-trip.
    assert.equal(ventas.getCell('A2').value, 'Enero');
    assert.equal(ventas.getRow(1).font?.bold, true, 'header bold preserved');
    assert.ok(Number(ventas.getColumn(1).width) >= 17, 'column width preserved');
    assert.equal(wb.getWorksheet('Notas').getCell('A1').value, 'no tocar esta hoja');
  });

  test('append_rows falls back to the first sheet for unknown names; empty rows throw', async () => {
    const input = await buildWorkbookFixture();
    const { sheetName } = await appendRowsToXlsxBuffer(input, { sheetName: 'NoExiste', rows: [['x']] });
    assert.equal(sheetName, 'Ventas');
    await assert.rejects(() => appendRowsToXlsxBuffer(input, { sheetName: 'Ventas', rows: [] }), /filas/);
  });

  test('add_sheet creates a styled new sheet and dedupes its name', async () => {
    const input = await buildWorkbookFixture();
    const first = await addSheetToXlsxBuffer(input, { name: 'Ventas', rows: [['Mes', 'Total'], ['Mayo', 100]] });
    assert.notEqual(first.sheetName, 'Ventas', 'collides with existing → deduped');
    const wb = await loadWorkbook(first.buffer);
    const sheet = wb.getWorksheet(first.sheetName);
    assert.equal(sheet.getCell('A2').value, 'Mayo');
    assert.equal(sheet.getRow(1).font?.bold, true);
  });

  test('executeXlsxOperations runs a mixed smart plan in order', async () => {
    const input = await buildWorkbookFixture();
    const { buffer, steps } = await executeXlsxOperations({
      input,
      ops: [
        { kind: 'set_cell', sheetName: 'Ventas', address: 'B2', value: '1300' },
        { kind: 'append_rows', sheetName: 'Ventas', rows: [['Marzo', 1500, 'pagado']] },
      ],
      blocks: [],
    });
    assert.deepEqual(steps.map((s) => s.kind), ['set_cell', 'append_rows']);
    const wb = await loadWorkbook(buffer);
    assert.equal(String(wb.getWorksheet('Ventas').getCell('B2').value), '1300');
    assert.equal(wb.getWorksheet('Ventas').getCell('A4').value, 'Marzo');
  });

  test('buildXlsxSummaryForPrompt shows sheets and sample rows for the planner', async () => {
    const summary = await buildXlsxSummaryForPrompt(await buildWorkbookFixture());
    assert.match(summary, /Hoja "Ventas"/);
    assert.match(summary, /Enero/);
    assert.match(summary, /Hoja "Notas"/);
  });
});

describe('PPTX — add_slide appends real content preserving the deck', () => {
  async function buildDeckFixture() {
    const PptxGenJS = require('pptxgenjs');
    const pptx = new PptxGenJS();
    const slide = pptx.addSlide();
    slide.addText('Portada original', { x: 1, y: 1, fontSize: 24 });
    return Buffer.from(await pptx.write({ outputType: 'nodebuffer' }));
  }

  function slideCount(buffer) {
    const zip = new PizZip(buffer);
    return Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
  }

  test('add_slide appends a titled bullet slide; original slide intact', async () => {
    const input = await buildDeckFixture();
    assert.equal(slideCount(input), 1);
    const { buffer, steps } = executePptxOperations({
      input,
      ops: [{ kind: 'add_slide', title: 'Riesgos del proyecto', bullets: ['Retraso de obra', 'Sobrecosto'] }],
      blocks: [],
    });
    assert.equal(steps[0].kind, 'add_slide');
    assert.equal(slideCount(buffer), 2);
    const zip = new PizZip(buffer);
    const newSlide = zip.file('ppt/slides/slide2.xml').asText();
    assert.match(newSlide, /Riesgos del proyecto/);
    assert.match(newSlide, /Retraso de obra/);
    assert.match(zip.file('ppt/slides/slide1.xml').asText(), /Portada original/);
    assert.match(zip.file('ppt/presentation.xml').asText(), /<p:sldId /);
  });
});

describe('sanitizeOfficeOperations — bounded validation of the LLM plan', () => {
  test('keeps valid ops, drops unknown kinds and malformed entries', () => {
    const ops = sanitizeOfficeOperations([
      { kind: 'set_cell', sheetName: 'Ventas', address: 'b2', value: 99 },
      { kind: 'append_rows', sheetName: 'Ventas', rows: [['Marzo', 1500]] },
      { kind: 'replace_text', needle: 'Febrero', replacement: 'Feb.' },
      { kind: 'drop_table', table: 'x' },              // unknown → dropped
      { kind: 'set_cell', address: 'not-a-cell' },      // malformed → dropped
      { kind: 'delete_text', needle: 'ab' },            // needle too short → dropped
    ], 'xlsx');
    assert.deepEqual(ops.map((o) => o.kind), ['set_cell', 'append_rows', 'replace_text']);
    assert.equal(ops[0].address, 'B2');
  });

  test('format gating: xlsx ops rejected for pptx and vice versa', () => {
    assert.equal(sanitizeOfficeOperations([{ kind: 'set_cell', address: 'A1', value: '1' }], 'pptx'), null);
    assert.equal(sanitizeOfficeOperations([{ kind: 'add_slide', title: 'T' }], 'xlsx'), null);
    const pptxOps = sanitizeOfficeOperations([{ kind: 'add_slide', title: 'T', bullets: ['a'] }], 'pptx');
    assert.equal(pptxOps[0].kind, 'add_slide');
  });

  test('caps: ≤15 ops, grids trimmed, empty result → null', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ kind: 'delete_text', needle: `texto ${i}` }));
    assert.equal(sanitizeOfficeOperations(many, 'xlsx').length, 15);
    assert.equal(sanitizeOfficeOperations([], 'xlsx'), null);
    assert.equal(sanitizeOfficeOperations('garbage', 'xlsx'), null);
  });
});
