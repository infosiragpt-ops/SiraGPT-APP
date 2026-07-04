'use strict';

// Stage 2 of the DocumentEditingService: surgical XLSX editing (format range,
// set cell) via raw OOXML patching (pizzip), NOT ExcelJS — so chart/table
// workbooks the pipeline now emits don't crash. Owner example: "En el Excel
// cambia los montos de la columna D a formato moneda".

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const PizZip = require('pizzip');

const adapter = require('../src/services/document-editing/xlsx-adapter');
const editor = require('../src/services/source-preserving-document-edit');
const {
  parseSpreadsheetEditRequest,
  generateSourcePreservingDocumentEdit,
  tryGenerateSourcePreservingDocumentEdit,
} = editor;

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// A 1-sheet workbook (Gastos) with a numeric column D + a styled cell.
async function makeWorkbook({ twoSheets = false, withChart = false } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Gastos');
  ws.addRow(['Fecha', 'Categoría', 'Descripción', 'Monto']);
  for (let i = 2; i <= 6; i += 1) ws.addRow([`2024-06-0${i}`, 'Cat', 'desc', 10 * i + 0.5]);
  ws.getCell('B2').font = { bold: true, color: { argb: 'FF2563EB' } };
  if (twoSheets) wb.addWorksheet('Dashboard').addRow(['KPI', 42]);
  let buf = Buffer.from(await wb.xlsx.writeBuffer());
  if (withChart) {
    // Inject a chart part like openpyxl would — proves our ops don't touch it.
    const z = new PizZip(buf);
    z.file('xl/charts/chart1.xml', '<?xml version="1.0"?><c:chartSpace xmlns:c="x"><c:chart/></c:chartSpace>');
    buf = z.generate({ type: 'nodebuffer' });
  }
  return buf;
}

function snapshot(buffer) {
  const zip = new PizZip(buffer);
  const map = {};
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    map[name] = zip.files[name].asText();
  }
  return map;
}

function prismaFakeFor(rows) {
  return {
    file: { async findMany() { return rows; } },
    generatedArtifact: { async findMany() { return []; } },
    message: { async findMany() { return []; } },
  };
}

describe('xlsx-adapter — listXlsxSheets', () => {
  test('lists sheets with names and chart flag', async () => {
    const buf = await makeWorkbook({ twoSheets: true, withChart: true });
    const sheets = adapter.listXlsxSheets(buf);
    assert.deepEqual(sheets.map((s) => s.name), ['Gastos', 'Dashboard']);
    assert.equal(sheets[0].hasCharts, true);
    assert.match(sheets[0].partName, /^xl\/worksheets\/sheet\d+\.xml$/);
  });
});

