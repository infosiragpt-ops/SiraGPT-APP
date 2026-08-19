'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-warranties-extractor');
const { extractWarranties, buildWarrantiesForFiles, renderWarrantiesBlock } = engine;

test('empty / non-string input tolerated', () => {
  assert.equal(extractWarranties('').total, 0);
  assert.equal(extractWarranties(null).total, 0);
});

test('detects "warrants and represents" form', () => {
  const text = 'The Provider warrants and represents that the platform will perform substantially as documented.';
  const r = extractWarranties(text);
  assert.ok(r.warranties.length >= 1);
});

test('detects "covenants that" form', () => {
  const text = 'The Contractor covenants that the deliverables will be free from defects for ninety days.';
  const r = extractWarranties(text);
  assert.ok(r.warranties.length >= 1);
});

test('detects Spanish "garantiza que" form', () => {
  const text = 'El Proveedor garantiza que el servicio funcionará conforme a la documentación.';
  const r = extractWarranties(text);
  assert.ok(r.warranties.length >= 1);
});

test('detects Spanish "declara y garantiza" form', () => {
  const text = 'El Proveedor declara y garantiza que tiene todos los permisos necesarios.';
  const r = extractWarranties(text);
  assert.ok(r.warranties.length >= 1);
});

test('detects "as-is" disclaimer', () => {
  const text = 'The platform is provided "as-is" without any express or implied warranties.';
  const r = extractWarranties(text);
  assert.ok(r.disclaimers.length >= 1);
});

test('detects "disclaims any warranty" disclaimer', () => {
  const text = 'The Provider disclaims any warranty of merchantability or fitness for a particular purpose.';
  const r = extractWarranties(text);
  assert.ok(r.disclaimers.length >= 1);
});

test('detects Spanish "sin garantía" disclaimer', () => {
  const text = 'El servicio se otorga "tal cual" sin garantía de ningún tipo.';
  const r = extractWarranties(text);
  assert.ok(r.disclaimers.length >= 1);
});

test('disclaimer takes precedence over warranty when both keywords present', () => {
  const text = 'The platform is provided without warranty.';
  const r = extractWarranties(text);
  assert.equal(r.disclaimers.length, 1);
  assert.equal(r.warranties.length, 0);
});

test('dedupes identical sentences', () => {
  const text = 'The Provider warrants that the system works. The Provider warrants that the system works.';
  const r = extractWarranties(text);
  assert.equal(r.warranties.length, 1);
});

test('buildWarrantiesForFiles aggregates across files', () => {
  const files = [
    { name: 'a.md', extractedText: 'The Provider warrants that the system works.' },
    { name: 'b.md', extractedText: 'The platform is provided as-is.' },
  ];
  const r = buildWarrantiesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderWarrantiesBlock returns markdown when items exist', () => {
  const files = [{ name: 'demo.md', extractedText: 'The Provider warrants that the system performs as documented.' }];
  const r = buildWarrantiesForFiles(files);
  const md = renderWarrantiesBlock(r);
  assert.match(md, /^## WARRANTIES & DISCLAIMERS/);
});

test('renderWarrantiesBlock empty when nothing found', () => {
  assert.equal(renderWarrantiesBlock({ perFile: [] }), '');
  assert.equal(renderWarrantiesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildWarrantiesForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'X warrants that Y.' }]);
  assert.equal(r.perFile.length, 1);
});
