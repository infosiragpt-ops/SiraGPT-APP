const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

const {
  countXlsxStructure,
  validateXlsxWorkbook,
  expectsCells,
} = require('../src/services/agents/xlsx-workbook-validator');

async function makeXlsxBuffer({ sheetRefs = 1, sheetFiles = 1, cellsPerSheet = 5 } = {}) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  const refs = Array.from({ length: sheetRefs }, (_, i) =>
    `<sheet name="Hoja${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
  ).join('');
  zip.file('xl/workbook.xml',
    '<?xml version="1.0"?>'
    + '<workbook xmlns:r="x">'
    + `<sheets>${refs}</sheets>`
    + '</workbook>');
  for (let i = 1; i <= sheetFiles; i += 1) {
    const cells = Array.from({ length: cellsPerSheet }, (_, j) =>
      `<c r="A${j + 1}"><v>${j + 1}</v></c>`,
    ).join('');
    zip.file(`xl/worksheets/sheet${i}.xml`,
      `<worksheet><sheetData><row>${cells}</row></sheetData></worksheet>`);
  }
  return await zip.generateAsync({ type: 'nodebuffer' });
}

test('countXlsxStructure counts sheet refs, sheet files, and total cells', async () => {
  const buf = await makeXlsxBuffer({ sheetRefs: 2, sheetFiles: 2, cellsPerSheet: 4 });
  const result = await countXlsxStructure(buf);
  assert.equal(result.ok, true);
  assert.equal(result.sheetRefs, 2);
  assert.equal(result.sheetFiles, 2);
  assert.equal(result.cellCount, 8, '4 cells × 2 sheets');
});

test('countXlsxStructure fails closed on empty / non-zip / missing-workbook', async () => {
  assert.equal((await countXlsxStructure(Buffer.alloc(0))).ok, false);
  assert.match((await countXlsxStructure(Buffer.from('not-zip' + 'x'.repeat(300)))).reason, /zip_open_failed/);
  const wrong = new JSZip();
  wrong.file('foo/bar.xml', '<x/>');
  const buf = await wrong.generateAsync({ type: 'nodebuffer' });
  const result = await countXlsxStructure(buf);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_workbook_xml');
});

test('expectsCells matches Excel / spreadsheet vocabulary', () => {
  assert.equal(expectsCells('genera un Excel con 30 filas Likert'), true);
  assert.equal(expectsCells('Build a workbook for Cronbach'), true);
  assert.equal(expectsCells('hoja de cálculo de inventario'), true);
  assert.equal(expectsCells('Pure marketing brief'), false);
});

test('validateXlsxWorkbook passes a populated workbook', async () => {
  const buf = await makeXlsxBuffer({ sheetRefs: 1, sheetFiles: 1, cellsPerSheet: 10 });
  const result = await validateXlsxWorkbook({
    buffer: buf,
    prompt: 'crea un excel con datos',
  });
  assert.equal(result.ok, true);
  assert.equal(result.cellCount, 10);
});

test('validateXlsxWorkbook BLOCKS a 0-sheet workbook', async () => {
  const zip = new JSZip();
  zip.file('xl/workbook.xml', '<workbook><sheets/></workbook>');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });

  const result = await validateXlsxWorkbook({
    buffer: buf,
    prompt: 'genera un excel',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_sheets');
});

test('validateXlsxWorkbook BLOCKS sheet-manifest mismatches (refs > files)', async () => {
  const buf = await makeXlsxBuffer({ sheetRefs: 3, sheetFiles: 1 });
  const result = await validateXlsxWorkbook({ buffer: buf, prompt: 'excel con 3 hojas' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'sheet_manifest_mismatch');
});

test('validateXlsxWorkbook BLOCKS empty content when cells were expected', async () => {
  const buf = await makeXlsxBuffer({ sheetRefs: 1, sheetFiles: 1, cellsPerSheet: 0 });
  const result = await validateXlsxWorkbook({
    buffer: buf,
    prompt: 'excel con datos Likert',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_cell_content');
});

test('validateXlsxWorkbook does NOT block a no-cell workbook when only structure was expected', async () => {
  // Empty workbook + non-data prompt → pass (the user maybe wanted
  // a blank template).
  const buf = await makeXlsxBuffer({ sheetRefs: 1, sheetFiles: 1, cellsPerSheet: 0 });
  const result = await validateXlsxWorkbook({
    buffer: buf,
    prompt: 'plantilla excel vacía',
  });
  // contentExpected=false because the prompt mentions excel but no
  // data-shape vocabulary; the validator passes with a structural
  // OK and empty cellCount.
  assert.equal(result.ok, true);
  assert.equal(result.cellCount, 0);
});
