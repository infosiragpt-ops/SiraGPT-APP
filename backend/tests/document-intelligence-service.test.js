const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const documentIntelligence = require('../src/services/document-intelligence');

test('DocumentIntelligence chunks DOCX-style markdown by section headings', () => {
  const text = [
    'Word document - structure preserved as markdown',
    '---',
    '# Introduccion',
    'La investigacion analiza la gestion empresarial.',
    '',
    '## Hallazgos',
    'Se identifican tres lineas prioritarias y una tabla de indicadores.',
  ].join('\n');

  const chunks = documentIntelligence.buildChunks({
    originalName: 'tesis.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }, text);

  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].sourceType, 'section');
  assert.equal(chunks[0].sectionTitle, 'Introduccion');
  assert.ok(chunks.some((chunk) => chunk.sectionTitle === 'Hallazgos'));
});

test('DocumentIntelligence extracts normalized XLSX tables with row preview', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-docintel-'));
  const xlsxPath = path.join(tmpDir, 'negocios.xlsx');
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet([
    { Mes: 'Ene', Ventas: 1200, Costos: 700 },
    { Mes: 'Feb', Ventas: 1400, Costos: 810 },
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'KPIs');
  XLSX.writeFile(workbook, xlsxPath);

  const tables = documentIntelligence.buildTables({
    originalName: 'negocios.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    path: xlsxPath,
  }, '');

  assert.equal(tables.length, 1);
  assert.equal(tables[0].sheetName, 'KPIs');
  assert.deepEqual(tables[0].columns, ['Mes', 'Ventas', 'Costos']);
  assert.equal(tables[0].rowCount, 2);
  assert.equal(tables[0].preview[0].Mes, 'Ene');
});

test('DocumentIntelligence detects markdown tables in extracted DOCX/PDF text', () => {
  const text = [
    '# Matriz',
    '| Categoria | Resultado |',
    '| --- | --- |',
    '| Gestion | Alta |',
    '| Riesgo | Medio |',
  ].join('\n');

  const tables = documentIntelligence.buildTables({
    originalName: 'matriz.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }, text);

  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].columns, ['Categoria', 'Resultado']);
  assert.equal(tables[0].rowCount, 2);
});

test('DocumentIntelligence returns empty analysis signals without inventing text', () => {
  const chunks = documentIntelligence.buildChunks({ originalName: 'scan.png', mimeType: 'image/png' }, 'No text found in image');
  const summary = documentIntelligence.buildSummary({ originalName: 'scan.png' }, 'No text found in image', chunks, []);

  assert.equal(chunks.length, 0);
  assert.match(summary, /No se encontro texto legible/);
});

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
      async findFirst({ where }) {
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

test('DocumentIntelligence compares documents with evidence and deltas', async () => {
  const prisma = createPrismaMock([
    {
      id: 'file-a',
      userId: 'user-1',
      originalName: 'plan-a.md',
      mimeType: 'text/markdown',
      extractedText: '# Ventas\nLa estrategia prioriza crecimiento, ventas y productividad.\n| KPI | Valor |\n| --- | --- |\n| Ventas | Alta |',
    },
    {
      id: 'file-b',
      userId: 'user-1',
      originalName: 'plan-b.md',
      mimeType: 'text/markdown',
      extractedText: '# Riesgos\nLa estrategia prioriza control de costos y productividad.\n| KPI | Valor |\n| --- | --- |\n| Costos | Medio |',
    },
  ]);

  const result = await documentIntelligence.compareDocuments(prisma, {
    userId: 'user-1',
    fileIds: ['file-a', 'file-b'],
    query: 'estrategia productividad',
  });

  assert.equal(result.documents.length, 2);
  assert.equal(result.comparisons.length, 1);
  assert.ok(result.comparisons[0].sharedTerms.includes('estrategia'));
  assert.ok(result.documents.every((doc) => doc.evidence.length >= 1));
  assert.ok(result.documents.every((doc) => doc.tableCount >= 1));
});
