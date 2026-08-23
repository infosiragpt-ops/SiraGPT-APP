'use strict';

const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const fsp = require('fs/promises');

const DEFAULT_BATCH = Number.parseInt(
  process.env.SIRAGPT_XLSX_STREAM_BATCH || '500',
  10
);
const DEFAULT_MAX_RSS_MB = Number.parseInt(
  process.env.SIRAGPT_STREAM_MAX_RSS_MB || '900',
  10
);
const DEFAULT_MAX_ROWS_PER_SHEET = Number.parseInt(
  process.env.SIRAGPT_XLSX_STREAM_MAX_ROWS_PER_SHEET || '1000',
  10
);
const DEFAULT_MAX_COLUMNS = 80;

function clampPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getXlsxStreamMaxRows(value = process.env.SIRAGPT_XLSX_STREAM_MAX_ROWS_PER_SHEET) {
  return clampPositiveInt(value, DEFAULT_MAX_ROWS_PER_SHEET);
}

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
 * Single pass over the workbook through exceljs WorkbookReader. Batches flow
 * through yield; per-pass diagnostics land in `stats`.
 *
 * KNOWN ISSUE (exceljs 4.4.0): the WorkbookReader has a startup race between
 * worksheet zip entries and xl/workbook.xml — it crashes `_parseWorksheet`
 * ("Cannot read properties of undefined (reading 'sheets')") or drops sheets
 * silently (reproduced ~50% of runs). streamXlsxRows defends with bounded
 * retries; the deterministic text path below does not use this reader.
 */
async function* readWorkbookBatches(filePath, { batchSize, maxRssMb, partialRef, stats }) {
  const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'ignore',
    worksheets: 'emit',
    entries: 'emit',
  });

  // exceljs emits 'error' outside the pull cycle too; record instead of letting
  // it become an unhandled 'error' event that kills the process.
  const onReaderError = (err) => {
    if (!stats.readerError) stats.readerError = err;
  };
  workbookReader.on('error', onReaderError);
  const onEntry = (entry) => {
    if (entry && entry.type === 'worksheet') stats.entryWorksheetCount += 1;
  };
  workbookReader.on('entry', onEntry);

  try {
    let batchIdx = 0;
    let aborted = false;

    for await (const worksheet of workbookReader) {
      const sheetName = worksheet.name || `Sheet${worksheet.id || ''}`;
      stats.sheetNames.add(sheetName);
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
  } finally {
    workbookReader.off('error', onReaderError);
    workbookReader.off('entry', onEntry);
  }
}

/**
 * Stream rows from an XLSX file as batches of N rows per yield.
 * Each yielded item: { sheet, batch, rows, rowOffset, rssMb }.
 * Stops early when RSS exceeds opts.maxRssMb.
 *
 * Retries a fresh pass while nothing reached the consumer yet (exceljs 4.4.0
 * startup race); once rows were yielded a mid-stream failure propagates
 * instead of restarting, which would duplicate rows.
 */
async function* streamXlsxRows(filePath, opts = {}) {
  const batchSize = opts.batchSize || DEFAULT_BATCH;
  const maxRssMb = opts.maxRssMb || DEFAULT_MAX_RSS_MB;
  const partialRef = opts.partialRef || { partial: false };
  const maxAttempts = clampPositiveInt(opts.readerAttempts ?? 3, 3);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let everYielded = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const stats = { sheetNames: new Set(), entryWorksheetCount: 0, readerError: null };
    try {
      for await (const batch of readWorkbookBatches(filePath, {
        batchSize,
        maxRssMb,
        partialRef,
        stats,
      })) {
        everYielded = true;
        yield batch;
      }

      const lostSheets = Math.max(0, stats.entryWorksheetCount - stats.sheetNames.size);
      if (lostSheets > 0 && !partialRef.partial) {
        if (!everYielded && attempt < maxAttempts) {
          await delay(25 * attempt);
          continue;
        }
        partialRef.partial = true;
      }
      return;
    } catch (err) {
      if (everYielded) throw err;
      if (attempt >= maxAttempts) throw err;
      await delay(25 * attempt);
    }
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

// --- Deterministic OOXML text extraction -------------------------------
//
// exceljs 4.4.0's streaming WorkbookReader races its own zip demux (crash or
// silent sheet loss ~50% of runs, see readWorkbookBatches). Text extraction
// therefore reads the OOXML parts directly and in a fixed order: shared
// strings, sheet order from xl/workbook.xml, cells by reference. Only one
// sheet XML is materialized at a time, so peak memory stays flat per sheet
// instead of holding the whole Cell graph like the in-memory reader.

function decodeXmlEntities(text = '') {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function colIndexFromRef(ref) {
  const m = /^([A-Za-z]+)\d+$/.exec(String(ref || ''));
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function parseSharedStrings(xml) {
  const shared = [];
  if (!xml) return shared;
  for (const siM of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const tM of siM[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
      text += decodeXmlEntities(tM[1]);
    }
    shared.push(text);
  }
  return shared;
}

// Yields gap-filled 0-indexed arrays of cell texts for each non-empty row.
function* iterWorksheetRowValues(xml, shared, maxColumns) {
  const rowRe = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rowM;
  while ((rowM = rowRe.exec(xml))) {
    const body = rowM[1] || '';
    if (!body) continue;
    const values = [];
    let maxSeen = 0;
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellM;
    while ((cellM = cellRe.exec(body))) {
      const attrs = cellM[1] || '';
      const cellBody = cellM[2] || '';
      const refM = /\br="([A-Za-z]+\d+)"/.exec(attrs);
      const col = refM ? colIndexFromRef(refM[1]) : values.length + 1;
      if (col < 1 || col > maxColumns) continue;
      const typeM = /\bt="(\w+)"/.exec(attrs);
      const type = typeM ? typeM[1] : 'n';
      let text = '';
      const vM = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(cellBody);
      if (type === 's') {
        const idx = vM ? Number.parseInt(vM[1], 10) : NaN;
        text = Number.isInteger(idx) && idx >= 0 && idx < shared.length ? shared[idx] : '';
      } else if (type === 'b') {
        text = vM && vM[1].trim() === '1' ? 'true' : 'false';
      } else if (type === 'inlineStr') {
        for (const tM of cellBody.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
          text += decodeXmlEntities(tM[1]);
        }
      } else if (vM) {
        text = decodeXmlEntities(vM[1]);
      }
      values[col - 1] = text;
      if (col > maxSeen) maxSeen = col;
    }
    if (maxSeen === 0) continue;
    const out = new Array(maxSeen);
    for (let i = 0; i < maxSeen; i += 1) out[i] = values[i] ?? '';
    yield out;
  }
}

async function loadXlsxParts(filePath) {
  const buffer = await fsp.readFile(filePath);
  const zip = await JSZip.loadAsync(buffer);

  let shared = [];
  const ssEntry = zip.file('xl/sharedStrings.xml');
  if (ssEntry) shared = parseSharedStrings(await ssEntry.async('string'));

  const normalizeTarget = (target) => {
    const t = String(target || '').replace(/^\//, '');
    return /^xl\//.test(t) ? t : `xl/${t}`;
  };
  const relTargets = new Map();
  const relsEntry = zip.file('xl/_rels/workbook.xml.rels');
  if (relsEntry) {
    const relsXml = await relsEntry.async('string');
    for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
      const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
      if (id && target) relTargets.set(id, normalizeTarget(target));
    }
  }

  const sheets = [];
  const wbEntry = zip.file('xl/workbook.xml');
  if (wbEntry) {
    const wbXml = await wbEntry.async('string');
    for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
      const rawName = /\bname="([^"]*)"/.exec(m[0])?.[1] ?? '';
      const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1];
      const path = rid ? relTargets.get(rid) : null;
      if (path) sheets.push({ name: decodeXmlEntities(rawName) || path, path });
    }
  }
  if (sheets.length === 0) {
    const fallback = Object.keys(zip.files)
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
    for (const p of fallback) sheets.push({ name: p.split('/').pop(), path: p });
  }

  return { zip, shared, sheets };
}

