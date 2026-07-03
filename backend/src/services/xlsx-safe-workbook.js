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

// 1→A, 26→Z, 27→AA, 52→AZ, 703→AAA. The old `String.fromCharCode(64+min(n,26))`
// capped every column past 26 at 'Z', mislabelling formula cell references in
// wide sheets.
function excelColLetter(n) {
  let col = Number(n);
  if (!Number.isInteger(col) || col < 1) return '';
  let out = '';
  while (col > 0) {
    col -= 1;
    out = String.fromCharCode(65 + (col % 26)) + out;
    col = Math.floor(col / 26);
  }
  return out;
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
  // ExcelJS `actualRowCount` is a count of non-empty rows, not the highest row
  // index. Workbooks with intentional blank separator rows can otherwise drop
  // later key-value rows such as "Marcador / XLSMARK-5521".
  const rowLimit = Math.min(
    Number.isFinite(Number(worksheet?.rowCount || worksheet?.actualRowCount))
      ? Number(worksheet.rowCount || worksheet.actualRowCount)
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

// Detect numeric-looking columns from the data rows so professional number
// formats can be applied without the caller declaring types. A column counts
// as numeric when ≥70% of its non-empty body cells are finite numbers (or
// numeric strings); currency when the header mentions money terms.
function inferNumericColumns(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return { numeric: new Set(), currency: new Set() };
  const [headerRow, ...body] = rows;
  const numeric = new Set();
  const currency = new Set();
  const currencyHeader = /precio|costo|coste|importe|monto|total|price|cost|amount|revenue|ingreso|venta|salario|sueldo|usd|eur|\$|€/i;
  const width = Math.max(...rows.map((r) => (Array.isArray(r) ? r.length : 0)));
  for (let col = 0; col < width; col += 1) {
    let filled = 0;
    let numbers = 0;
    for (const row of body) {
      const cell = Array.isArray(row) ? row[col] : undefined;
      if (cell == null || cell === '') continue;
      filled += 1;
      if (typeof cell === 'number' && Number.isFinite(cell)) numbers += 1;
      else if (typeof cell === 'string' && /^-?\$?\s?\d[\d,.]*%?$/.test(cell.trim())) numbers += 1;
    }
    if (filled >= 2 && numbers / filled >= 0.7) {
      numeric.add(col);
      if (currencyHeader.test(String(headerRow?.[col] ?? ''))) currency.add(col);
    }
  }
  return { numeric, currency };
}

// Professional worksheet writer shared by the agent artifact engine and the
// download route. The old shape emitted a bare grid with a bold header — the
// "raw dump" Excels the owner flagged. Defaults now match what a person
// would set up by hand: styled header, frozen row, autofilter, banded rows,
// number formats on numeric columns. Pass { plain: true } for the legacy grid.
function addRowsWorksheet(workbook, name, rows, opts = {}) {
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
  if (opts.plain || rows.length === 0) return worksheet;

  const columnCount = widths.length;
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.alignment = { vertical: 'middle' };
  header.height = 20;
  for (let col = 1; col <= columnCount; col += 1) {
    header.getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
  }
  worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  if (rows.length > 1 && columnCount > 0) {
    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: rows.length, column: columnCount },
    };
    // Banded body rows for scanability (soft slate tint on even rows).
    for (let r = 2; r <= rows.length; r += 1) {
      if (r % 2 === 0) {
        for (let col = 1; col <= columnCount; col += 1) {
          worksheet.getRow(r).getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
        }
      }
    }
    const { numeric, currency } = inferNumericColumns(rows);
    for (const col of numeric) {
      const numFmt = currency.has(col) ? '#,##0.00' : '#,##0.##';
      for (let r = 2; r <= rows.length; r += 1) {
        worksheet.getRow(r).getCell(col + 1).numFmt = numFmt;
      }
    }
  }
  return worksheet;
}

/**
 * Evaluate and collect formula information from a workbook.
 * ExcelJS computes many formulas automatically during read.
 * This function returns computed values and formula metadata.
 *
 * Returns { formulaCount, formulaCells, formulaSummary }
 */
function evaluateFormulas(workbook) {
  if (!workbook || !workbook.worksheets) {
    return { formulaCount: 0, formulaCells: [], formulaSummary: '' };
  }

  const formulaCells = [];
  let totalFormulas = 0;
  const MAX_FORMULA_REPORT = 50;

  for (const ws of workbook.worksheets) {
    if (!ws) continue;
    const rowCount = ws.actualRowCount || ws.rowCount || 0;
    for (let r = 1; r <= rowCount && formulaCells.length < MAX_FORMULA_REPORT; r++) {
      const row = ws.getRow(r);
      if (!row) continue;
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        if (cell.formula) {
          totalFormulas++;
          if (formulaCells.length < MAX_FORMULA_REPORT) {
            formulaCells.push({
              sheet: ws.name,
              row: r,
              col: colNumber,
              formula: String(cell.formula).substring(0, 120),
              computedValue: cell.result !== undefined && cell.result !== null
                ? String(cell.result).substring(0, 80)
                : null,
              colLetter: excelColLetter(colNumber),
            });
          }
        }
      });
    }
  }

  let formulaSummary = '';
  if (totalFormulas > 0) {
    const computedCount = formulaCells.filter(f => f.computedValue !== null).length;
    formulaSummary = `${totalFormulas} formulas detected (${computedCount} computed by ExcelJS, ${totalFormulas - computedCount} require external evaluation). `;

    const formulaTypes = {};
    for (const f of formulaCells) {
      const type = f.formula.match(/^[A-Z]+/)?.[0] || 'OTHER';
      formulaTypes[type] = (formulaTypes[type] || 0) + 1;
    }
    const topTypes = Object.entries(formulaTypes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([t, c]) => `${t}(${c})`)
      .join(', ');
    formulaSummary += `Top functions: ${topTypes}`;
  }

  return { formulaCount: totalFormulas, formulaCells, formulaSummary };
}

module.exports = {
  DEFAULT_MAX_COLUMNS,
  DEFAULT_MAX_ROWS,
  DEFAULT_MAX_SHEETS,
  excelColLetter,
  addRowsWorksheet,
  inferNumericColumns,
  cellToText,
  createWorkbook,
  defangCellText,
  getXlsxMaxSheets,
  evaluateFormulas,
  readXlsxBuffer,
  readXlsxFile,
  rowToValues,
  selectWorkbookWorksheets,
  shouldDefangCellText,
  worksheetRows,
  writeWorkbookBuffer,
};
