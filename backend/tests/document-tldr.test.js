'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-tldr');
const { buildTldrForFile, buildTldrForFiles, renderTldrBlock, _internal } = engine;
const { splitSentences, salience, rankSentencesBySalience } = _internal;

test('empty / non-string input returns empty bullets', () => {
  assert.deepEqual(buildTldrForFile('').bullets, []);
  assert.deepEqual(buildTldrForFile(null).bullets, []);
});

test('splitSentences keeps sentence boundaries', () => {
  const out = splitSentences('First sentence. Second sentence! Third one?');
  assert.ok(out.length >= 2);
});

test('salience scores higher with numbers / entities / dates', () => {
  const rich = 'Acme Corp grew 32% to $4.2M in Q1 2026.';
  const plain = 'The team had a meeting yesterday.';
  assert.ok(salience(rich, 0, 10) > salience(plain, 0, 10));
});

test('salience decays with position (later sentences score lower)', () => {
  const s = 'Acme Corp grew 32% in Q1 2026.';
  assert.ok(salience(s, 0, 100) > salience(s, 90, 100));
});

test('rankSentencesBySalience orders descending', () => {
  const sentences = [
    'A meeting was held yesterday.',
    'Acme Corp grew 32% to $4.2M in Q1 2026.',
    'Team had lunch.',
  ];
  const ranked = rankSentencesBySalience(sentences);
  assert.match(ranked[0].sentence, /Acme/);
});

test('buildTldrForFile returns up to 3 verbatim bullets', () => {
  const text = `Acme Corp grew 32% to $4.2M in Q1 2026.
The board approved the budget allocation for the next fiscal year.
There is a significant risk of delay in the supply chain.`;
  const r = buildTldrForFile(text);
  assert.ok(r.bullets.length >= 2);
  assert.ok(r.bullets.length <= 3);
  for (const b of r.bullets) {
    assert.ok(typeof b.kind === 'string');
    assert.ok(typeof b.sentence === 'string');
  }
});

test('buildTldrForFile dedupes identical sentences across kinds', () => {
  const text = 'Acme Corp grew 32%. Acme Corp grew 32%. Acme Corp grew 32%.';
  const r = buildTldrForFile(text);
  const keys = new Set(r.bullets.map((b) => b.sentence.toLowerCase().slice(0, 30)));
  assert.equal(r.bullets.length, keys.size);
});

test('buildTldrForFiles aggregates across files', () => {
  const files = [
    { name: 'a.md', extractedText: 'Acme Corp grew 32% to $4.2M in Q1 2026. Board approved budget.' },
    { name: 'b.md', extractedText: 'Globex announced a new product. The team must deliver by Q4.' },
  ];
  const r = buildTldrForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderTldrBlock outputs markdown when bullets exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Acme Corp grew 32% to $4.2M in Q1 2026. Board approved budget.' }];
  const r = buildTldrForFiles(files);
  const md = renderTldrBlock(r);
  assert.match(md, /^## TL;DR/);
  assert.match(md, /Acme Corp/);
});

test('renderTldrBlock empty when no bullets', () => {
  assert.equal(renderTldrBlock({ perFile: [] }), '');
  assert.equal(renderTldrBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildTldrForFiles([{ name: 'noisy', extractedText: null }, { name: 'ok', extractedText: 'Acme Corp grew 32%.' }]);
  assert.equal(r.perFile.length, 1);
});

test('bullets are clipped to safe max length', () => {
  const long = 'A long sentence '.repeat(60);
  const r = buildTldrForFile(`${long}. Plus a short one. Done.`);
  for (const b of r.bullets) {
    assert.ok(b.sentence.length <= 261);
  }
});

test('each bullet carries a known kind tag', () => {
  const text = `Acme Corp grew 32% to $4.2M in Q1 2026. The board approved the migration plan. We must deliver the dashboard by Q4.`;
  const r = buildTldrForFile(text);
  const known = new Set(['salient', 'claim', 'action', 'decision', 'risk', 'open-question']);
  for (const b of r.bullets) {
    assert.ok(known.has(b.kind), `unknown kind: ${b.kind}`);
  }
});

test('no duplicate file entries when extractedText is empty', () => {
  const r = buildTldrForFiles([{ name: 'empty', extractedText: '' }]);
  assert.equal(r.perFile.length, 0);
});
