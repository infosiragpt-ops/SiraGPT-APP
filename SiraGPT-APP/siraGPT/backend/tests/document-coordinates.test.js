'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-coordinates');
const { extractCoordinates, buildCoordinatesForFiles, renderCoordinatesBlock, _internal } = engine;
const { isLikelyLatLng } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractCoordinates('').total, 0);
  assert.equal(extractCoordinates(null).total, 0);
});

test('isLikelyLatLng: valid ranges', () => {
  assert.equal(isLikelyLatLng(40.7128, -74.0060), true);
  assert.equal(isLikelyLatLng(91, 0), false);
  assert.equal(isLikelyLatLng(0, 181), false);
  assert.equal(isLikelyLatLng(0, 0), false); // rejected as common false positive
});

test('detects decimal lat,lng', () => {
  const r = extractCoordinates('NYC at 40.7128, -74.0060 is open.');
  assert.ok(r.coords.some((c) => c.kind === 'decimal' && /40\.7128/.test(c.value)));
});

test('detects labeled lat / lng', () => {
  const r = extractCoordinates('Location: lat: 40.7128, lng: -74.0060');
  assert.ok(r.coords.some((c) => c.kind === 'decimal'));
});

test('detects labeled lat / longitude', () => {
  const r = extractCoordinates('latitude: 51.5, longitude: -0.1');
  assert.ok(r.coords.some((c) => c.kind === 'decimal'));
});

test('detects DMS notation', () => {
  const r = extractCoordinates('Statue at 40°42\'46"N 74°00\'21"W');
  assert.ok(r.coords.some((c) => c.kind === 'dms'));
});

test('detects Open Location Plus code', () => {
  const r = extractCoordinates('Code: 87G7M2QV+CV is the building.');
  assert.ok(r.coords.some((c) => c.kind === 'plus'));
});

test('rejects integer-only "lat,lng" as too imprecise', () => {
  const r = extractCoordinates('Point 5, 10 in the chart.');
  // Both integers, no decimals → rejected
  assert.equal(r.coords.filter((c) => c.kind === 'decimal').length, 0);
});

test('rejects out-of-range latitudes', () => {
  const r = extractCoordinates('Tag 95.5, -74.0060 — out of range.');
  assert.equal(r.coords.length, 0);
});

test('rejects out-of-range longitudes', () => {
  const r = extractCoordinates('Tag 40.7, -200.5 — out of range.');
  assert.equal(r.coords.length, 0);
});

test('rejects 0,0 as false positive', () => {
  const r = extractCoordinates('Origin at 0.0, 0.0 reset.');
  assert.equal(r.coords.length, 0);
});

test('dedupes identical coordinates', () => {
  const r = extractCoordinates('At 40.7128, -74.0060 here and 40.7128, -74.0060 again.');
  assert.equal(r.coords.length, 1);
});

test('caps coordinates per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `Point ${i}.${i}, -${i}.${i} done. `;
  const r = extractCoordinates(text);
  assert.ok(r.coords.length <= 16);
});

test('buildCoordinatesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '40.7128, -74.0060' },
    { name: 'b.md', extractedText: '51.5074, -0.1278' },
  ];
  const r = buildCoordinatesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCoordinatesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: '40.7128, -74.0060' }];
  const r = buildCoordinatesForFiles(files);
  const md = renderCoordinatesBlock(r);
  assert.match(md, /^## GEOGRAPHIC COORDINATES/);
});

test('renderCoordinatesBlock empty when nothing surfaces', () => {
  assert.equal(renderCoordinatesBlock({ perFile: [] }), '');
  assert.equal(renderCoordinatesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildCoordinatesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '40.7128, -74.0060' },
  ]);
  assert.equal(r.perFile.length, 1);
});
