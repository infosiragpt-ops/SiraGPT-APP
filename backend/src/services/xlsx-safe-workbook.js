const ExcelJS = require('exceljs');

const DEFAULT_MAX_ROWS = 80;
const DEFAULT_MAX_SHEETS = 5;
const DEFAULT_MAX_COLUMNS = 80;

function cellToText(cell) {
  if (cell == null) return '';
  if (cell instanceof Date) return cell.toISOString();
  if (typeof cell !== 'object') return String(cell);
  if (cell.text != null) return String(cell.text);
  if (cell.result != null) return cellToText(cell.result);
  if (cell.richText && Array.isArray(cell.richText)) {
    return cell.richText.map((part) => part?.text || '').join('');
  }
  if (cell.hyperlink && cell.text) return String(cell.text);
  if (cell.formula) return String(cell.result ?? `=${cell.formula}`);
  return String(cell);
}

function rowToValues(row, maxColumns = DEFAULT_MAX_COLUMNS) {
  const values = Array.isArray(row?.values) ? row.values.slice(1, maxColumns + 1) : [];
  return values.map(cellToText);
}

function worksheetRows(worksheet, { maxRows = DEFAULT_MAX_ROWS, maxColumns = DEFAULT_MAX_COLUMNS } = {}) {
  const rows = [];
  const rowLimit = Math.min(
    Number.isFinite(Number(worksheet?.actualRowCount || worksheet?.rowCount))
      ? Number(worksheet.actualRowCount || worksheet.rowCount)
      : maxRows,
    maxRows,
  );
  for (let rowNumber = 1; rowNumber <= rowLimit; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const values = rowToValues(row, maxColumns);
    if (values.some((value) => String(value).trim())) rows.push(values);
  }
  return rows;
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
  readXlsxBuffer,
  readXlsxFile,
  rowToValues,
  worksheetRows,
  writeWorkbookBuffer,
};
