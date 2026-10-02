'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isSourcePreservingEditRequest } = require('../src/services/source-preserving-document-edit');
const { shouldRunSourcePreservingEdit } = require('../src/services/agents/agent-task-runner');

const request = 'Prueba QA con datos sintéticos: crea un Excel llamado QA-graficas.xlsx con una hoja Resumen y las columnas Trimestre, Norte, Centro, Sur. Añade dos gráficas nativas editables debajo de la tabla sin superponerlas: columnas agrupadas y líneas rectas. Reabre el archivo y verifica los 12 valores y las dos gráficas antes de entregarlo.';

test('creating a spreadsheet with charts and readback does not search for an existing file to edit', () => {
  for (const fileIds of [[], ['source-data']]) {
    assert.equal(isSourcePreservingEditRequest(request, fileIds), false);
    assert.equal(shouldRunSourcePreservingEdit({ request, fileIds }), false);
  }
  for (const format of ['XLSX', 'CSV', 'ODS', 'hoja de cálculo']) {
    assert.equal(isSourcePreservingEditRequest(`Crea un ${format} con una tabla y añade una gráfica.`, []), false, format);
  }
});

test('requests to change existing spreadsheets still preserve the source', () => {
  for (const request of [
    'Añade dos gráficas al Excel adjunto y conserva los datos.',
    'Añade una gráfica al Excel adjunto y crea un Excel con los cambios.',
    'Agrega los datos de marzo al Excel que acabas de entregarme y prepara un Excel nuevo.',
    'Cambia la celda B2 de mi Excel a 42 sin modificar lo demás.',
    'Reemplaza las respuestas en el Excel adjunto y crea un XLSX actualizado.',
    'Completa la hoja Resumen de mi Excel y dame un Excel nuevo con esos cambios.',
  ]) assert.equal(isSourcePreservingEditRequest(request, ['existing-xlsx']), true, request);
});

test('a new output copy does not replace an edit of a previous spreadsheet', () => {
  assert.equal(isSourcePreservingEditRequest('En el Excel anterior añade una gráfica y crea un Excel actualizado.', []), true);
});


test('transformations of the existing file are not replaced by a new spreadsheet copy', () => {
  for (const request of [
    'Cambia los encabezados del archivo que acabas de entregarme y crea un Excel actualizado.',
    'Cambia el color de los encabezados en el Excel anterior y crea un Excel actualizado.',
    'Traduce este archivo al inglés y crea un Excel con la traducción.',
    'Reescribe los textos de este archivo y crea un Excel actualizado.',
    'Resume los textos de este archivo y crea un Excel actualizado.',
    'Pinta de color rojo los encabezados de este archivo y crea un Excel actualizado.',
    'Rota la página 2 del PDF y crea un Excel con el resultado.',
    'Agreega una gráfica en el Excel anterior y crea un Excel actualizado.',
  ]) {
    for (const fileIds of [[], ['existing-file']]) {
      assert.equal(isSourcePreservingEditRequest(request, fileIds), true, `${request} (${fileIds.length} attachments)`);
    }
  }
});

test('an image edit in an attachment can still deliver a new spreadsheet copy', () => {
  assert.equal(isSourcePreservingEditRequest('Recolorea la imagen de este archivo y crea un Excel actualizado.', ['existing-file']), true);
});

test('transformations after spreadsheet creation describe the new deliverable', () => {
  for (const request of [
    'Crea un Excel con una tabla y cambia los encabezados a inglés.',
    'Crea un Excel con una tabla y pinta los encabezados de rojo.',
    'Crea un Excel e incluye una imagen y recolorea la imagen de azul.',
  ]) {
    assert.equal(isSourcePreservingEditRequest(request, []), false, request);
  }
});
