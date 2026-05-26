'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-geo-regions');
const { extractGeoRegions, buildGeoRegionsForFiles, renderGeoRegionsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractGeoRegions('').total, 0);
  assert.equal(extractGeoRegions(null).total, 0);
});

test('detects continent "Europe"', () => {
  const r = extractGeoRegions('Sales in Europe grew 15%.');
  assert.ok(r.entries.some((e) => e.kind === 'continent' && /Europe/.test(e.value)));
});

test('detects "North America"', () => {
  const r = extractGeoRegions('Headquartered in North America.');
  assert.ok(r.entries.some((e) => /North America/i.test(e.value)));
});

test('detects "Latin America" / "LATAM"', () => {
  const r = extractGeoRegions('Office in Latin America. LATAM team grew.');
  assert.ok(r.entries.some((e) => /Latin America/i.test(e.value)));
  assert.ok(r.entries.some((e) => e.value === 'LATAM'));
});

test('detects grouping EMEA', () => {
  const r = extractGeoRegions('EMEA expansion underway.');
  assert.ok(r.entries.some((e) => e.kind === 'grouping' && e.value === 'EMEA'));
});

test('detects grouping APAC', () => {
  const r = extractGeoRegions('APAC pipeline strong.');
  assert.ok(r.entries.some((e) => e.value === 'APAC'));
});

test('detects ISO alpha-3 "USA"', () => {
  const r = extractGeoRegions('Based in USA with offices abroad.');
  assert.ok(r.entries.some((e) => e.kind === 'iso-alpha3' && e.value === 'USA'));
});

test('detects "Germany" country', () => {
  const r = extractGeoRegions('Office in Germany opened in May.');
  assert.ok(r.entries.some((e) => /Germany/.test(e.value)));
});

test('detects Spanish "España"', () => {
  const r = extractGeoRegions('Oficina en España con 30 empleados.');
  assert.ok(r.entries.some((e) => /España/.test(e.value)));
});

test('rejects unknown 3-letter caps', () => {
  const r = extractGeoRegions('Tag XYZ not a country.');
  assert.equal(r.entries.filter((e) => e.value === 'XYZ').length, 0);
});

test('counts byKind', () => {
  const r = extractGeoRegions('Europe and USA, EMEA leads, México grows.');
  assert.ok(r.totals.continent >= 1);
  assert.ok(r.totals.grouping >= 1);
  assert.ok(r.totals['iso-alpha3'] >= 1);
});

test('dedupes identical entries', () => {
  const r = extractGeoRegions('Europe vs Europe comparison.');
  assert.equal(r.entries.filter((e) => /Europe/.test(e.value)).length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `Europe, USA, EMEA, APAC, Germany, France, Italy. `;
  const r = extractGeoRegions(text);
  assert.ok(r.entries.length <= 28);
});

test('buildGeoRegionsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Europe' },
    { name: 'b.md', extractedText: 'APAC' },
  ];
  const r = buildGeoRegionsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderGeoRegionsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Europe' }];
  const r = buildGeoRegionsForFiles(files);
  const md = renderGeoRegionsBlock(r);
  assert.match(md, /^## GEOGRAPHIC REGIONS/);
});

test('renderGeoRegionsBlock empty when nothing surfaces', () => {
  assert.equal(renderGeoRegionsBlock({ perFile: [] }), '');
  assert.equal(renderGeoRegionsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildGeoRegionsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Europe' },
  ]);
  assert.equal(r.perFile.length, 1);
});
