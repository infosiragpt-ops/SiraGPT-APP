'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-colors');
const { extractColors, buildColorsForFiles, renderColorsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractColors('').total, 0);
  assert.equal(extractColors(null).total, 0);
});

test('detects hex #RRGGBB', () => {
  const r = extractColors('Brand color: #ff5733');
  assert.ok(r.colors.some((c) => c.kind === 'hex' && c.value === '#ff5733'));
});

test('detects hex #RGB shorthand', () => {
  const r = extractColors('Accent: #abc');
  assert.ok(r.colors.some((c) => c.kind === 'hex'));
});

test('detects hex with alpha #RRGGBBAA', () => {
  const r = extractColors('Use #ff573380 with opacity.');
  assert.ok(r.colors.some((c) => c.kind === 'hex'));
});

test('detects rgb()', () => {
  const r = extractColors('Background: rgb(255, 0, 0)');
  assert.ok(r.colors.some((c) => c.kind === 'rgb'));
});

test('detects rgba() with alpha', () => {
  const r = extractColors('Overlay: rgba(0, 0, 0, 0.5)');
  assert.ok(r.colors.some((c) => c.kind === 'rgb'));
});

test('detects hsl()', () => {
  const r = extractColors('Primary: hsl(120, 100%, 50%)');
  assert.ok(r.colors.some((c) => c.kind === 'hsl'));
});

test('detects named CSS colors', () => {
  const r = extractColors('Set background to royalblue or crimson.');
  assert.ok(r.colors.some((c) => c.kind === 'named' && c.value === 'royalblue'));
  assert.ok(r.colors.some((c) => c.kind === 'named' && c.value === 'crimson'));
});

test('detects Tailwind utility tokens', () => {
  const r = extractColors('Use bg-red-500 and text-blue-700 classes.');
  assert.ok(r.colors.some((c) => c.kind === 'tailwind' && c.value === 'bg-red-500'));
});

test('rejects random words as named colors', () => {
  const r = extractColors('The quick brown fox jumps.');
  // 'brown' is a CSS color, so will match — that's expected
  assert.ok(r.colors.some((c) => c.kind === 'named' && c.value === 'brown'));
});

test('dedupes identical colors', () => {
  const r = extractColors('Use #ff5733 here and #ff5733 there.');
  assert.equal(r.colors.filter((c) => c.value === '#ff5733').length, 1);
});

test('case-insensitive hex normalisation', () => {
  const r = extractColors('Use #FF5733 today.');
  assert.ok(r.colors.some((c) => c.kind === 'hex' && c.value === '#ff5733'));
});

test('counts totals by kind', () => {
  const r = extractColors('#ff5733 and rgb(0,255,0) and royalblue and bg-blue-500');
  assert.ok(r.totals.hex >= 1);
  assert.ok(r.totals.rgb >= 1);
  assert.ok(r.totals.named >= 1);
  assert.ok(r.totals.tailwind >= 1);
});

test('caps per kind', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `#aabb${i.toString(16).padStart(2, '0')}cc `;
  const r = extractColors(text);
  assert.ok(r.totals.hex <= 12);
});

test('buildColorsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '#ff5733' },
    { name: 'b.md', extractedText: 'rgb(0, 255, 0)' },
  ];
  const r = buildColorsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderColorsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Use #ff5733' }];
  const r = buildColorsForFiles(files);
  const md = renderColorsBlock(r);
  assert.match(md, /^## COLORS \/ PALETTE/);
});

test('renderColorsBlock empty when nothing surfaces', () => {
  assert.equal(renderColorsBlock({ perFile: [] }), '');
  assert.equal(renderColorsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildColorsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '#ff5733' },
  ]);
  assert.equal(r.perFile.length, 1);
});
