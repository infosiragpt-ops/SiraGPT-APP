'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-boolean');
const { extractBooleans, buildBooleansForFiles, renderBooleansBlock, _internal } = engine;
const { normaliseBool, glyphToBool } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractBooleans('').total, 0);
  assert.equal(extractBooleans(null).total, 0);
});

test('normaliseBool: yes/no/true/false', () => {
  assert.equal(normaliseBool('yes'), true);
  assert.equal(normaliseBool('No'), false);
  assert.equal(normaliseBool('true'), true);
  assert.equal(normaliseBool('false'), false);
  assert.equal(normaliseBool('sí'), true);
});

test('glyphToBool: ✓ / ✗', () => {
  assert.equal(glyphToBool('✓'), true);
  assert.equal(glyphToBool('✗'), false);
  assert.equal(glyphToBool('☑'), true);
});

test('detects "Enabled: yes"', () => {
  const r = extractBooleans('Enabled: yes\nFooter.');
  assert.ok(r.entries.some((e) => e.value === true));
});

test('detects "Logging: false"', () => {
  const r = extractBooleans('Logging: false');
  assert.ok(r.entries.some((e) => e.value === false));
});

test('detects Spanish "Activo: Sí"', () => {
  const r = extractBooleans('Activo: Sí');
  assert.ok(r.entries.some((e) => e.value === true));
});

test('detects ✓ glyph line', () => {
  const r = extractBooleans('✓ Feature implemented');
  assert.ok(r.entries.some((e) => e.value === true && /Feature/.test(e.key)));
});

test('detects ✗ glyph line', () => {
  const r = extractBooleans('✗ Bug fixed');
  assert.ok(r.entries.some((e) => e.value === false));
});

test('counts totals', () => {
  const r = extractBooleans('Enabled: yes\nLogging: no\n✓ Done\n✗ Broken');
  assert.ok(r.totals.true >= 2);
  assert.ok(r.totals.false >= 2);
});

test('dedupes identical entries', () => {
  const r = extractBooleans('Active: yes\nActive: yes');
  assert.equal(r.entries.filter((e) => /Active/i.test(e.key) && e.value === true).length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 40; i++) text += `Flag${i}: yes\n`;
  const r = extractBooleans(text);
  assert.ok(r.entries.length <= 24);
});

test('ignores "if X:" conditional', () => {
  const r = extractBooleans('if Enabled: yes\nthen do');
  // Our pattern would skip "if Enabled" prefix
  assert.equal(r.entries.filter((e) => /^if/i.test(e.key)).length, 0);
});

test('buildBooleansForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Active: yes' },
    { name: 'b.md', extractedText: 'Logging: false' },
  ];
  const r = buildBooleansForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderBooleansBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Active: yes' }];
  const r = buildBooleansForFiles(files);
  const md = renderBooleansBlock(r);
  assert.match(md, /^## BOOLEAN ANSWERS/);
});

test('renderBooleansBlock empty when nothing surfaces', () => {
  assert.equal(renderBooleansBlock({ perFile: [] }), '');
  assert.equal(renderBooleansBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildBooleansForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Active: yes' },
  ]);
  assert.equal(r.perFile.length, 1);
});
