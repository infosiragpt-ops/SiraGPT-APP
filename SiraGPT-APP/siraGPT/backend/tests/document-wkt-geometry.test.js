'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-wkt-geometry');
const { extractWktGeometry, buildWktGeometryForFiles, renderWktGeometryBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractWktGeometry('').total, 0);
  assert.equal(extractWktGeometry(null).total, 0);
});

test('detects POINT', () => {
  const r = extractWktGeometry('Location: POINT(-122.4 37.7)');
  assert.ok(r.entries.some((e) => e.type === 'POINT'));
});

test('detects LINESTRING', () => {
  const r = extractWktGeometry('Route: LINESTRING(0 0, 1 1, 2 2)');
  assert.ok(r.entries.some((e) => e.type === 'LINESTRING'));
});

test('detects POLYGON', () => {
  const r = extractWktGeometry('Area: POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))');
  assert.ok(r.entries.some((e) => e.type === 'POLYGON'));
});

test('detects MULTIPOLYGON', () => {
  const r = extractWktGeometry('MULTIPOLYGON(((0 0, 1 0, 1 1, 0 0)), ((2 2, 3 2, 3 3, 2 2)))');
  assert.ok(r.entries.some((e) => e.type === 'MULTIPOLYGON'));
});

test('detects SRID prefix', () => {
  const r = extractWktGeometry('SRID=4326;POINT(-122.4 37.7)');
  const entry = r.entries.find((e) => e.type === 'POINT');
  assert.equal(entry.srid, '4326');
});

test('detects MULTIPOINT', () => {
  const r = extractWktGeometry('MULTIPOINT(0 0, 1 1, 2 2)');
  assert.ok(r.entries.some((e) => e.type === 'MULTIPOINT'));
});

test('detects GEOMETRYCOLLECTION', () => {
  const r = extractWktGeometry('GEOMETRYCOLLECTION(POINT(0 0), LINESTRING(1 1, 2 2))');
  assert.ok(r.entries.some((e) => e.type === 'GEOMETRYCOLLECTION'));
});

test('counts approximate points', () => {
  const r = extractWktGeometry('LINESTRING(0 0, 1 1, 2 2, 3 3, 4 4)');
  const entry = r.entries.find((e) => e.type === 'LINESTRING');
  assert.ok(entry.pointCount >= 4);
});

test('dedupes identical entries', () => {
  const r = extractWktGeometry('POINT(0 0) and POINT(0 0)');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 18; i++) text += `POINT(${i} ${i}) `;
  const r = extractWktGeometry(text);
  assert.ok(r.entries.length <= 14);
});

test('counts totals by type', () => {
  const r = extractWktGeometry('POINT(0 0) LINESTRING(1 1, 2 2) POLYGON((0 0, 1 0, 1 1, 0 0))');
  assert.ok(r.totals.POINT >= 1);
  assert.ok(r.totals.LINESTRING >= 1);
  assert.ok(r.totals.POLYGON >= 1);
});

test('buildWktGeometryForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'POINT(0 0)' },
    { name: 'b', extractedText: 'LINESTRING(0 0, 1 1)' },
  ];
  const r = buildWktGeometryForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderWktGeometryBlock returns markdown when entries exist', () => {
  const files = [{ name: 'gis', extractedText: 'POINT(0 0)' }];
  const r = buildWktGeometryForFiles(files);
  const md = renderWktGeometryBlock(r);
  assert.match(md, /^## WKT/);
});

test('renderWktGeometryBlock empty when nothing surfaces', () => {
  assert.equal(renderWktGeometryBlock({ perFile: [] }), '');
  assert.equal(renderWktGeometryBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildWktGeometryForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'POINT(0 0)' },
  ]);
  assert.equal(r.perFile.length, 1);
});
