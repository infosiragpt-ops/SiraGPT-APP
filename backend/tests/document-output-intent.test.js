'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { documentOutputIntent } = require('../src/services/document-editing/document-output-intent');
const { parseDocxPrecisionRequest } = require('../src/services/document-editing/docx-precision-intent');

test('output names preserve Unicode and case and leave quoted document content opaque', () => {
  const result = documentOutputIntent('En Base.DOCX cambia “a” por “Entrega Otro.docx”. Guárdalo como «Edición final.DOCX».');
  assert.deepEqual(result.outputNames, ['Edición final.DOCX']);
  assert.equal(result.sourceInstruction, 'En Base.DOCX cambia “a” por “Entrega Otro.docx”.  .');
  assert.deepEqual(documentOutputIntent('Entrega A.PPTX y B.XLSX.').outputNames, ['A.PPTX', 'B.XLSX']);
});

test('quoted content and an explicit preservation clause do not negate delivery', () => {
  for (const instruction of [
    'En A.docx cambia «sí» por «no» y guarda como B.docx.',
    'En A.docx cambia «cuando corresponda» por «ahora» y entrega B.docx.',
    'Edita A.docx y no cambies el formato, entrega B.docx.',
    'Edita no.docx y entrega B.docx.',
    'Edita No-ventas.docx y entrega B.docx.',
    'Edita if.docx y entrega B.docx.',
  ]) {
    assert.deepEqual(documentOutputIntent(instruction).outputNames, ['B.docx'], instruction);
  }
});

test('negated, conditional or unsafe output names never authorize renaming', () => {
  for (const instruction of [
    'No guardes como B.pptx.', 'No debes guardar como B.pptx.', 'No quiero guardar como B.pptx.',
    'Don’t save as B.pptx.', 'Do not ever save as B.pptx.', 'Nunca entrega B.pptx.',
    'Si te lo autorizo después, guarda como B.pptx.',
    'Si reviso A.pptx después, guarda como B.pptx.',
    'No considero que en ningún caso debas guardar como B.pptx.', 'Guarda como B.pptx solo si te autorizo.',
    'Save as B.pptx if I approve.', 'Guarda como "../B.pptx".',
    'Guarda como "ruta/B.pptx".', 'Guarda como "B.pptx.exe".',
    'Guarda como "C:\\B.pptx".', 'Guarda como "B\n.pptx".',
  ]) {
    assert.deepEqual(documentOutputIntent(instruction), { sourceInstruction: instruction, outputNames: [] }, instruction);
  }
});

test('literal parsing cannot discard unsupported conversion or multiple copy obligations', () => {
  for (const suffix of ['Entrega B.docx y C.docx.', 'Entrega como C.pdf.']) {
    const result = parseDocxPrecisionRequest(`En A.docx cambia “Pendiente” por “Aprobado”. ${suffix}`);
    assert.equal(result.error.code, 'DOCX_EDIT_INSTRUCTION_REQUIRED');
  }
});