/**
 * Extract a bounded text view of an XLSX file with memory flat per sheet
 * (the in-memory `readXlsxFile` path holds the whole Cell graph, which is
 * what times out on large books). Text shape matches the exceljs parser
 * contract consumed downstream:
 *   Sheet: <name>
 *   <c1>\t<c2>\t...
 *
 * Bounded by rows-per-sheet, columns and total characters; `partial` reports
 * whether any limit truncated the content.
 */
async function extractXlsxTextStreaming(filePath, opts = {}) {
  const start = Date.now();
  const maxRows = clampPositiveInt(
    opts.maxRowsPerSheet ?? process.env.SIRAGPT_XLSX_STREAM_MAX_ROWS_PER_SHEET,
    DEFAULT_MAX_ROWS_PER_SHEET,
  );
  const maxColumns = clampPositiveInt(opts.maxColumns ?? DEFAULT_MAX_COLUMNS, DEFAULT_MAX_COLUMNS);
  const maxChars = opts.maxChars ?? null;

  let peakRss = rssMb();
  let totalRows = 0;
  const sheetStats = [];
  const parts = [];
  let chars = 0;
  let partial = false;

  const pushLine = (line) => {
    if (maxChars != null && chars + line.length + 1 > maxChars) {
      partial = true;
      return false;
    }
    parts.push(line);
    chars += line.length + 1;
    return true;
  };

  const { zip, shared, sheets } = await loadXlsxParts(filePath);
  for (const sheet of sheets) {
    const entry = zip.file(sheet.path);
    if (!entry) continue;
    peakRss = Math.max(peakRss, rssMb());
    const xml = await entry.async('string');
    const stat = { name: sheet.name, rows: 0 };
    let headerEmitted = false;
    for (const values of iterWorksheetRowValues(xml, shared, maxColumns)) {
      if (stat.rows >= maxRows) {
        partial = true;
        break;
      }
      if (!values.some((value) => String(value).trim())) continue;
      if (!headerEmitted) {
        if (!pushLine(`Sheet: ${sheet.name}`)) break;
        headerEmitted = true;
      }
      if (!pushLine(values.join('\t'))) break;
      stat.rows += 1;
      totalRows += 1;
    }
    if (stat.rows > 0) sheetStats.push(stat);
    if (partial) break;
  }

  return {
    text: parts.join('\n'),
    parser: 'xlsx-stream',
    metadata: {
      engine: 'xlsx-stream',
      charCount: chars > 0 ? chars - 1 : 0,
      rowCount: totalRows,
      sheets: sheetStats,
      partial,
      peakRssMb: peakRss,
      elapsedMs: Date.now() - start,
    },
  };
}

module.exports = {
  streamXlsxRows,
  extractXlsxStreaming,
  extractXlsxTextStreaming,
  getXlsxStreamMaxRows,
  DEFAULT_BATCH,
  DEFAULT_MAX_RSS_MB,
  DEFAULT_MAX_ROWS_PER_SHEET,
};
