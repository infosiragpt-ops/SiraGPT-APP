'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-hardware-specs');
const { extractHardwareSpecs, buildHardwareSpecsForFiles, renderHardwareSpecsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractHardwareSpecs('').total, 0);
  assert.equal(extractHardwareSpecs(null).total, 0);
});

test('detects "8 cores"', () => {
  const r = extractHardwareSpecs('Server has 8 cores');
  assert.ok(r.entries.some((e) => e.kind === 'cores' && /8/.test(e.value)));
});

test('detects vCPUs', () => {
  const r = extractHardwareSpecs('4 vCPUs allocated');
  assert.ok(r.entries.some((e) => e.kind === 'cores'));
});

test('detects Intel Xeon brand', () => {
  const r = extractHardwareSpecs('Powered by Intel Xeon E5-2690');
  assert.ok(r.entries.some((e) => e.kind === 'cpu' && /Intel\s+Xeon/.test(e.value)));
});

test('detects AMD EPYC brand', () => {
  const r = extractHardwareSpecs('AMD EPYC 7763 processor');
  assert.ok(r.entries.some((e) => e.kind === 'cpu' && /AMD\s+EPYC/.test(e.value)));
});

test('detects Apple M3 Pro', () => {
  const r = extractHardwareSpecs('M3 Pro chip Apple M3 Pro');
  assert.ok(r.entries.some((e) => e.kind === 'cpu' && /M3\s+Pro/.test(e.value)));
});

test('detects 16GB RAM', () => {
  const r = extractHardwareSpecs('16GB DDR5 RAM');
  assert.ok(r.entries.some((e) => e.kind === 'ram'));
});

test('detects 256GB SSD', () => {
  const r = extractHardwareSpecs('256GB SSD storage');
  assert.ok(r.entries.some((e) => e.kind === 'storage'));
});

test('detects 1TB NVMe', () => {
  const r = extractHardwareSpecs('1TB NVMe drive');
  assert.ok(r.entries.some((e) => e.kind === 'storage'));
});

test('detects NVIDIA A100 GPU', () => {
  const r = extractHardwareSpecs('Trained on NVIDIA A100 GPUs');
  assert.ok(r.entries.some((e) => e.kind === 'gpu'));
});

test('detects 10Gbps network', () => {
  const r = extractHardwareSpecs('10Gbps NIC connected');
  assert.ok(r.entries.some((e) => e.kind === 'network'));
});

test('detects x86_64 arch', () => {
  const r = extractHardwareSpecs('Built for x86_64 platform');
  assert.ok(r.entries.some((e) => e.kind === 'arch' && /x86/.test(e.normalised)));
});

test('detects arm64 arch', () => {
  const r = extractHardwareSpecs('arm64 build available');
  assert.ok(r.entries.some((e) => e.kind === 'arch' && e.normalised === 'arm64'));
});

test('dedupes identical entries', () => {
  const r = extractHardwareSpecs('16GB RAM and 16GB RAM');
  assert.equal(r.entries.filter((e) => e.kind === 'ram').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 1; i <= 25; i++) text += `${i}GB RAM `;
  const r = extractHardwareSpecs(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by kind', () => {
  const r = extractHardwareSpecs('8 cores, 16GB RAM, 256GB SSD, NVIDIA A100, x86_64');
  assert.ok(r.totals.cores >= 1);
  assert.ok(r.totals.ram >= 1);
  assert.ok(r.totals.storage >= 1);
  assert.ok(r.totals.gpu >= 1);
  assert.ok(r.totals.arch >= 1);
});

test('buildHardwareSpecsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: '16GB RAM' },
    { name: 'b', extractedText: '256GB SSD' },
  ];
  const r = buildHardwareSpecsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderHardwareSpecsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'spec', extractedText: '16GB RAM' }];
  const r = buildHardwareSpecsForFiles(files);
  const md = renderHardwareSpecsBlock(r);
  assert.match(md, /^## HARDWARE/);
});

test('renderHardwareSpecsBlock empty when nothing surfaces', () => {
  assert.equal(renderHardwareSpecsBlock({ perFile: [] }), '');
  assert.equal(renderHardwareSpecsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildHardwareSpecsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '16GB RAM' },
  ]);
  assert.equal(r.perFile.length, 1);
});
