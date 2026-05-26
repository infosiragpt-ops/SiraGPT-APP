'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-license-plates');
const { extractLicensePlates, buildLicensePlatesForFiles, renderLicensePlatesBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractLicensePlates('').total, 0);
  assert.equal(extractLicensePlates(null).total, 0);
});

test('detects US format ABC-1234', () => {
  const r = extractLicensePlates('Plate ABC-1234 spotted.');
  assert.ok(r.entries.some((e) => e.kind === 'us'));
});

test('detects UK format AB12 CDE', () => {
  const r = extractLicensePlates('Vehicle AB12 CDE registered.');
  assert.ok(r.entries.some((e) => e.kind === 'uk'));
});

test('detects Mexico ABC-123-D', () => {
  const r = extractLicensePlates('Placa XYZ-123-A circulando.');
  assert.ok(r.entries.some((e) => e.kind === 'mx'));
});

test('detects Spain 1234 BCD', () => {
  const r = extractLicensePlates('Matrícula 1234 BCD inscrita.');
  assert.ok(r.entries.some((e) => e.kind === 'es'));
});

test('detects labeled "license plate"', () => {
  const r = extractLicensePlates('license plate: ABC1234');
  assert.ok(r.entries.some((e) => e.kind === 'labeled'));
});

test('detects Spanish "placa"', () => {
  const r = extractLicensePlates('Placa: XYZ-789-B');
  assert.ok(r.entries.some((e) => e.kind === 'labeled'));
});

test('dedupes identical plates', () => {
  const r = extractLicensePlates('Plate ABC-1234 here. ABC-1234 again.');
  assert.ok(r.entries.filter((e) => /ABC.1234/.test(e.plate)).length <= 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 100; i < 130; i++) text += `Plate ABC-${i}5 spotted. `;
  const r = extractLicensePlates(text);
  assert.ok(r.entries.length <= 14);
});

test('buildLicensePlatesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'ABC-1234' },
    { name: 'b.md', extractedText: 'AB12 CDE' },
  ];
  const r = buildLicensePlatesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderLicensePlatesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'ABC-1234' }];
  const r = buildLicensePlatesForFiles(files);
  const md = renderLicensePlatesBlock(r);
  assert.match(md, /^## VEHICLE LICENSE PLATES/);
});

test('renderLicensePlatesBlock empty when nothing surfaces', () => {
  assert.equal(renderLicensePlatesBlock({ perFile: [] }), '');
  assert.equal(renderLicensePlatesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildLicensePlatesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'ABC-1234' },
  ]);
  assert.equal(r.perFile.length, 1);
});
