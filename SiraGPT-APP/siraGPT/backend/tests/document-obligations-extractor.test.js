'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-obligations-extractor');
const { extractObligations, buildObligationsForFiles, renderObligationsBlock, _internal } = engine;
const { isObligation, detectProhibition, detectDeadline, detectSubject } = _internal;

test('empty / non-string input tolerated', () => {
  assert.equal(extractObligations('').total, 0);
  assert.equal(extractObligations(null).total, 0);
});

test('isObligation: detects shall/must/will', () => {
  assert.ok(isObligation('The Contractor shall deliver the report.'));
  assert.ok(isObligation('Tenant must pay rent on the first.'));
  assert.ok(isObligation('Provider will install the system.'));
  assert.ok(!isObligation('It is a sunny day.'));
});

test('isObligation: detects Spanish modals', () => {
  assert.ok(isObligation('El Contratista deberá entregar el informe.'));
  assert.ok(isObligation('La Parte A se compromete a pagar.'));
  assert.ok(isObligation('El Cliente está obligado a notificar.'));
  assert.ok(!isObligation('Fue un día soleado.'));
});

test('detectProhibition: shall not / no podrá', () => {
  assert.ok(detectProhibition('The Provider shall not disclose confidential information.'));
  assert.ok(detectProhibition('El Proveedor no podrá divulgar la información.'));
});

test('detectDeadline: within N days / by date / dentro de N días', () => {
  assert.match(detectDeadline('Provider shall deliver within 30 days.'), /30/);
  assert.match(detectDeadline('Contractor shall finish by 2026-06-15.'), /2026-06-15/);
  assert.match(detectDeadline('La parte deberá entregar dentro de 15 días.'), /15/);
});

test('detectSubject: pulls the noun phrase before the modal', () => {
  assert.match(detectSubject('Acme Corp shall deliver milestones quarterly.'), /Acme/);
  assert.match(detectSubject('The Contractor must report progress weekly.'), /Contractor/);
});

test('extractObligations: returns labelled obligations', () => {
  const text = `The Provider shall deliver the platform within 30 days. The Provider shall not disclose confidential information. Both Parties agree to act in good faith.`;
  const r = extractObligations(text);
  assert.ok(r.total >= 2);
  assert.ok(r.prohibitions >= 1);
});

test('extractObligations: handles Spanish text', () => {
  const text = `El Contratista deberá entregar el informe antes del 2026-06-15. La Parte A no podrá divulgar la información confidencial.`;
  const r = extractObligations(text);
  assert.ok(r.total >= 2);
  assert.ok(r.prohibitions >= 1);
});

test('dedupes identical obligations', () => {
  const text = 'The Provider shall deliver. The Provider shall deliver. The Provider shall deliver.';
  const r = extractObligations(text);
  assert.equal(r.total, 1);
});

test('buildObligationsForFiles aggregates across files', () => {
  const files = [
    { name: 'contract-a.md', extractedText: 'The Provider shall deliver within 30 days.' },
    { name: 'contract-b.md', extractedText: 'Both Parties must act in good faith.' },
  ];
  const r = buildObligationsForFiles(files);
  assert.equal(r.perFile.length, 2);
  assert.ok(r.aggregate.length >= 2);
});

test('renderObligationsBlock returns markdown when obligations exist', () => {
  const files = [{ name: 'demo.md', extractedText: 'The Provider shall deliver within 30 days.' }];
  const r = buildObligationsForFiles(files);
  const md = renderObligationsBlock(r);
  assert.match(md, /^## DOCUMENT OBLIGATIONS/);
  assert.match(md, /OBLIGATION/);
});

test('renderObligationsBlock empty when nothing found', () => {
  assert.equal(renderObligationsBlock({ perFile: [] }), '');
  assert.equal(renderObligationsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildObligationsForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'Provider shall deliver.' }]);
  assert.equal(r.perFile.length, 1);
});

test('prohibition obligations are tagged separately', () => {
  const text = 'The Provider shall not disclose confidential information.';
  const r = extractObligations(text);
  assert.equal(r.obligations[0].polarity, 'prohibition');
});
