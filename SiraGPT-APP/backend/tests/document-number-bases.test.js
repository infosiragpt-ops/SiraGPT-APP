'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-number-bases');
const { extractNumberBases, buildNumberBasesForFiles, renderNumberBasesBlock, _internal } = engine;
const { valueOf } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractNumberBases('').total, 0);
  assert.equal(extractNumberBases(null).total, 0);
});

test('valueOf converts each base', () => {
  assert.equal(valueOf('0xff'), 255);
  assert.equal(valueOf('0b1010'), 10);
  assert.equal(valueOf('0o755'), 493);
  assert.equal(valueOf('0755'), 493);
});

test('detects hex literal', () => {
  const r = extractNumberBases('Color value 0xFF8800');
  assert.ok(r.entries.some((e) => e.base === 'hex'));
});

test('detects binary literal', () => {
  const r = extractNumberBases('Mask 0b10101010');
  assert.ok(r.entries.some((e) => e.base === 'binary'));
});

test('detects octal literal 0o755', () => {
  const r = extractNumberBases('Mode 0o755');
  assert.ok(r.entries.some((e) => e.base === 'octal'));
});

test('detects legacy octal 0755', () => {
  const r = extractNumberBases('mode = 0755');
  assert.ok(r.entries.some((e) => e.base === 'octal-legacy'));
});

test('detects exponential notation', () => {
  const r = extractNumberBases('Speed: 3e8 m/s');
  assert.ok(r.entries.some((e) => e.base === 'exp'));
});

test('captures value', () => {
  const r = extractNumberBases('0xff');
  assert.equal(r.entries[0].value, 255);
});

test('rejects too-short legacy octals', () => {
  const r = extractNumberBases('01 and 02 only');
  assert.equal(r.entries.filter((e) => e.base === 'octal-legacy').length, 0);
});

test('dedupes identical literals', () => {
  const r = extractNumberBases('0xFF and 0xFF');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `0x${i.toString(16).padStart(4, '0')} `;
  const r = extractNumberBases(text);
  assert.ok(r.entries.length <= 20);
});

test('counts totals by base', () => {
  const r = extractNumberBases('0xFF and 0b101 and 0o755 and 3e8');
  assert.ok(r.totals.hex >= 1);
  assert.ok(r.totals.binary >= 1);
  assert.ok(r.totals.octal >= 1);
  assert.ok(r.totals.exp >= 1);
});

test('buildNumberBasesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: '0xFF' },
    { name: 'b', extractedText: '0b101' },
  ];
  const r = buildNumberBasesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderNumberBasesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'code', extractedText: '0xFF' }];
  const r = buildNumberBasesForFiles(files);
  const md = renderNumberBasesBlock(r);
  assert.match(md, /^## NUMBER/);
});

test('renderNumberBasesBlock empty when nothing surfaces', () => {
  assert.equal(renderNumberBasesBlock({ perFile: [] }), '');
  assert.equal(renderNumberBasesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildNumberBasesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '0xFF' },
  ]);
  assert.equal(r.perFile.length, 1);
});
