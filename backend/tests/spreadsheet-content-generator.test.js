'use strict';

// Topic-specific XLSX content — regression tests for the "every Excel is the
// same fake Mes/Ventas/Costos workbook" bug. The generator asks the content
// ladder for topic-specific headers/rows; these tests cover the offline
// normalization contract and the fail-open null path (no provider key).

const test = require('node:test');
const assert = require('node:assert');

const {
  generateSpreadsheetContent,
  normalizeContent,
  sanitizeSheetName,
} = require('../src/services/document-pipeline/content/generate-spreadsheet-content');

test('normalizeContent keeps typed rows aligned to headers', () => {
  const out = normalizeContent({
    sheetName: 'Inventario',
    headers: ['Producto', 'Stock', 'Precio'],
    rows: [
      ['Paracetamol', 120, 0.12],
      ['Ibuprofeno', 80, 0.18, 'extra-cell-dropped'],
      ['Amoxicilina', 45],
      ['Omeprazol', 60, 0.25],
    ],
    numericColumns: [1, 2],
    currencyColumns: [2],
    insights: [{ finding: 'Stock crítico', interpretation: 'Tres productos bajo mínimo.' }],
  });
  assert.equal(out.sheetName, 'Inventario');
  assert.equal(out.headers.length, 3);
  for (const row of out.rows) assert.equal(row.length, 3);
  assert.equal(out.rows[1].length, 3, 'extra cells dropped');
  assert.equal(out.rows[2][2], '', 'short rows padded');
  assert.equal(typeof out.rows[0][1], 'number', 'numbers stay numbers');
  assert.deepEqual(out.currencyColumns, [2]);
});

test('normalizeContent rejects degenerate payloads (fail-open to template)', () => {
  assert.equal(normalizeContent(null), null);
  assert.equal(normalizeContent({ headers: ['solo-una'] }), null);
  assert.equal(normalizeContent({ headers: ['a', 'b'], rows: [['x', 1]] }), null, '<3 rows rejected');
});

test('normalizeContent drops out-of-range column indexes', () => {
  const out = normalizeContent({
    sheetName: 'x',
    headers: ['a', 'b'],
    rows: [['r', 1], ['s', 2], ['t', 3]],
    numericColumns: [1, 7, -2],
    currencyColumns: [1, 9],
    insights: [],
  });
  assert.deepEqual(out.numericColumns, [1]);
  assert.deepEqual(out.currencyColumns, [1]);
});

test('sanitizeSheetName strips Excel-invalid characters and caps length', () => {
  assert.equal(sanitizeSheetName('Ventas/Q1[2026]*?'), 'Ventas Q1 2026');
  assert.equal(sanitizeSheetName(''), 'Datos');
  assert.ok(sanitizeSheetName('x'.repeat(60)).length <= 24);
});

test('generateSpreadsheetContent returns null when no provider is configured', async (t) => {
  const saved = {};
  for (const key of ['CEREBRAS_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  });
  const out = await generateSpreadsheetContent({ prompt: 'excel de inventario', title: 'Inventario' });
  assert.equal(out, null);
});
