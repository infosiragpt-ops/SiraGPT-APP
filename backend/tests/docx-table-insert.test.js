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
});
