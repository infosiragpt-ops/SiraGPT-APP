const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const fileProcessor = require('../src/services/fileProcessor');
const {
  addRowsWorksheet,
  createWorkbook,
  writeWorkbookBuffer,
} = require('../src/services/xlsx-safe-workbook');

test('processExcel caps workbook sheets and leaves an auditable truncation marker', async () => {
  const previous = process.env.SIRAGPT_XLSX_MAX_SHEETS;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-xlsx-safety-'));
  const filePath = path.join(dir, 'many-sheets.xlsx');
  try {
    process.env.SIRAGPT_XLSX_MAX_SHEETS = '2';
    const workbook = createWorkbook();
    for (let i = 1; i <= 4; i += 1) {
      addRowsWorksheet(workbook, `Sheet${i}`, [
        ['Name', 'Payload'],
        [`row-${i}`, i === 1 ? '=cmd' : `safe-${i}`],
      ]);
    }
    await fs.writeFile(filePath, await writeWorkbookBuffer(workbook));

    const extracted = await fileProcessor.processExcel(filePath);

    assert.match(extracted, /Excel workbook — 4 sheet\(s\): Sheet1, Sheet2, Sheet3, Sheet4/);
    assert.match(extracted, /Showing first 2 sheet\(s\); 2 sheet\(s\) skipped by safety cap \(2\)\./);
    assert.match(extracted, /\[truncated: 2 sheet\(s\) skipped by safety cap\]/);
    assert.match(extracted, /Sheet: Sheet1/);
    assert.match(extracted, /Sheet: Sheet2/);
    assert.doesNotMatch(extracted, /Sheet: Sheet3\n/);
    assert.match(extracted, /'=cmd/);
  } finally {
    if (previous == null) delete process.env.SIRAGPT_XLSX_MAX_SHEETS;
    else process.env.SIRAGPT_XLSX_MAX_SHEETS = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('processExcel honors formula defang env switch end-to-end', async () => {
  const previous = process.env.SIRAGPT_XLSX_DEFANG_FORMULAS;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-xlsx-defang-env-'));
  const filePath = path.join(dir, 'formula.xlsx');
  try {
    process.env.SIRAGPT_XLSX_DEFANG_FORMULAS = '0';
    const workbook = createWorkbook();
    addRowsWorksheet(workbook, 'Data', [
      ['Name', 'Payload'],
      ['A', '=cmd'],
    ]);
    await fs.writeFile(filePath, await writeWorkbookBuffer(workbook));

    const extracted = await fileProcessor.processExcel(filePath);
    assert.match(extracted, /\t=cmd/);
    assert.doesNotMatch(extracted, /'=cmd/);
  } finally {
    if (previous == null) delete process.env.SIRAGPT_XLSX_DEFANG_FORMULAS;
    else process.env.SIRAGPT_XLSX_DEFANG_FORMULAS = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('processExcel preserves key-value rows after blank separator rows', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-xlsx-marker-'));
  const filePath = path.join(dir, 'ventas_2025.xlsx');
  try {
    const workbook = createWorkbook();
    const worksheet = workbook.addWorksheet('Ventas2025');
    worksheet.addRow(['Region', 'Q1', 'Q2', 'Q3', 'Q4', 'Total']);
    worksheet.addRow(['Norte', 120, 150, 130, 200, 600]);
    worksheet.addRow(['Sur', 90, 80, 110, 95, 375]);
    worksheet.addRow(['TOTAL', 210, 230, 240, 295, 975]);
    worksheet.addRow([]);
    worksheet.addRow(['Marcador', 'XLSMARK-5521']);
    await fs.writeFile(filePath, await writeWorkbookBuffer(workbook));

    const extracted = await fileProcessor.processExcel(filePath);

    assert.match(extracted, /Marcador\tXLSMARK-5521/);
    assert.match(extracted, /XLSMARK-5521/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('processExcel handles empty workbooks without a truncation marker', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-xlsx-empty-'));
  const filePath = path.join(dir, 'empty.xlsx');
  try {
    const workbook = createWorkbook();
    await fs.writeFile(filePath, await writeWorkbookBuffer(workbook));

    const extracted = await fileProcessor.processExcel(filePath);
    assert.match(extracted, /Excel workbook — 0 sheet\(s\):/);
    assert.doesNotMatch(extracted, /truncated:/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('processFile reads xlsx content even when browser reports a generic MIME', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-xlsx-generic-mime-'));
  const filePath = path.join(dir, 'base_sucesion_intestada_seleccionados.xlsx');
  try {
    const workbook = createWorkbook();
    addRowsWorksheet(workbook, 'Referencias', [
      ['Título del articulo', 'Autores', 'Año de publicacion'],
      ['Sucesión intestada y herederos', 'García López, M.', 2021],
    ]);
    await fs.writeFile(filePath, await writeWorkbookBuffer(workbook));

    for (const mimetype of ['application/zip', 'application/octet-stream']) {
      const result = await fileProcessor.processFile({
        path: filePath,
        originalname: 'base_sucesion_intestada_seleccionados.xlsx',
        mimetype,
        size: 2048,
      });

      assert.equal(result.success, true);
      assert.equal(result.fileInfo.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      assert.match(result.extractedText, /Sheet: Referencias/);
      assert.match(result.extractedText, /Sucesión intestada y herederos/);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('processExcel preserves sparse late rows and original sheet coordinates within the populated-row budget', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-xlsx-sparse-'));
  const filePath = path.join(dir, 'matrices.xlsx');
  try {
    const workbook = createWorkbook();
    const sheet = workbook.addWorksheet('Derecho');
    sheet.getRow(4).values = ['Código', 'Título', 'Puntaje'];
    sheet.getRow(6200).values = ['DER-6200', 'Sucesión intestada', { formula: '1-1', result: 0 }];
    const lastSheet = workbook.addWorksheet('Salud');
    lastSheet.getRow(2).values = ['Código', 'Descripción'];
    lastSheet.getRow(7000).values = ['SAL-7000', 'Valor con\ttabulación\ny otra línea'];
    await fs.writeFile(filePath, await writeWorkbookBuffer(workbook));
    const text = await fileProcessor.processExcel(filePath);
    assert.match(text, /Header row: 4\. Column range: A:C/);
    assert.match(text, /Row coordinates: 6200/);
    assert.match(text, /DER-6200\tSucesión intestada\t0/);
    assert.match(text, /Row coordinates: 7000/);
    assert.match(text, /SAL-7000\tValor con\\ttabulación\\ny otra línea/);
    assert.doesNotMatch(text, /truncated:/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('processExcel reports column and populated-row truncation explicitly', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-xlsx-bounds-'));
  const filePath = path.join(dir, 'bounded.xlsx');
  try {
    const workbook = createWorkbook();
    const sheet = workbook.addWorksheet('Data');
    sheet.addRow(['Código', 'Valor']);
    for (let i = 1; i <= 5001; i += 1) sheet.addRow([`REG-${i}`, i]);
    sheet.getCell('CC2').value = 'Fuera del límite de columnas';
    await fs.writeFile(filePath, await writeWorkbookBuffer(workbook));
    const text = await fileProcessor.processExcel(filePath);
    assert.match(text, /REG-5000\t5000/);
    assert.doesNotMatch(text, /REG-5001/);
    assert.match(text, /truncated: 1 more populated row/);
    assert.match(text, /truncated: columns after CB omitted/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('DOCX table spans cannot allocate phantom rows or unlimited columns', () => {
  const text = fileProcessor._htmlToMarkdown('<table><tr><td rowspan="99999999" colspan="99999999"><p>Un solo dato</p></td></tr></table>');
  assert.ok(text.length < 3000);
  assert.equal(text.split('\n').filter(line => line.startsWith('|')).length, 2);
  assert.match(text, /truncated: table spans/);
});

test('extracted XLSX remains compatible with bibliography and quality readers', async () => {
  const { parseSpreadsheetCitationRows } = require('../src/services/agents/agent-task-runner');
  const { _internal: quality } = require('../src/services/document-analysis-quality');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-xlsx-citations-'));
  const filePath = path.join(dir, 'bibliografia.xlsx');
  try {
    const workbook = createWorkbook();
    const sheet = workbook.addWorksheet('Referencias');
    sheet.addRow(['Título', 'Autores', 'Año', 'DOI']);
    sheet.getRow(6200).values = ['Análisis de sarcopenia', 'García, M.', 2025, '10.1234/salud.2025'];
    await fs.writeFile(filePath, await writeWorkbookBuffer(workbook));
    const text = await fileProcessor.processExcel(filePath);
    const references = parseSpreadsheetCitationRows(text);
    assert.equal(references.length, 1);
    assert.equal(references[0].title, 'Análisis de sarcopenia');
    assert.equal(Number(references[0].year), 2025);
    assert.match(JSON.stringify(references[0]), /10\.1234\/salud\.2025/);
    const qualityRows = quality.parseSpreadsheetRows([{ originalName: 'bibliografia.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extractedText: text }]);
    assert.equal(qualityRows.length, 1);
    assert.deepEqual(qualityRows[0].cells, ['Análisis de sarcopenia', 'García, M.', '2025', '10.1234/salud.2025']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('DOCX tables retain row relationships, merged cells, literal pipes and paragraph breaks for retrieval', async () => {
  const { Document, Packer, Paragraph, Table, TableRow, TableCell } = require('docx');
  const intelligence = require('../src/services/document-intelligence');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-docx-table-'));
  const filePath = path.join(dir, 'matriz.docx');
  const cell = (text, extra = {}) => new TableCell({ children: text.map(value => new Paragraph(value)), ...extra });
  try {
    const document = new Document({ sections: [{ children: [new Table({ rows: [
      new TableRow({ children: [cell(['Categoría']), cell(['Indicador']), cell(['Resultado'])] }),
      new TableRow({ children: [cell(['Gestión | sanitaria'], { rowSpan: 2 }), cell(['Ejecución']), cell(['Alta', 'Confirmada'])] }),
      new TableRow({ children: [cell(['Riesgo']), cell(['Bajo'])] }),
    ] })] }] });
    await fs.writeFile(filePath, await Packer.toBuffer(document));
    const text = await fileProcessor.processWord(filePath);
    const tables = await intelligence.buildTables({ originalName: 'matriz.docx' }, text);
    assert.equal(tables.length, 1);
    assert.equal(tables[0].rowCount, 2);
    assert.equal(tables[0].preview[0]['Categoría'], 'Gestión | sanitaria');
    assert.equal(tables[0].preview[0].Resultado, 'Alta\nConfirmada');
    assert.equal(tables[0].preview[1]['Categoría'], 'Gestión | sanitaria');
    assert.equal(tables[0].preview[1].Indicador, 'Riesgo');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
