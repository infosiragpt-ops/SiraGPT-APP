'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-sentiment');
const { scoreText, buildSentimentForFile, buildSentimentForFiles, renderSentimentBlock, _internal } = engine;
const { detectHeadings, splitIntoSections } = _internal;

test('empty / non-string input → neutral score 0', () => {
  assert.deepEqual(scoreText(''), { score: 0, label: 'neutral', positives: 0, negatives: 0 });
});

test('positive text → positive label', () => {
  const r = scoreText('The launch was successful and the growth was great. The team achieved a milestone.');
  assert.ok(['positive', 'very-positive'].includes(r.label));
});

test('negative text → negative label', () => {
  const r = scoreText('There was a severe outage and a critical breach. The team failed to deliver.');
  assert.ok(['negative', 'very-negative'].includes(r.label));
});

test('intensifier amplifies polarity', () => {
  const plain = scoreText('There is a risk in the rollout.');
  const intense = scoreText('There is a very critical risk in the rollout.');
  assert.ok(intense.negatives >= plain.negatives);
});

test('negation flips polarity', () => {
  const positive = scoreText('The strategy is successful.');
  const negated = scoreText('The strategy is not successful.');
  assert.ok(negated.score <= positive.score);
});

test('Spanish positive text', () => {
  const r = scoreText('El lanzamiento fue exitoso y el equipo logró un crecimiento sobresaliente.');
  assert.ok(['positive', 'very-positive'].includes(r.label));
});

test('Spanish negative text', () => {
  const r = scoreText('Hubo un fracaso crítico y una severa caída de operaciones.');
  assert.ok(['negative', 'very-negative'].includes(r.label));
});

test('detectHeadings: markdown / numbered / all-caps', () => {
  const text = '# Title A\nBody A\n2.1 Subsection\nBody B\nALL CAPS HEADING\nBody C';
  const headings = detectHeadings(text);
  assert.ok(headings.length >= 2);
});

test('splitIntoSections: respects headings + minimum length', () => {
  const text = `# Section A
${'positive '.repeat(20)}
# Section B
${'negative '.repeat(20)}`;
  const sections = splitIntoSections(text);
  assert.equal(sections.length, 2);
});

test('buildSentimentForFile picks top-polarity sections', () => {
  const text = `# Intro
This is a routine report from the team.
# Risks
There is a severe outage and a critical breach in production with major losses.
# Wins
The team achieved a milestone and the launch was successful with strong growth.`;
  const out = buildSentimentForFile(text);
  assert.ok(out.length >= 2);
  const labels = out.map((s) => s.label);
  assert.ok(labels.some((l) => l.includes('positive')));
  assert.ok(labels.some((l) => l.includes('negative')));
});

test('buildSentimentForFiles aggregates across files', () => {
  const files = [
    { name: 'a.md', extractedText: '# Win\nGreat success this quarter.' },
    { name: 'b.md', extractedText: '# Issue\nSevere outage and breach.' },
  ];
  const r = buildSentimentForFiles(files);
  assert.equal(r.perFile.length, 2);
  assert.ok(r.aggregate.length >= 1);
});

test('renderSentimentBlock returns markdown when sections exist', () => {
  const files = [{
    name: 'demo.md',
    extractedText: '# Win\nGreat success and outstanding growth this year for the team and customers.\n# Risk\nThere is a severe outage with major losses and critical concerns.\n',
  }];
  const r = buildSentimentForFiles(files);
  const md = renderSentimentBlock(r);
  assert.match(md, /^## DOCUMENT SENTIMENT/);
});

test('renderSentimentBlock empty when no sections', () => {
  assert.equal(renderSentimentBlock({ perFile: [] }), '');
  assert.equal(renderSentimentBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildSentimentForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: '# X\nGreat success.' }]);
  assert.ok(Array.isArray(r.perFile));
});

test('score is bounded to [-1, +1]', () => {
  const positive = scoreText('successful great excellent outstanding positive growth innovation success');
  const negative = scoreText('failure terrible severe crisis collapse outage breach mistake');
  assert.ok(positive.score >= -1 && positive.score <= 1);
  assert.ok(negative.score >= -1 && negative.score <= 1);
});
