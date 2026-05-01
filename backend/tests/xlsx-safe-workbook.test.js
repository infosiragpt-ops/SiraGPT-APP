const test = require('node:test');
const assert = require('node:assert/strict');

const {
  addRowsWorksheet,
  createWorkbook,
  readXlsxBuffer,
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
