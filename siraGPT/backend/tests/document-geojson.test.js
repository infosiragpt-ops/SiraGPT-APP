'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-geojson');
const { extractGeojson, buildGeojsonForFiles, renderGeojsonBlock, _internal } = engine;
const { classifyType } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractGeojson('').total, 0);
  assert.equal(extractGeojson(null).total, 0);
});

test('classifyType: feature vs geometry', () => {
  assert.equal(classifyType('Feature'), 'feature');
  assert.equal(classifyType('Point'), 'geometry');
  assert.equal(classifyType('MultiPolygon'), 'multi-geometry');
  assert.equal(classifyType('GeometryCollection'), 'collection');
});

test('detects Feature type', () => {
  const r = extractGeojson('{"type": "Feature", "geometry": {}}');
  assert.ok(r.entries.some((e) => e.value === 'Feature'));
});

test('detects FeatureCollection', () => {
  const r = extractGeojson('{"type": "FeatureCollection", "features": []}');
  assert.ok(r.entries.some((e) => e.value === 'FeatureCollection'));
});

test('detects Point geometry', () => {
  const r = extractGeojson('"type": "Point", "coordinates": [0, 0]');
  assert.ok(r.entries.some((e) => e.value === 'Point'));
});

test('detects Polygon geometry', () => {
  const r = extractGeojson('"type": "Polygon", "coordinates": [[[0,0],[1,0],[1,1],[0,0]]]');
  assert.ok(r.entries.some((e) => e.value === 'Polygon'));
});

test('detects MultiPolygon', () => {
  const r = extractGeojson('"type": "MultiPolygon"');
  assert.ok(r.entries.some((e) => e.family === 'multi-geometry'));
});

test('counts coordinates arrays', () => {
  const r = extractGeojson('"coordinates": [0, 0], "coordinates": [[1, 1]]');
  assert.ok(r.totals.coordinates >= 2);
});

test('counts properties objects', () => {
  const r = extractGeojson('"properties": {"a": 1}, "properties": {"b": 2}');
  assert.ok(r.totals.properties >= 2);
});

test('counts bbox arrays', () => {
  const r = extractGeojson('"bbox": [-180, -90, 180, 90]');
  assert.ok(r.totals.bbox >= 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += '"type": "Point",';
  const r = extractGeojson(text);
  assert.ok(r.entries.length <= 14);
});

test('counts totals by family', () => {
  const r = extractGeojson(
    '"type": "Feature" "type": "Point" "type": "MultiPolygon" "type": "GeometryCollection"'
  );
  assert.ok(r.totals.feature >= 1);
  assert.ok(r.totals.geometry >= 1);
  assert.ok(r.totals['multi-geometry'] >= 1);
  assert.ok(r.totals.collection >= 1);
});

test('buildGeojsonForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.geojson', extractedText: '{"type": "Feature"}' },
    { name: 'b.geojson', extractedText: '{"type": "Point"}' },
  ];
  const r = buildGeojsonForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderGeojsonBlock returns markdown when entries exist', () => {
  const files = [{ name: 'map.geojson', extractedText: '{"type": "Feature"}' }];
  const r = buildGeojsonForFiles(files);
  const md = renderGeojsonBlock(r);
  assert.match(md, /^## GEOJSON/);
});

test('renderGeojsonBlock empty when nothing surfaces', () => {
  assert.equal(renderGeojsonBlock({ perFile: [] }), '');
  assert.equal(renderGeojsonBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildGeojsonForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '{"type": "Feature"}' },
  ]);
  assert.equal(r.perFile.length, 1);
});
