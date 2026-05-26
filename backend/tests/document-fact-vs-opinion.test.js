'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-fact-vs-opinion');
const { classifySentences, classifySentence, buildClassificationForFiles, renderClassificationBlock, _internal } = engine;
const { hasOpinion, factScore } = _internal;

test('empty / non-string tolerated', () => {
  const r = classifySentences('');
  assert.equal(r.facts.length, 0);
  assert.equal(r.opinions.length, 0);
});

test('hasOpinion: hedges in English', () => {
  assert.ok(hasOpinion('We believe this is the right approach.'));
  assert.ok(hasOpinion('The platform may scale further.'));
});

test('hasOpinion: hedges in Spanish', () => {
  assert.ok(hasOpinion('Creemos que esta es la mejor opción.'));
  assert.ok(hasOpinion('Posiblemente el sistema escale más.'));
});

test('factScore: ≥ 2 anchors counts as fact-rich', () => {
  assert.ok(factScore('Acme Corp grew 32% to $4.2M on 2026-06-15.') >= 2);
});

test('classifySentence: fact-rich → fact', () => {
  assert.equal(classifySentence('Acme Corp reported $4.2M revenue on 2026-06-15.'), 'fact');
});

test('classifySentence: hedged → opinion', () => {
  assert.equal(classifySentence('We believe Acme Corp may grow this year.'), 'opinion');
});

test('classifySentence: vague sentence → null', () => {
  assert.equal(classifySentence('The team had a productive meeting.'), null);
});

test('classifySentences separates facts and opinions', () => {
  const text = 'Acme Corp grew 32% to $4.2M in Q1 2026. We believe future growth may slow.';
  const r = classifySentences(text);
  assert.ok(r.facts.length >= 1);
  assert.ok(r.opinions.length >= 1);
});

test('Spanish: fact + opinion separation', () => {
  const text = 'Los ingresos crecieron 32% hasta $4.2M en Q1 2026. Creemos que el crecimiento podría ralentizarse.';
  const r = classifySentences(text);
  assert.ok(r.facts.length >= 1);
  assert.ok(r.opinions.length >= 1);
});

test('dedupes identical facts / opinions', () => {
  const text = 'Acme Corp reported $4.2M on 2026-06-15. Acme Corp reported $4.2M on 2026-06-15.';
  const r = classifySentences(text);
  assert.equal(r.facts.length, 1);
});

test('buildClassificationForFiles aggregates per file', () => {
  const files = [
    { name: 'a.md', extractedText: 'Acme Corp reported $4.2M on 2026-06-15.' },
    { name: 'b.md', extractedText: 'We believe Acme Corp may grow more.' },
  ];
  const r = buildClassificationForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderClassificationBlock returns markdown when content exists', () => {
  const files = [{ name: 'doc.md', extractedText: 'Acme Corp reported $4.2M on 2026-06-15. We believe growth may slow.' }];
  const r = buildClassificationForFiles(files);
  const md = renderClassificationBlock(r);
  assert.match(md, /^## FACT vs OPINION/);
});

test('renderClassificationBlock empty when nothing surfaces', () => {
  assert.equal(renderClassificationBlock({ perFile: [] }), '');
  assert.equal(renderClassificationBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildClassificationForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'Acme Corp grew 12% to $4M in Q1 2026.' }]);
  assert.ok(Array.isArray(r.perFile));
});
