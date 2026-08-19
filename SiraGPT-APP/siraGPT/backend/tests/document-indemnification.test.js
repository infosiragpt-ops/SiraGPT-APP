'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-indemnification');
const { extractIndemnification, buildIndemnificationForFiles, renderIndemnificationBlock, _internal } = engine;
const { classifyKind } = _internal;

test('empty / non-string input tolerated', () => {
  assert.equal(extractIndemnification('').total, 0);
  assert.equal(extractIndemnification(null).total, 0);
});

test('classifyKind: indemnification clause', () => {
  assert.equal(classifyKind('The Provider shall indemnify the Customer.'), 'indemnification');
  assert.equal(classifyKind('Each Party agrees to defend, indemnify, and hold harmless the other.'), 'indemnification');
});

test('classifyKind: Spanish indemnification', () => {
  assert.equal(classifyKind('El Proveedor indemnizará al Cliente.'), 'indemnification');
  assert.equal(classifyKind('La Parte A mantendrá indemne a la Parte B.'), 'indemnification');
});

test('classifyKind: liability cap', () => {
  assert.equal(classifyKind('In no event shall the aggregate liability exceed the fees paid.'), 'liability_cap');
  assert.equal(classifyKind('Limitation of liability applies to all claims.'), 'liability_cap');
});

test('classifyKind: Spanish liability cap', () => {
  assert.equal(classifyKind('La limitación de responsabilidad será del 100% de las tarifas.'), 'liability_cap');
});

test('classifyKind: damages exclusion', () => {
  assert.equal(classifyKind('Neither Party shall be liable for consequential damages.'), 'damages_exclusion');
  assert.equal(classifyKind('No claim for loss of profits or goodwill is allowed.'), 'damages_exclusion');
});

test('classifyKind: Spanish exclusion of damages', () => {
  assert.equal(classifyKind('Se excluye expresamente el lucro cesante y daños indirectos.'), 'damages_exclusion');
});

test('classifyKind: irrelevant sentence returns null', () => {
  assert.equal(classifyKind('The Provider shall deliver the system in 30 days.'), null);
});

test('extractIndemnification returns mixed kinds', () => {
  const text = `The Provider shall indemnify the Customer. In no event shall the aggregate liability exceed the fees paid. Consequential damages are excluded.`;
  const r = extractIndemnification(text);
  const kinds = r.findings.map((f) => f.kind);
  assert.ok(kinds.includes('indemnification'));
  assert.ok(kinds.includes('liability_cap'));
  assert.ok(kinds.includes('damages_exclusion'));
});

test('dedupes identical sentences across kinds', () => {
  const text = 'The Provider shall indemnify the Customer. The Provider shall indemnify the Customer.';
  const r = extractIndemnification(text);
  assert.equal(r.total, 1);
});

test('buildIndemnificationForFiles aggregates across batch', () => {
  const files = [
    { name: 'contract-a.md', extractedText: 'The Provider shall indemnify the Customer.' },
    { name: 'contract-b.md', extractedText: 'In no event shall the aggregate liability exceed the fees paid.' },
  ];
  const r = buildIndemnificationForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderIndemnificationBlock returns markdown when findings exist', () => {
  const files = [{ name: 'demo.md', extractedText: 'The Provider shall indemnify the Customer.' }];
  const r = buildIndemnificationForFiles(files);
  const md = renderIndemnificationBlock(r);
  assert.match(md, /^## INDEMNIFICATION & LIABILITY/);
});

test('renderIndemnificationBlock empty when nothing found', () => {
  assert.equal(renderIndemnificationBlock({ perFile: [] }), '');
  assert.equal(renderIndemnificationBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildIndemnificationForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'X shall indemnify Y.' }]);
  assert.equal(r.perFile.length, 1);
});

test('exclusion takes precedence over cap when both keywords present', () => {
  // "limitation of liability ... loss of profits" → exclusion (which is more
  // specific) per classifyKind order.
  const text = 'Limitation of liability does not include loss of profits or consequential damages.';
  const r = extractIndemnification(text);
  assert.ok(r.findings.some((f) => f.kind === 'damages_exclusion'));
});
