const test = require('node:test');
const assert = require('node:assert/strict');

const {
  addRowsWorksheet,
  inferNumericColumns,
  cellToText,
  createWorkbook,
  defangCellText,
  getXlsxMaxSheets,
  readXlsxBuffer,
  selectWorkbookWorksheets,
  shouldDefangCellText,
  worksheetRows,
  writeWorkbookBuffer,
} = require('../src/services/xlsx-safe-workbook');

test('xlsx-safe-workbook writes and reads a valid ExcelJS workbook', async () => {
  const workbook = createWorkbook();
  addRowsWorksheet(workbook, 'Data', [
    ['Nombre', 'Puntaje'],
    ['Ada', 42],
    ['Grace', 99],
  ]);

  const buffer = await writeWorkbookBuffer(workbook);
  assert.equal(Buffer.isBuffer(buffer), true);

  const parsed = await readXlsxBuffer(buffer);
  const sheet = parsed.getWorksheet('Data');
  assert.ok(sheet);
  assert.equal(sheet.getCell('A2').text, 'Ada');
  assert.equal(sheet.getCell('B3').value, 99);
});

test('worksheetRows applies row and column bounds before preview extraction', () => {
  const workbook = createWorkbook();
  const rows = [
    ['A', 'B', 'C'],
    ['r1c1', 'r1c2', 'r1c3'],
    ['r2c1', 'r2c2', 'r2c3'],
    ['r3c1', 'r3c2', 'r3c3'],
  ];
  const sheet = addRowsWorksheet(workbook, 'Bounded', rows);

  assert.deepEqual(worksheetRows(sheet, { maxRows: 3, maxColumns: 2 }), [
    ['A', 'B'],
    ['r1c1', 'r1c2'],
    ['r2c1', 'r2c2'],
  ]);
});

test('xlsx-safe-workbook defangs formula-injection prefixes in extracted text', () => {
  assert.equal(shouldDefangCellText('=cmd|\' /C calc\'!A0'), true);
  assert.equal(shouldDefangCellText('+SUM(A1:A2)'), true);
  assert.equal(shouldDefangCellText('-10+20'), true);
  assert.equal(shouldDefangCellText('@HYPERLINK("https://evil")'), true);
  assert.equal(shouldDefangCellText('\t=cmd'), true);
  assert.equal(shouldDefangCellText('\r=cmd'), true);
  assert.equal(shouldDefangCellText(' =cmd'), true);
  assert.equal(shouldDefangCellText('\u00a0=cmd'), true);
  assert.equal(shouldDefangCellText('\uFEFF=cmd'), true);
  assert.equal(shouldDefangCellText('\u200B=cmd'), true);
  assert.equal(shouldDefangCellText('ordinary text'), false);

  assert.equal(defangCellText('=cmd'), "'=cmd");
  assert.equal(defangCellText('+SUM(A1:A2)'), "'+SUM(A1:A2)");
  assert.equal(defangCellText('-10+20'), "'-10+20");
  assert.equal(defangCellText('@HYPERLINK("https://evil")'), "'@HYPERLINK(\"https://evil\")");
  assert.equal(defangCellText('safe'), 'safe');
  assert.equal(defangCellText('=cmd', { enabled: false }), '=cmd');
  assert.equal(defangCellText(defangCellText('=cmd')), "'=cmd");
  assert.equal(cellToText(-10), '-10');
  assert.equal(cellToText({ value: -10, text: '-10' }), '-10');
  assert.equal(cellToText({ value: true, text: 'true' }), 'true');
});

test('worksheetRows defangs dangerous spreadsheet text and formula fallbacks', () => {
  const workbook = createWorkbook();
  const sheet = addRowsWorksheet(workbook, 'Danger', [
    ['Name', 'Payload'],
    ['A', '=cmd|\' /C calc\'!A0'],
    ['B', '+SUM(A1:A2)'],
  ]);
  sheet.getCell('B4').value = { formula: 'HYPERLINK("https://evil.example", "x")' };

  assert.deepEqual(worksheetRows(sheet, { maxRows: 4, maxColumns: 2 }), [
    ['Name', 'Payload'],
    ['A', "'=cmd|' /C calc'!A0"],
    ['B', "'+SUM(A1:A2)"],
    ['', "'=HYPERLINK(\"https://evil.example\", \"x\")"],
  ]);

  assert.equal(cellToText({ formula: 'SUM(A1:A2)' }, { enabled: false }), '=SUM(A1:A2)');
});

