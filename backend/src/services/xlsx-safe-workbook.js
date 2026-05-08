const ExcelJS = require('exceljs');

const DEFAULT_MAX_ROWS = 80;
const DEFAULT_MAX_SHEETS = 5;
const DEFAULT_MAX_COLUMNS = 80;
const MAX_SHEET_CAP = 100;

function envFlag(name, fallback = true) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.floor(n), max));
}

function getXlsxMaxSheets(value = process.env.SIRAGPT_XLSX_MAX_SHEETS) {
  return clampInt(value, DEFAULT_MAX_SHEETS, 1, MAX_SHEET_CAP);
}

function shouldDefangCellText(text) {
  return /^[\u0000-\u001f\u007f\u200b\u200c\u200d\ufeff\s]*[=+\-@]/u.test(String(text || ''));
}

function defangCellText(value, { enabled = envFlag('SIRAGPT_XLSX_DEFANG_FORMULAS', true) } = {}) {
  if (typeof value !== 'string' || !enabled || !shouldDefangCellText(value)) return value;
  return `'${value}`;
}

function cellToText(cell, options = {}) {
  if (cell == null) return '';
  if (cell instanceof Date) return cell.toISOString();
  if (typeof cell !== 'object') {
    return typeof cell === 'string' ? defangCellText(cell, options) : String(cell);
  }
  if ((typeof cell.value === 'number' || typeof cell.value === 'boolean') && cell.text != null) {
    return String(cell.text);
  }
  if (cell.text != null) return defangCellText(String(cell.text), options);
  if (cell.result != null) return cellToText(cell.result, options);
  if (cell.richText && Array.isArray(cell.richText)) {
    return defangCellText(cell.richText.map((part) => part?.text || '').join(''), options);
  }
  if (cell.hyperlink && cell.text) return defangCellText(String(cell.text), options);
  if (cell.formula) return defangCellText(String(cell.result ?? `=${cell.formula}`), options);
  return defangCellText(String(cell), options);
}

function rowToValues(row, maxColumns = DEFAULT_MAX_COLUMNS, options = {}) {
  const values = Array.isArray(row?.values) ? row.values.slice(1, maxColumns + 1) : [];
  return Array.from(values, (cell) => cellToText(cell, options));
}

function worksheetRows(worksheet, { maxRows = DEFAULT_MAX_ROWS, maxColumns = DEFAULT_MAX_COLUMNS, defangFormulas } = {}) {
  const rows = [];
  const cellOptions = defangFormulas === undefined ? {} : { enabled: Boolean(defangFormulas) };
  const rowLimit = Math.min(
    Number.isFinite(Number(worksheet?.actualRowCount || worksheet?.rowCount))
      ? Number(worksheet.actualRowCount || worksheet.rowCount)
      : maxRows,
    maxRows,
  );
  for (let rowNumber = 1; rowNumber <= rowLimit; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const values = rowToValues(row, maxColumns, cellOptions);
    if (values.some((value) => String(value).trim())) rows.push(values);
  }
  return rows;
}

function selectWorkbookWorksheets(workbook, { maxSheets = getXlsxMaxSheets() } = {}) {
  const sheets = Array.isArray(workbook?.worksheets) ? workbook.worksheets : [];
  const limit = clampInt(maxSheets, DEFAULT_MAX_SHEETS, 1, MAX_SHEET_CAP);
  const worksheets = sheets.slice(0, limit);
  return {
    worksheets,
    total: sheets.length,
    skipped: Math.max(0, sheets.length - worksheets.length),
    maxSheets: limit,
  };
}

async function readXlsxFile(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return workbook;
}

async function readXlsxBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}

function createWorkbook() {
  return new ExcelJS.Workbook();
}

async function writeWorkbookBuffer(workbook) {
  const output = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(output) ? output : Buffer.from(output);
}

function addRowsWorksheet(workbook, name, rows) {
  const worksheet = workbook.addWorksheet(name);
  worksheet.addRows(rows);
  const widths = [];
  rows.forEach((row) => {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] || 0, String(cell ?? '').length);
    });
  });
  worksheet.columns = widths.map((width) => ({ width: Math.min(Math.max(width + 2, 10), 50) }));
  const header = worksheet.getRow(1);
  header.font = { bold: true };
  return worksheet;
}

module.exports = {
  DEFAULT_MAX_COLUMNS,
  DEFAULT_MAX_ROWS,
  DEFAULT_MAX_SHEETS,
  addRowsWorksheet,
  cellToText,
  createWorkbook,
  defangCellText,
  getXlsxMaxSheets,
  readXlsxBuffer,
  readXlsxFile,
  rowToValues,
  selectWorkbookWorksheets,
  shouldDefangCellText,
  worksheetRows,
  writeWorkbookBuffer,
};
