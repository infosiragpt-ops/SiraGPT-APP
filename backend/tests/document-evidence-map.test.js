'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const evidenceMap = require('../src/services/document-evidence-map');

test('document evidence map extracts page anchored factual snippets', () => {
  const report = evidenceMap.buildEvidenceMapForFiles([
    {
      id: 'file-1',
      name: 'contrato.pdf',
      mimeType: 'application/pdf',
      extractedText: [
        'PDF document - 2 pages extracted',
        '[page 1]',
        'El contrato fue aprobado el 2026-05-12 por el comite legal.',
        '[page 2]',
        'El monto maximo de penalidad es USD 24,500 y debe revisarse antes del 30/06/2026.',
      ].join('\n'),
    },
  ]);

  assert.equal(report.totals.files, 1);
  assert.ok(report.totals.snippets >= 2);
  assert.equal(report.perFile[0].snippets[0].anchor.type, 'page');

  const block = evidenceMap.renderEvidenceMapBlock(report);
  assert.match(block, /DOCUMENT EVIDENCE MAP/);
  assert.match(block, /contrato\.pdf/);
  assert.match(block, /page 2/);
  assert.match(block, /USD 24,500/);
});

test('document evidence map handles spreadsheets with sheet anchors', () => {
  const report = evidenceMap.buildEvidenceMapForFiles([
    {
      id: 'sheet-1',
      name: 'ventas.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extractedText: [
        'Excel workbook - 1 sheet',
        'Sheet: Q1',
        'Ingresos totales fueron Bs. 120000 con margen 18%.',
        'Riesgo: la cobranza pendiente supera 45 dias.',
      ].join('\n'),
    },
  ]);

  const block = evidenceMap.renderEvidenceMapBlock(report);
  assert.match(block, /sheet Q1/);
  assert.match(block, /18%/);
  assert.match(block, /cobranza pendiente/);
});

test('document evidence map returns empty block when there is no evidence', () => {
  const report = evidenceMap.buildEvidenceMapForFiles([
    { name: 'vacio.txt', mimeType: 'text/plain', extractedText: 'hola mundo' },
  ]);

  assert.equal(evidenceMap.renderEvidenceMapBlock(report), '');
});