test('selectWorkbookWorksheets applies a bounded sheet cap with env override', () => {
  const workbook = createWorkbook();
  for (let i = 1; i <= 8; i += 1) {
    addRowsWorksheet(workbook, `Sheet${i}`, [['A'], [i]]);
  }

  const previous = process.env.SIRAGPT_XLSX_MAX_SHEETS;
  try {
    delete process.env.SIRAGPT_XLSX_MAX_SHEETS;
    const defaultSelection = selectWorkbookWorksheets(workbook);
    assert.equal(defaultSelection.total, 8);
    assert.equal(defaultSelection.worksheets.length, 5);
    assert.equal(defaultSelection.skipped, 3);
    assert.equal(defaultSelection.maxSheets, 5);

    process.env.SIRAGPT_XLSX_MAX_SHEETS = '7';
    const envSelection = selectWorkbookWorksheets(workbook);
    assert.equal(getXlsxMaxSheets(), 7);
    assert.equal(envSelection.worksheets.length, 7);
    assert.equal(envSelection.skipped, 1);

    process.env.SIRAGPT_XLSX_MAX_SHEETS = '10000';
    assert.equal(selectWorkbookWorksheets(workbook).maxSheets, 100);
  } finally {
    if (previous == null) delete process.env.SIRAGPT_XLSX_MAX_SHEETS;
    else process.env.SIRAGPT_XLSX_MAX_SHEETS = previous;
  }
});

test('cellToText defangs rich text and hyperlink text while preserving numeric results', () => {
  assert.equal(cellToText({ richText: [{ text: '=' }, { text: 'cmd()' }] }), "'=cmd()");
  assert.equal(cellToText({ hyperlink: 'https://example.test', text: '=click' }), "'=click");
  assert.equal(cellToText({ formula: 'SUM(A1:A2)', result: 0 }), '0');
});

test('selectWorkbookWorksheets fails closed on invalid caps and empty workbook shapes', () => {
  const workbook = createWorkbook();
  addRowsWorksheet(workbook, 'Only', [['A'], [1]]);

  assert.equal(selectWorkbookWorksheets(workbook, { maxSheets: 0 }).worksheets.length, 1);
  assert.equal(selectWorkbookWorksheets(workbook, { maxSheets: -10 }).worksheets.length, 1);
  assert.deepEqual(selectWorkbookWorksheets({ worksheets: undefined }), {
    worksheets: [],
    total: 0,
    skipped: 0,
    maxSheets: 5,
  });
});

test('excelColLetter: two-letter columns beyond 26 (not capped at Z)', () => {
  const { excelColLetter } = require('../src/services/xlsx-safe-workbook');
  assert.equal(excelColLetter(1), 'A');
  assert.equal(excelColLetter(26), 'Z');
  assert.equal(excelColLetter(27), 'AA'); // used to wrongly return 'Z'
  assert.equal(excelColLetter(52), 'AZ');
  assert.equal(excelColLetter(53), 'BA');
  assert.equal(excelColLetter(703), 'AAA');
  assert.equal(excelColLetter(0), '');
});

// ── Professional styling defaults (added with the doc-design overhaul) ──────

test('addRowsWorksheet applies professional defaults: freeze, autofilter, header fill, numFmt', async () => {
  const wb = createWorkbook();
  const rows = [
    ['Producto', 'Precio', 'Stock'],
    ['Paracetamol', 12.5, 120],
    ['Ibuprofeno', 18.9, 80],
    ['Amoxicilina', 25.0, 45],
  ];
  addRowsWorksheet(wb, 'Inventario', rows);
  const buffer = await writeWorkbookBuffer(wb);
  const reopened = await readXlsxBuffer(buffer);
  const ws = reopened.getWorksheet('Inventario');
  assert.equal(ws.views?.[0]?.state, 'frozen', 'header row frozen');
  assert.equal(ws.views?.[0]?.ySplit, 1);
  assert.ok(ws.autoFilter, 'autofilter present');
  const header = ws.getRow(1);
  assert.equal(header.getCell(1).fill?.pattern, 'solid', 'header fill applied');
  assert.equal(header.font?.bold, true);
  // Precio detected as currency (header keyword) → 2-decimal format
  assert.equal(ws.getRow(2).getCell(2).numFmt, '#,##0.00');
  // Stock numeric but not currency
  assert.equal(ws.getRow(2).getCell(3).numFmt, '#,##0.##');
  // First (text) column untouched
  assert.ok(!ws.getRow(2).getCell(1).numFmt);
});

test('addRowsWorksheet {plain:true} keeps the legacy bare grid', async () => {
  const wb = createWorkbook();
  addRowsWorksheet(wb, 'Plano', [['a', 'b'], ['1', '2']], { plain: true });
  const buffer = await writeWorkbookBuffer(wb);
  const reopened = await readXlsxBuffer(buffer);
  const ws = reopened.getWorksheet('Plano');
  assert.ok(!ws.autoFilter, 'no autofilter in plain mode');
  assert.notEqual(ws.views?.[0]?.state, 'frozen');
});

test('inferNumericColumns: 70% threshold, currency by header keyword, numeric strings count', () => {
  const { numeric, currency } = inferNumericColumns([
    ['Nombre', 'Total USD', 'Unidades', 'Notas'],
    ['a', 100.5, '12', 'texto'],
    ['b', 200.1, '30', 'más texto'],
    ['c', 150.2, 'n/a', 'otro'],
  ]);
  assert.ok(numeric.has(1), 'Total USD numeric');
  assert.ok(currency.has(1), 'Total USD currency by header');
  assert.ok(!numeric.has(2), 'Unidades at 2/3 numeric (67%) stays below the 70% threshold');
  assert.ok(!numeric.has(3), 'Notas text');
});
