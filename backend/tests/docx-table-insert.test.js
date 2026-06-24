'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { Document, Packer, Paragraph } = require('docx');
const PizZip = require('pizzip');

const {
  buildTableXml,
  insertTableIntoDocxBuffer,
  parseTableFromText,
  detectTableRequest,
  addTableFromRequest,
  buildCaptionIndex,
  detectIndexRequest,
  addIndexFromRequest,
} = require('../src/services/docx-table-insert');

async function makeDocxBuffer() {
  const doc = new Document({ sections: [{ children: [new Paragraph('Capítulo III. Presupuesto del proyecto.')] }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

describe('docx-table-insert — native table', () => {
  it('builds a bordered table XML with a header row and data rows', () => {
    const xml = buildTableXml(['Concepto', 'Monto'], [['Materiales', 'S/ 1200'], ['Servicios', 'S/ 800']]);
    assert.match(xml, /^<w:tbl>/);
    assert.match(xml, /<w:tblBorders>/);
    assert.match(xml, /Concepto/);
    assert.match(xml, /S\/ 1200/);
    assert.match(xml, /<w:b\/>/); // header bold
    assert.equal((xml.match(/<w:tr>/g) || []).length, 3); // header + 2 rows
  });

  it('escapes hostile cell text (no injection)', () => {
    const xml = buildTableXml(['<x>'], [['</w:t></w:r>']]);
    assert.doesNotMatch(xml, /<x>/);
    assert.match(xml, /&lt;x&gt;/);
  });

  it('inserts the table into a DOCX preserving the original content', async () => {
    const docx = await makeDocxBuffer();
    const out = insertTableIntoDocxBuffer(docx, { headers: ['A', 'B'], rows: [['1', '2']], title: 'Tabla 1. Presupuesto' });
    const xml = new PizZip(out).file('word/document.xml').asText();
    assert.match(xml, /Capítulo III/); // preserved
    assert.match(xml, /<w:tbl>/);
    assert.match(xml, /Tabla 1\. Presupuesto/); // caption
  });

  it('parses a markdown-style table from text', () => {
    const spec = parseTableFromText('| Concepto | Monto |\n| --- | --- |\n| Materiales | 1200 |\n| Servicios | 800 |');
    assert.deepEqual(spec.headers, ['Concepto', 'Monto']);
    assert.equal(spec.rows.length, 2);
    assert.deepEqual(spec.rows[0], ['Materiales', '1200']);
  });

  it('ignores prose before the first pipe so a prefixed header is clean', () => {
    const spec = parseTableFromText('agrega una tabla con | Concepto | Monto |\n| Materiales | 1200 |\n| Servicios | 800 |');
    assert.deepEqual(spec.headers, ['Concepto', 'Monto']);
    assert.equal(spec.rows.length, 2);
  });

  it('detects create-table intent but not fill-table intent', () => {
    assert.equal(detectTableRequest('agrega una tabla de presupuesto').wantsTable, true);
    assert.equal(detectTableRequest('inserta un cuadro comparativo').wantsTable, true);
    assert.equal(detectTableRequest('completa la tabla del anexo 3').wantsTable, false);
    assert.equal(detectTableRequest('corrige la ortografía').wantsTable, false);
  });

  it('adds a table from a markdown request without a model', async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const docx = await makeDocxBuffer();
      const md = 'agrega una tabla con el presupuesto:\n| Concepto | Monto |\n| Materiales | 1200 |\n| Servicios | 800 |';
      const res = await addTableFromRequest(docx, { requestText: md });
      assert.equal(res.added, true);
      assert.equal(res.spec.rowCount, 2);
      assert.match(new PizZip(res.buffer).file('word/document.xml').asText(), /<w:tbl>/);

      const noData = await addTableFromRequest(docx, { requestText: 'agrega una tabla bonita' });
      assert.equal(noData.added, false);
      assert.equal(noData.reason, 'no_data');
    } finally {
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedKey;
    }
  });

  it('auto-numbers tables APA-style and increments across inserts', async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const docx = await makeDocxBuffer();
      const md = 'agrega una tabla: | A | B |\n| 1 | 2 |';
      const first = await addTableFromRequest(docx, { requestText: md });
      assert.match(first.spec.title, /^Tabla 1\b/);
      assert.match(new PizZip(first.buffer).file('word/document.xml').asText(), /Tabla 1\b/);
      const second = await addTableFromRequest(first.buffer, { requestText: md });
      assert.match(second.spec.title, /^Tabla 2\b/);
    } finally {
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedKey;
    }
  });
});

describe('docx-table-insert — índice de figuras/tablas', () => {
  async function docWithCaptions() {
    const doc = new Document({ sections: [{ children: [
      new Paragraph('Figura 1. Resultados por dimensión'),
      new Paragraph('Tabla 1. Presupuesto del proyecto'),
      new Paragraph('Figura 2. Distribución de la muestra'),
    ] }] });
    return Buffer.from(await Packer.toBuffer(doc));
  }

  it('detects index intent and scope, and not a create-table request', () => {
    assert.deepEqual(detectIndexRequest('genera el índice de figuras'), { wantsIndex: true, scope: 'figures' });
    assert.deepEqual(detectIndexRequest('agrega la lista de tablas'), { wantsIndex: true, scope: 'tables' });
    assert.equal(detectIndexRequest('crea el índice de figuras y tablas').scope, 'both');
    assert.equal(detectTableRequest('genera el índice de tablas').wantsTable, false);
  });

  it('builds the caption index from the document', async () => {
    const xml = new PizZip(await docWithCaptions()).file('word/document.xml').asText();
    const idx = buildCaptionIndex(xml);
    assert.equal(idx.figures.length, 2);
    assert.equal(idx.tables.length, 1);
    assert.equal(idx.figures[0].title, 'Resultados por dimensión');
  });

  it('inserts an índice de figuras/tablas listing existing captions', async () => {
    const res = await addIndexFromRequest(await docWithCaptions(), { requestText: 'genera el índice de figuras y tablas' });
    assert.equal(res.added, true);
    const xml = new PizZip(res.buffer).file('word/document.xml').asText();
    assert.match(xml, /Índice de figuras/);
    assert.match(xml, /Índice de tablas/);
    assert.match(xml, /Figura 2\. Distribución de la muestra/);
  });

  it('is a no-op when there are no captions to index', async () => {
    const doc = new Document({ sections: [{ children: [new Paragraph('Sin figuras ni tablas aún.')] }] });
    const res = await addIndexFromRequest(Buffer.from(await Packer.toBuffer(doc)), { requestText: 'genera el índice de figuras' });
    assert.equal(res.added, false);
    assert.equal(res.reason, 'no_captions');
  });
});
