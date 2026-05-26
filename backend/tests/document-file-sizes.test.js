'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-file-sizes');
const { extractFileSizes, buildFileSizesForFiles, renderFileSizesBlock, _internal } = engine;
const { normaliseUnit, unitFamily, isBinary } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractFileSizes('').total, 0);
  assert.equal(extractFileSizes(null).total, 0);
});

test('normaliseUnit: bytes → B, bits → b', () => {
  assert.equal(normaliseUnit('bytes'), 'B');
  assert.equal(normaliseUnit('bits'), 'b');
  assert.equal(normaliseUnit('GB'), 'GB');
  assert.equal(normaliseUnit('MiB'), 'MiB');
});

test('unitFamily classification', () => {
  assert.equal(unitFamily('GB'), 'bytes');
  assert.equal(unitFamily('GiB'), 'bytes');
  assert.equal(unitFamily('Mbit'), 'bits');
  assert.equal(unitFamily('Mbps'), 'bandwidth');
});

test('isBinary detects IEC units', () => {
  assert.equal(isBinary('GiB'), true);
  assert.equal(isBinary('GB'), false);
  assert.equal(isBinary('Mibit'), true);
});

test('detects 1.5 GB', () => {
  const r = extractFileSizes('Backup is 1.5 GB total.');
  assert.ok(r.sizes.some((s) => s.value === '1.5' && s.unit === 'GB'));
});

test('detects 500MB no space', () => {
  const r = extractFileSizes('Limit 500MB per file.');
  assert.ok(r.sizes.some((s) => s.unit === 'MB'));
});

test('detects IEC 2.3 TiB', () => {
  const r = extractFileSizes('Capacity: 2.3 TiB');
  assert.ok(r.sizes.some((s) => s.unit === 'TiB' && s.binary));
});

test('detects bandwidth Mbps', () => {
  const r = extractFileSizes('Throughput: 100 Mbps minimum.');
  assert.ok(r.sizes.some((s) => s.family === 'bandwidth'));
});

test('detects bytes spelled out', () => {
  const r = extractFileSizes('Each record is 256 bytes.');
  assert.ok(r.sizes.some((s) => s.unit === 'B' && s.family === 'bytes'));
});

test('dedupes identical values', () => {
  const r = extractFileSizes('Backup 1.5 GB and again 1.5 GB.');
  assert.equal(r.sizes.filter((s) => s.value === '1.5' && s.unit === 'GB').length, 1);
});

test('caps sizes per file', () => {
  let text = '';
  for (let i = 0; i < 40; i++) text += `${i} MB capacity. `;
  const r = extractFileSizes(text);
  assert.ok(r.sizes.length <= 24);
});

test('counts totals by family', () => {
  const r = extractFileSizes('1 GB and 500 Mbps and 64 bits');
  assert.ok(r.totals.bytes >= 1);
  assert.ok(r.totals.bandwidth >= 1);
  assert.ok(r.totals.bits >= 1);
});

test('rejects bare digits without unit', () => {
  const r = extractFileSizes('Count: 5 items.');
  assert.equal(r.sizes.length, 0);
});

test('buildFileSizesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '1.5 GB' },
    { name: 'b.md', extractedText: '500 MB' },
  ];
  const r = buildFileSizesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderFileSizesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: '1.5 GB' }];
  const r = buildFileSizesForFiles(files);
  const md = renderFileSizesBlock(r);
  assert.match(md, /^## FILE \/ DATA SIZES/);
});

test('renderFileSizesBlock empty when nothing surfaces', () => {
  assert.equal(renderFileSizesBlock({ perFile: [] }), '');
  assert.equal(renderFileSizesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildFileSizesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '1 GB' },
  ]);
  assert.equal(r.perFile.length, 1);
});

test('marks binary IEC units explicitly', () => {
  const r = extractFileSizes('Memory: 4 GiB allocated.');
  assert.ok(r.sizes.some((s) => s.binary === true));
});
