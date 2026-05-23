'use strict';

const ExcelJS = require('exceljs');

const DEFAULT_BATCH = Number.parseInt(
  process.env.SIRAGPT_XLSX_STREAM_BATCH || '500',
  10
);
const DEFAULT_MAX_RSS_MB = Number.parseInt(
  process.env.SIRAGPT_STREAM_MAX_RSS_MB || '900',
  10
);

function rssMb() {
  try {
    return process.memoryUsage().rss / (1024 * 1024);
  } catch {
    return 0;
  }
}

function rowToValues(row) {
  const out = [];
  // exceljs streaming row exposes `.values` (1-indexed sparse array)
  const v = row.values;
  if (Array.isArray(v)) {
    for (let i = 1; i < v.length; i += 1) {
      const cell = v[i];
      if (cell == null) {
        out.push('');
      } else if (typeof cell === 'object') {
        if ('text' in cell) out.push(String(cell.text));
        else if ('result' in cell) out.push(String(cell.result));
        else if ('richText' in cell && Array.isArray(cell.richText)) {
          out.push(cell.richText.map((r) => r.text || '').join(''));
        } else if (cell instanceof Date) {
          out.push(cell.toISOString());
        } else {
          out.push(JSON.stringify(cell));
        }
      } else {
        out.push(String(cell));
      }
    }
  }
  return out;
}

/**
 * Stream rows from an XLSX file as batches of N rows per yield.
 * Each yielded item: { sheet, batch, rows, rowOffset, rssMb }.
 * Stops early when RSS exceeds opts.maxRssMb.
 */
async function* streamXlsxRows(filePath, opts = {}) {
  const batchSize = opts.batchSize || DEFAULT_BATCH;
  const maxRssMb = opts.maxRssMb || DEFAULT_MAX_RSS_MB;
  const partialRef = opts.partialRef || { partial: false };

  const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'ignore',
    worksheets: 'emit',
    entries: 'emit',
  });

  let batchIdx = 0;
  let aborted = false;

  for await (const worksheet of workbookReader) {
    const sheetName = worksheet.name || `Sheet${worksheet.id || ''}`;
    let buffer = [];
    let rowOffset = 0;

    for await (const row of worksheet) {
      buffer.push(rowToValues(row));
      if (buffer.length >= batchSize) {
        batchIdx += 1;
        yield {
          sheet: sheetName,
          batch: batchIdx,
          rows: buffer,
          rowOffset,
          rssMb: rssMb(),
        };
        rowOffset += buffer.length;
        buffer = [];
        if (rssMb() > maxRssMb) {
          aborted = true;
          partialRef.partial = true;
          break;
        }
      }
    }

    if (!aborted && buffer.length) {
      batchIdx += 1;
      yield {
        sheet: sheetName,
        batch: batchIdx,
        rows: buffer,
        rowOffset,
        rssMb: rssMb(),
      };
    }
    if (aborted) break;
  }
}

async function extractXlsxStreaming(filePath, opts = {}) {
  const start = Date.now();
  let peakRss = rssMb();
  let rowCount = 0;
  let cellCount = 0;
  const sheets = new Map();
  const partialRef = { partial: false };

  for await (const batch of streamXlsxRows(filePath, { ...opts, partialRef })) {
    rowCount += batch.rows.length;
    for (const r of batch.rows) cellCount += r.length;
    const cur = sheets.get(batch.sheet) || { name: batch.sheet, rows: 0 };
    cur.rows += batch.rows.length;
    sheets.set(batch.sheet, cur);
    if (batch.rssMb > peakRss) peakRss = batch.rssMb;
    if (typeof opts.onBatch === 'function') opts.onBatch(batch);
  }

  return {
    rowCount,
    cellCount,
    sheets: Array.from(sheets.values()),
    partial: partialRef.partial,
    peakRssMb: peakRss,
    elapsedMs: Date.now() - start,
  };
}

module.exports = {
  streamXlsxRows,
  extractXlsxStreaming,
  DEFAULT_BATCH,
};
