const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');

const documentIntelligence = require('../src/services/document-intelligence');

async function writeXlsx(filePath, sheetName, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  if (rows.length) {
    const columns = Object.keys(rows[0]);
    sheet.addRow(columns);
    for (const row of rows) sheet.addRow(columns.map((col) => row[col]));
  }
  await workbook.xlsx.writeFile(filePath);
}

function createPrismaMock(files) {
  const analyses = new Map();
  let chunks = [];
  let tables = [];
  const fileRows = new Map(files.map((file) => [file.id, { createdAt: new Date('2026-01-01T00:00:00Z'), ...file }]));

  return {
    file: {
      async findFirst({ where }) {
        const row = fileRows.get(where.id);
        if (!row || row.userId !== where.userId) return null;
        return row;
      },
      async update({ where, data }) {
        const row = fileRows.get(where.id);
        if (row) Object.assign(row, data);
        return row;
      },
    },
    documentAnalysis: {
      async findUnique({ where }) {
        return analyses.get(where.fileId) || null;
      },
      async upsert({ where, create, update }) {
        const current = analyses.get(where.fileId);
        const next = {
          id: current?.id || `analysis-${where.fileId}`,
          createdAt: current?.createdAt || new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-02T00:00:00Z'),
          ...(current ? update : create),
        };
        analyses.set(where.fileId, next);
        return next;
      },
    },
    documentChunk: {
      deleteMany({ where }) {
        chunks = chunks.filter((chunk) => chunk.analysisId !== where.analysisId);
        return Promise.resolve({ count: 1 });
      },
      createMany({ data }) {
        data.forEach((item, index) => chunks.push({ id: `chunk-${item.fileId}-${index + 1}`, createdAt: new Date(), ...item }));
        return Promise.resolve({ count: data.length });
      },
      findMany({ where, take }) {
        return Promise.resolve(chunks.filter((chunk) => chunk.analysisId === where.analysisId).slice(0, take || chunks.length));
      },
    },
    documentTable: {
      deleteMany({ where }) {
        tables = tables.filter((table) => table.analysisId !== where.analysisId);
        return Promise.resolve({ count: 1 });
      },
      createMany({ data }) {
        data.forEach((item, index) => tables.push({ id: `table-${item.fileId}-${index + 1}`, createdAt: new Date(), ...item }));
        return Promise.resolve({ count: data.length });
      },
      findMany({ where }) {
        return Promise.resolve(tables.filter((table) => table.analysisId === where.analysisId));
      },
    },
    $transaction(ops) {
      return Promise.all(ops);
    },
  };
}

test('DocumentIntelligence reprocesses generic xlsx placeholder text from stored uploads', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-docintel-placeholder-'));
  const xlsxPath = path.join(tmpDir, 'base_sucesion_intestada_seleccionados.xlsx');
  try {
    await writeXlsx(xlsxPath, 'Referencias', [
      {
        'Título del articulo': 'Sucesión intestada y herederos',
        Autores: 'García López, M.',
        'Año de publicacion': 2021,
      },
    ]);

    const prisma = createPrismaMock([
      {
        id: 'file-xlsx-placeholder',
        userId: 'user-1',
        originalName: 'base_sucesion_intestada_seleccionados.xlsx',
        filename: 'stored-random.xlsx',
        mimeType: 'application/zip',
        path: xlsxPath,
        extractedText: 'File "base_sucesion_intestada_seleccionados.xlsx" uploaded successfully. Content type: application/zip',
      },
    ]);

    const analysis = await documentIntelligence.analyzeFile(prisma, {
      userId: 'user-1',
      fileId: 'file-xlsx-placeholder',
    });

    assert.equal(analysis.status, 'ready');
    assert.equal(analysis.tableCount, 1);
    assert.match(analysis.chunks[0].text, /Sucesión intestada y herederos/);
    assert.equal(analysis.tables[0].sheetName, 'Referencias');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
