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
