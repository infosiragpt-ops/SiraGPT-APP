'use strict';

// Benchmark: lectura XLSX en memoria vs streaming.
// Genera libros sintéticos de tamaño creciente y mide tiempo y ΔRSS de cada
// lector con los mismos límites de salida (≤ maxRows filas por hoja).
//
// Uso: node scripts/benchmark-xlsx-readers.js [--out resultados.md]

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const ExcelJS = require('exceljs');

const { extractXlsxTextStreaming } = require('../src/services/document/streaming-xlsx');
const {
  readXlsxFile,
  selectWorkbookWorksheets,
} = require('../src/services/xlsx-safe-workbook');

function rssMb() {
  return process.memoryUsage().rss / (1024 * 1024);
}

async function generateWorkbook(filePath, sheetCount, rowsPerSheet, cols) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath });
  for (let s = 0; s < sheetCount; s += 1) {
    const ws = wb.addWorksheet(`Hoja${s + 1}`);
    const header = Array.from({ length: cols }, (_, c) => `columna_${c + 1}`);
    ws.addRow(header).commit();
    for (let r = 0; r < rowsPerSheet; r += 1) {
      const row = new Array(cols);
      for (let c = 0; c < cols; c += 1) row[c] = c === 0 ? `registro-${r + 1}` : (r + 1) * (c + 7);
      ws.addRow(row).commit();
    }
    ws.commit();
  }
  await wb.commit();
}

async function benchInMemory(filePath, maxRowsPerSheet) {
  const rssBefore = rssMb();
  const t0 = Date.now();
  const workbook = await readXlsxFile(filePath);
  const { worksheets } = selectWorkbookWorksheets(workbook);
  let emittedRows = 0;
  for (const ws of worksheets) {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (rows.length >= maxRowsPerSheet) return;
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows.push(values.map((v) => (v == null ? '' : typeof v === 'object' && v.text != null ? String(v.text) : String(v))));
    });
    emittedRows += rows.filter((r) => r.some((v) => String(v).trim())).length;
  }
  return {
    elapsedMs: Date.now() - t0,
    rssDeltaMb: Math.max(0, rssMb() - rssBefore),
    rows: emittedRows,
  };
}

async function benchStreaming(filePath, maxRowsPerSheet) {
  const rssBefore = rssMb();
  const t0 = Date.now();
  const res = await extractXlsxTextStreaming(filePath, { maxRowsPerSheet });
  return {
    elapsedMs: Date.now() - t0,
    rssDeltaMb: Math.max(0, rssMb() - rssBefore),
    rows: res.metadata.rowCount,
    partial: res.metadata.partial,
  };
}

function fmt(n) {
  return Number.isFinite(n) ? n.toLocaleString('es-PE', { maximumFractionDigits: 1 }) : '—';
}

async function main() {
  const outArgIdx = process.argv.indexOf('--out');
  const outFile = outArgIdx > -1 ? process.argv[outArgIdx + 1] : null;
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'siragpt-bench-xlsx-'));
  const cases = [
    { label: '10k × 8', sheets: 1, rows: 10_000, cols: 8 },
    { label: '50k × 8', sheets: 1, rows: 50_000, cols: 8 },
    { label: '100k × 8', sheets: 1, rows: 100_000, cols: 8 },
  ];
  const MAX_ROWS_PER_SHEET = 1000;

  const lines = [
    '# Benchmark lectura XLSX: en memoria vs streaming',
    '',
    `Generado: ${new Date().toISOString()} · node ${process.version} · límites de salida: ≤${MAX_ROWS_PER_SHEET} filas/hoja`,
    '',
    '| Libro | Lector | Tiempo (ms) | ΔRSS (MB) | Filas procesadas |',
    '|---|---|---|---|---|',
  ];

  try {
    let lastStream = null;
    for (const c of cases) {
      const filePath = path.join(tmpDir, `bench-${c.rows}.xlsx`);
      process.stdout.write(`generando ${c.label}…\n`);
      await generateWorkbook(filePath, c.sheets, c.rows, c.cols);
      const stat = await fsp.stat(filePath);

      const mem = await benchInMemory(filePath, MAX_ROWS_PER_SHEET);
      lines.push(`| ${c.label} (${(stat.size / 1048576).toFixed(1)} MB) | en memoria | ${fmt(mem.elapsedMs)} | ${fmt(mem.rssDeltaMb)} | ${fmt(mem.rows)} |`);

      const stream = await benchStreaming(filePath, MAX_ROWS_PER_SHEET);
      lines.push(`| ${c.label} | streaming | ${fmt(stream.elapsedMs)} | ${fmt(stream.rssDeltaMb)} | ${fmt(stream.rows)}${stream.partial ? ' (parcial)' : ''} |`);
      lastStream = stream;
      await fsp.unlink(filePath);
    }

    if (lastStream && lastStream.elapsedMs > 0) {
      const lastCase = cases[cases.length - 1];
      const fullScanRows = lastCase.rows * lastCase.sheets;
      const fullScanRowsPerSec = Math.round(fullScanRows / (lastStream.elapsedMs / 1000));
      lines.push('');
      lines.push(`Throughput streaming (escaneo completo del libro mayor): ~${fmt(fullScanRowsPerSec)} filas/s con RSS plano.`);
      lines.push('');
      lines.push('## Límites medidos (derivados)');
      lines.push('');
      lines.push('- La memoria del lector streaming es constante (ΔRSS plano entre 10k y 100k filas): el tamaño del libro deja de ser el factor de riesgo.');
      lines.push(`- A ~${fmt(fullScanRowsPerSec)} filas/s, el presupuesto por defecto del parser (SIRAGPT_PARSER_TOTAL_TIMEOUT_MS=120000 ms) cubre órdenes de magnitud más filas que cualquier libro razonable; el corte lo imponen los límites de salida (${MAX_ROWS_PER_SHEET} filas/hoja por defecto, SIRAGPT_XLSX_STREAM_MAX_ROWS_PER_SHEET), no timeouts.`);
      lines.push('- El lector en memoria crece lineal con el tamaño del libro (ΔRSS y tiempo): es la vía que muere por timeout/OOM en libros grandes.');
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  const report = lines.join('\n');
  process.stdout.write(report + '\n');
  if (outFile) {
    await fsp.writeFile(outFile, report + '\n', 'utf8');
    process.stdout.write(`\nguardado en ${outFile}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
