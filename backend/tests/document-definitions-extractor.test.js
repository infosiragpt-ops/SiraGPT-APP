'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-definitions-extractor');
const { extractDefinitions, buildDefinitionsForFiles, renderDefinitionsBlock, _internal } = engine;
const { clean } = _internal;

test('empty / non-string input tolerated', () => {
  assert.equal(extractDefinitions('').total, 0);
  assert.equal(extractDefinitions(null).total, 0);
});

test('clean strips trimming and quotes', () => {
  assert.equal(clean('  "Term".  '), 'Term');
});

test('detects "X means Y" English form', () => {
  const text = '"Service" means the cloud-based platform provided by the Provider.';
  const r = extractDefinitions(text);
  assert.ok(r.definitions.some((d) => /Service/i.test(d.term) && /cloud-based platform/i.test(d.definition)));
});

test('detects "X shall mean Y" English form', () => {
  const text = 'For the purposes of this Agreement, "Confidential Information" shall mean any non-public business or technical information disclosed by one Party to the other.';
  const r = extractDefinitions(text);
  assert.ok(r.definitions.some((d) => /Confidential Information/i.test(d.term)));
});

test('detects "X se define como Y" Spanish form', () => {
  const text = '"Servicio" se define como la plataforma de software entregada por el Proveedor.';
  const r = extractDefinitions(text);
  assert.ok(r.definitions.some((d) => /Servicio/.test(d.term)));
});

test('detects "Por X se entenderá Y" Spanish form', () => {
  const text = 'Por "Información Confidencial" se entenderá toda información de negocio o técnica no pública entregada por una Parte a la otra.';
  const r = extractDefinitions(text);
  assert.ok(r.definitions.some((d) => /Confidencial/.test(d.term)));
});

test('dedupes identical term + definition pairs', () => {
  const text = '"Service" means the platform. "Service" means the platform. "Service" means the platform.';
  const r = extractDefinitions(text);
  assert.equal(r.definitions.length, 1);
});

test('caps total definitions per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) {
    text += `"Term${i}" means the test definition value number ${i}. `;
  }
  const r = extractDefinitions(text);
  assert.ok(r.definitions.length <= 16);
});

test('buildDefinitionsForFiles aggregates and tags by file', () => {
  const files = [
    { name: 'agreement.md', extractedText: '"Service" means the platform.' },
    { name: 'glossary.md', extractedText: '"User" means an authorised end-customer.' },
  ];
  const r = buildDefinitionsForFiles(files);
  assert.equal(r.perFile.length, 2);
  assert.ok(r.aggregate.some((d) => d.file === 'agreement.md'));
});

test('renderDefinitionsBlock returns markdown when definitions exist', () => {
  const files = [{ name: 'doc.md', extractedText: '"Service" means the cloud platform.' }];
  const r = buildDefinitionsForFiles(files);
  const md = renderDefinitionsBlock(r);
  assert.match(md, /^## DOCUMENT DEFINITIONS/);
});

test('renderDefinitionsBlock empty when nothing extracted', () => {
  assert.equal(renderDefinitionsBlock({ perFile: [] }), '');
  assert.equal(renderDefinitionsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildDefinitionsForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: '"X" means y.' }]);
  assert.ok(Array.isArray(r.perFile));
});

test('source sentence is preserved for citation', () => {
  const text = '"Term" means the value defined elsewhere.';
  const r = extractDefinitions(text);
  assert.ok(r.definitions[0].sentence.length > 0);
});

test('term length is clipped to safe maximum', () => {
  const longTerm = 'A'.repeat(120);
  const r = extractDefinitions(`"${longTerm}" means a value.`);
  // The pattern requires {1,79} so terms over 79 are not captured at all
  // (which is the safest behaviour). Verify no rogue capture.
  assert.equal(r.definitions.length, 0);
});