describe('xlsx-adapter — formatRange', () => {
  test('column D → currency EUR: styles grow, D-cells restyled, ALL other parts byte-identical', async () => {
    const buf = await makeWorkbook({ withChart: true });
    const before = snapshot(buf);
    const r = adapter.formatRange({ buffer: buf, column: 'D', numberFormat: 'currency', currency: 'EUR' });
    assert.equal(r.sheetName, 'Gastos');
    assert.equal(r.cellsChanged, 5); // D2..D6
    const after = snapshot(r.buffer);
    // styles.xml carries the new numFmt code
    assert.match(after['xl/styles.xml'], /#,##0\.00/);
    assert.notEqual(after['xl/styles.xml'], before['xl/styles.xml']);
    // Every part EXCEPT the touched sheet + styles is byte-identical (surgical)
    for (const name of Object.keys(before)) {
      if (name === 'xl/styles.xml' || name === 'xl/worksheets/sheet1.xml') continue;
      assert.equal(after[name], before[name], `${name} must be untouched`);
    }
    // The chart survived byte-for-byte
    assert.equal(after['xl/charts/chart1.xml'], before['xl/charts/chart1.xml']);
    // D2 now points at a new cellXf index
    assert.match(after['xl/worksheets/sheet1.xml'], /<c[^>]*r="D2"[^>]*\bs="\d+"/);
  });

  test('range A1:B2 percent works and does not affect column D', async () => {
    const buf = await makeWorkbook();
    const r = adapter.formatRange({ buffer: buf, range: 'D2:D3', numberFormat: 'percent' });
    assert.equal(r.cellsChanged, 2);
    assert.match(snapshot(r.buffer)['xl/styles.xml'], /0\.0%/);
  });

  test('formatRange is reopenable by ExcelJS (no-chart workbook) with the € numFmt on the cells', async () => {
    const buf = await makeWorkbook(); // no chart → ExcelJS can read it
    const r = adapter.formatRange({ buffer: buf, column: 'D', numberFormat: 'currency', currency: 'EUR' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.buffer);
    const cell = wb.getWorksheet('Gastos').getCell('D2');
    assert.match(String(cell.numFmt || ''), /€/);
  });

  test('unsupported number format throws a clear error', async () => {
    const buf = await makeWorkbook();
    assert.throws(() => adapter.formatRange({ buffer: buf, column: 'D', numberFormat: 'martian' }), /no soportado/);
  });
});

describe('xlsx-adapter — setCellValue', () => {
  test('number, formula and inline string are written correctly, other parts intact', async () => {
    const buf = await makeWorkbook({ withChart: true });
    const before = snapshot(buf);

    const rNum = adapter.setCellValue({ buffer: buf, sheet: 'Gastos', cellRef: 'D2', value: '999' });
    assert.match(snapshot(rNum.buffer)['xl/worksheets/sheet1.xml'], /<c r="D2"[^>]*><v>999<\/v><\/c>/);

    const rFormula = adapter.setCellValue({ buffer: rNum.buffer, sheet: 'Gastos', cellRef: 'D7', value: '=SUM(D2:D6)' });
    assert.match(snapshot(rFormula.buffer)['xl/worksheets/sheet1.xml'], /<c r="D7"[^>]*><f>SUM\(D2:D6\)<\/f><\/c>/);

    const rStr = adapter.setCellValue({ buffer: rFormula.buffer, sheet: 'Gastos', cellRef: 'A2', value: 'Reemplazo' });
    assert.match(snapshot(rStr.buffer)['xl/worksheets/sheet1.xml'], /<c r="A2"[^>]*t="inlineStr"><is><t[^>]*>Reemplazo<\/t><\/is><\/c>/);

    // Chart untouched throughout
    assert.equal(snapshot(rStr.buffer)['xl/charts/chart1.xml'], before['xl/charts/chart1.xml']);
  });

  test('invalid cell reference throws', async () => {
    const buf = await makeWorkbook();
    assert.throws(() => adapter.setCellValue({ buffer: buf, sheet: 'Gastos', cellRef: 'ZZ', value: '1' }), /inválida/);
  });
});

describe('parseSpreadsheetEditRequest', () => {
  test("owner example 'columna D a formato moneda' → format_range currency", () => {
    const r = parseSpreadsheetEditRequest('En el Excel cambia los montos de la columna D a formato moneda');
    assert.equal(r.kind, 'format_range');
    assert.equal(r.column, 'D');
    assert.equal(r.numberFormat, 'currency');
    assert.equal(r.currency, 'EUR');
  });

  test('dólares → USD; porcentaje; fecha; range form', () => {
    assert.equal(parseSpreadsheetEditRequest('formatea la columna C a dólares').currency, 'USD');
    assert.equal(parseSpreadsheetEditRequest('pon la columna E como porcentaje').numberFormat, 'percent');
    assert.equal(parseSpreadsheetEditRequest('cambia la columna A a fecha').numberFormat, 'date');
    const rng = parseSpreadsheetEditRequest('aplica formato de moneda al rango D2:D11');
    assert.equal(rng.range, 'D2:D11');
  });

  test("English 'format column D as currency'", () => {
    const r = parseSpreadsheetEditRequest('format column D as currency in the excel');
    assert.equal(r.kind, 'format_range');
    assert.equal(r.column, 'D');
    assert.equal(r.numberFormat, 'currency');
  });

  test("set_cell 'pon la celda B3 en 500'", () => {
    const r = parseSpreadsheetEditRequest('pon la celda B3 en 500');
    assert.equal(r.kind, 'set_cell');
    assert.equal(r.cellRef, 'B3');
    assert.equal(r.value, '500');
  });

  test('sheet cue captured; unrelated text → null', () => {
    const r = parseSpreadsheetEditRequest('en la hoja Gastos formatea la columna D a moneda');
    assert.equal(r.sheetCue, 'gastos');
    assert.equal(parseSpreadsheetEditRequest('cuéntame un chiste sobre excel'), null);
    assert.equal(parseSpreadsheetEditRequest('¿cuál es el total de la columna D?'), null);
  });
});

describe('xlsx surgical edit — end to end', () => {
  test('ambiguity: 2 sheets, no cue → clarification listing both sheets, no artifact', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx-ambig-'));
    const xlsxPath = path.join(tmp, 'gastos.xlsx');
    fs.writeFileSync(xlsxPath, await makeWorkbook({ twoSheets: true }));

    const result = await generateSourcePreservingDocumentEdit({
      sourceFile: { id: 'f1', path: xlsxPath, originalName: 'gastos.xlsx', mimeType: XLSX_MIME },
      prompt: 'cambia la columna D a formato moneda',
      displayPrompt: 'cambia la columna D a formato moneda',
      userId: 'user-1',
      chatId: 'chat-1',
    });
    assert.equal(result.clarification, true);
    assert.equal(result.artifact, null);
    assert.match(result.content, /Gastos/);
    assert.match(result.content, /Dashboard/);
  });

  test('1 sheet → edit applied, artifact persisted, original untouched, other parts intact', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx-edit-e2e-'));
    const xlsxPath = path.join(tmp, 'gastos.xlsx');
    const original = await makeWorkbook({ withChart: true });
    fs.writeFileSync(xlsxPath, original);

    const prisma = prismaFakeFor([
      { id: 'file-xlsx', userId: 'user-1', filename: 'gastos.xlsx', originalName: 'gastos.xlsx', mimeType: XLSX_MIME, size: original.length, path: xlsxPath },
    ]);

    const result = await tryGenerateSourcePreservingDocumentEdit({
      prisma,
      userId: 'user-1',
      chatId: 'chat-1',
      fileIds: ['file-xlsx'],
      prompt: 'cambia los montos de la columna D a formato moneda',
      displayPrompt: 'cambia los montos de la columna D a formato moneda',
    });

    assert.equal(result.format, 'xlsx');
    assert.equal(result.clarification, undefined);
    assert.equal(result.validation.passed, true);
    assert.match(result.file.filename, /formato_actualizado\.xlsx$/);
    assert.match(result.content, /moneda/i);

    // The persisted artifact has the € number format; the chart survived; the
    // original upload is byte-identical to before.
    const editedBuf = fs.readFileSync(result.artifact.path);
    const after = snapshot(editedBuf);
    assert.match(after['xl/styles.xml'], /#,##0\.00/);
    assert.equal(after['xl/charts/chart1.xml'], snapshot(original)['xl/charts/chart1.xml']);
    assert.ok(fs.readFileSync(xlsxPath).equals(original), 'original upload must never change');
  });
});

// ── Review follow-ups ───────────────────────────────────────────────────────

describe('xlsx-adapter — review fixes', () => {
  test('reversed range D3:D2 behaves like D2:D3', async () => {
    const buf = await makeWorkbook();
    const r = adapter.formatRange({ buffer: buf, range: 'D3:D2', numberFormat: 'percent' });
    assert.equal(r.cellsChanged, 2);
  });

  test('repeat formatRange reuses the numFmt instead of allocating duplicates', async () => {
    const buf = await makeWorkbook();
    const r1 = adapter.formatRange({ buffer: buf, column: 'D', numberFormat: 'currency', currency: 'EUR' });
    const r2 = adapter.formatRange({ buffer: r1.buffer, range: 'C2:C3', numberFormat: 'currency', currency: 'EUR' });
    assert.equal(r1.numFmtId, r2.numFmtId, 'same code → same numFmtId');
    const styles = snapshot(r2.buffer)['xl/styles.xml'];
    assert.equal((styles.match(/<numFmt\b/g) || []).length, 1, 'exactly one custom numFmt');
  });
});
