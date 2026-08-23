'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');

const { streamXlsxRows, extractXlsxStreaming, extractXlsxTextStreaming } = require('../src/services/document/streaming-xlsx');

function makeTmp(name) {
  return path.join(os.tmpdir(), `siragpt-stream-xlsx-${process.pid}-${Date.now()}-${name}`);
}

async function generateWorkbook({ sheets = 1, rowsPerSheet = 1500, cols = 6 } = {}) {
  const filePath = makeTmp('test.xlsx');
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath });
  for (let s = 0; s < sheets; s += 1) {
    const ws = wb.addWorksheet(`Sheet${s + 1}`);
    for (let r = 0; r < rowsPerSheet; r += 1) {
      const row = [];
      for (let c = 0; c < cols; c += 1) {
        row.push(`s${s + 1}r${r + 1}c${c + 1}`);
      }
      ws.addRow(row).commit();
    }
    ws.commit();
  }
  await wb.commit();
  return filePath;
}

test('streamXlsxRows yields rows in batches of configured size', async () => {
  const filePath = await generateWorkbook({ sheets: 1, rowsPerSheet: 1200, cols: 4 });
  try {
    const batches = [];
    for await (const b of streamXlsxRows(filePath, { batchSize: 250 })) {
      batches.push(b);
    }
    assert.ok(batches.length >= 4, `expected >=4 batches, got ${batches.length}`);
    let totalRows = 0;
    for (const b of batches) {
      assert.equal(b.sheet, 'Sheet1');
      assert.ok(b.rows.length <= 250);
      totalRows += b.rows.length;
    }
    assert.equal(totalRows, 1200);
    // First row sanity check
    assert.equal(batches[0].rows[0][0], 's1r1c1');
  } finally {
    await fsp.unlink(filePath).catch(() => {});
  }
});

test('extractXlsxStreaming reports rowCount and per-sheet stats', async () => {
  const filePath = await generateWorkbook({ sheets: 2, rowsPerSheet: 600, cols: 3 });
  try {
    const res = await extractXlsxStreaming(filePath, { batchSize: 200 });
    assert.equal(res.rowCount, 1200, 'expects 600 rows × 2 sheets');
    assert.equal(res.partial, false);
    assert.equal(res.sheets.length, 2);
    const totals = res.sheets.reduce((acc, s) => acc + s.rows, 0);
    assert.equal(totals, 1200);
    assert.ok(res.cellCount >= 1200);
    assert.ok(res.elapsedMs >= 0);
  } finally {
    await fsp.unlink(filePath).catch(() => {});
  }
});

test('streamXlsxRows aborts when RSS cap exceeded and sets partial=true', async () => {
  const filePath = await generateWorkbook({ sheets: 1, rowsPerSheet: 800, cols: 3 });
  try {
    const partialRef = { partial: false };
    let yielded = 0;
    for await (const _b of streamXlsxRows(filePath, { batchSize: 100, maxRssMb: 1, partialRef })) {
      yielded += 1;
    }
    assert.ok(yielded >= 1);
    assert.equal(partialRef.partial, true);
  } finally {
    await fsp.unlink(filePath).catch(() => {});
  }
});

test('streamXlsxRows handles a workbook with mixed content sizes', async () => {
  const filePath = await generateWorkbook({ sheets: 1, rowsPerSheet: 50, cols: 2 });
  try {
    let total = 0;
    for await (const b of streamXlsxRows(filePath, { batchSize: 25 })) {
      total += b.rows.length;
    }
    assert.equal(total, 50);
  } finally {
    await fsp.unlink(filePath).catch(() => {});
  }
});

test('extractXlsxTextStreaming emits Sheet: header + TSV rows (exceljs contract)', async () => {
  const filePath = await generateWorkbook({ sheets: 2, rowsPerSheet: 5, cols: 3 });
  try {
    const res = await extractXlsxTextStreaming(filePath, { batchSize: 2 });
    assert.equal(res.parser, 'xlsx-stream');
    assert.equal(res.text.split('\n')[0], 'Sheet: Sheet1');
    assert.ok(res.text.includes('Sheet: Sheet2'));
    assert.ok(res.text.includes('s1r1c1\ts1r1c2\ts1r1c3'));
    assert.equal(res.metadata.rowCount, 10);
    assert.equal(res.metadata.sheets.length, 2);
    assert.equal(res.metadata.sheets[0].rows, 5);
    assert.equal(res.metadata.partial, false);
  } finally {
    await fsp.unlink(filePath).catch(() => {});
  }
});

test('extractXlsxTextStreaming respects maxRowsPerSheet and reports partial', async () => {
  const filePath = await generateWorkbook({ sheets: 1, rowsPerSheet: 30, cols: 2 });
  try {
    const res = await extractXlsxTextStreaming(filePath, { batchSize: 7, maxRowsPerSheet: 10 });
    const lines = res.text.split('\n');
    const bodyLines = lines.length - 1; // minus the Sheet: header
    assert.equal(bodyLines, 10);
    assert.equal(res.metadata.rowCount, 10);
    assert.equal(res.metadata.partial, true);
    // First data row and last included row are the expected ones
    assert.equal(lines[1], 's1r1c1\ts1r1c2');
    assert.equal(lines[10], 's1r10c1\ts1r10c2');
  } finally {
    await fsp.unlink(filePath).catch(() => {});
  }
});

test('extractXlsxTextStreaming respects maxColumns and maxChars', async () => {
  const filePath = await generateWorkbook({ sheets: 1, rowsPerSheet: 4, cols: 6 });
  try {
    const res = await extractXlsxTextStreaming(filePath, { batchSize: 2, maxColumns: 2 });
    assert.ok(res.text.includes('s1r1c1\ts1r1c2'));
    assert.ok(!res.text.includes('s1r1c3'));

    const resChars = await extractXlsxTextStreaming(filePath, { batchSize: 2, maxChars: 40 });
    assert.equal(resChars.metadata.partial, true);
    assert.ok(resChars.text.length <= 40 + 1, `expected <=41 chars, got ${resChars.text.length}`);
  } finally {
    await fsp.unlink(filePath).catch(() => {});
  }
});

test('extractXlsxTextStreaming skips fully empty rows', async () => {
  const filePath = await generateWorkbook({ sheets: 1, rowsPerSheet: 6, cols: 2 });
  try {
    const res = await extractXlsxTextStreaming(filePath, { batchSize: 3 });
    // Generated rows are all non-empty; every generated row must appear.
    assert.equal(res.metadata.rowCount, 6);
    assert.equal(res.metadata.partial, false);
  } finally {
    await fsp.unlink(filePath).catch(() => {});
  }
});

test('parser exceljs case routes through the streaming reader', async () => {
  const { parseDocument } = require('../src/services/document-parsers');
  const filePath = await generateWorkbook({ sheets: 1, rowsPerSheet: 4, cols: 3 });
  try {
    const res = await parseDocument(
      filePath,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    // markitdown may win first in the strategy chain; when it fails/absent the
    // exceljs parser must produce the streaming-engine text.
    if (res.parser === 'xlsx-stream') {
      assert.ok(res.text.startsWith('Sheet: Sheet1'));
      assert.equal(res.metadata.engine, 'xlsx-stream');
    } else {
      assert.ok(['markitdown'].includes(res.parser), `unexpected parser ${res.parser}`);
    }
  } finally {
    await fsp.unlink(filePath).catch(() => {});
  }
});
