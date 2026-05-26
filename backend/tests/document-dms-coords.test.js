'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-dms-coords');
const { extractDmsCoords, buildDmsCoordsForFiles, renderDmsCoordsBlock, _internal } = engine;
const { dmsToDecimal } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractDmsCoords('').total, 0);
  assert.equal(extractDmsCoords(null).total, 0);
});

test('dmsToDecimal: 40°26\'46"N ≈ 40.446°', () => {
  assert.ok(Math.abs(dmsToDecimal('40', '26', '46', 'N') - 40.446) < 0.01);
});

test('dmsToDecimal: 79°58\'56"W → negative', () => {
  assert.ok(dmsToDecimal('79', '58', '56', 'W') < 0);
});

test('detects DMS coordinate', () => {
  const r = extractDmsCoords('Eiffel Tower at 48°51\'30"N 2°17\'40"E');
  assert.ok(r.entries.some((e) => e.kind === 'dms'));
});

test('captures decimal conversion', () => {
  const r = extractDmsCoords('40°26\'46"N 79°58\'56"W');
  const entry = r.entries.find((e) => e.hemi === 'N');
  assert.ok(entry);
  assert.ok(/^40\./.test(entry.decimal));
});

test('detects DDM (degrees-decimal-minutes)', () => {
  const r = extractDmsCoords('40°26.766\'N 79°58.933\'W');
  assert.ok(r.entries.some((e) => e.kind === 'ddm'));
});

test('detects UTM coordinate', () => {
  const r = extractDmsCoords('18T 585628E 4477700N');
  assert.ok(r.entries.some((e) => e.kind === 'utm'));
});

test('UTM has zone', () => {
  const r = extractDmsCoords('18T 585628E 4477700N');
  const entry = r.entries.find((e) => e.kind === 'utm');
  assert.equal(entry.zone, '18T');
});

test('detects MGRS', () => {
  const r = extractDmsCoords('Location 18TWL850777 on the map');
  assert.ok(r.entries.some((e) => e.kind === 'mgrs'));
});

test('dedupes identical coordinates', () => {
  const r = extractDmsCoords('40°26\'46"N and 40°26\'46"N');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `${30 + i}°10'00"N `;
  const r = extractDmsCoords(text);
  assert.ok(r.entries.length <= 14);
});

test('counts totals by kind', () => {
  const r = extractDmsCoords('40°26\'46"N and 40°26.766\'N and 18T 585628E 4477700N');
  assert.ok(r.totals.dms >= 1);
  assert.ok(r.totals.ddm >= 1);
  assert.ok(r.totals.utm >= 1);
});

test('buildDmsCoordsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: '40°26\'46"N' },
    { name: 'b', extractedText: '79°58\'56"W' },
  ];
  const r = buildDmsCoordsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderDmsCoordsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'map', extractedText: '40°26\'46"N' }];
  const r = buildDmsCoordsForFiles(files);
  const md = renderDmsCoordsBlock(r);
  assert.match(md, /^## DMS/);
});

test('renderDmsCoordsBlock empty when nothing surfaces', () => {
  assert.equal(renderDmsCoordsBlock({ perFile: [] }), '');
  assert.equal(renderDmsCoordsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildDmsCoordsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '40°26\'46"N' },
  ]);
  assert.equal(r.perFile.length, 1);
});
