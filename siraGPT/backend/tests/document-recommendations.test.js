'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-recommendations');
const { extractRecommendations, buildRecommendationsForFiles, renderRecommendationsBlock, _internal } = engine;
const { isRecommendation } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractRecommendations('').total, 0);
  assert.equal(extractRecommendations(null).total, 0);
});

test('isRecommendation: English forms', () => {
  assert.ok(isRecommendation('We recommend upgrading to the latest version.'));
  assert.ok(isRecommendation('It is advisable to implement two-factor authentication.'));
  assert.ok(isRecommendation('The panel recommends a phased rollout.'));
});

test('isRecommendation: Spanish forms', () => {
  assert.ok(isRecommendation('Recomendamos actualizar el sistema.'));
  assert.ok(isRecommendation('Se sugiere implementar un plan de respaldo.'));
});

test('isRecommendation: non-recommendation rejected', () => {
  assert.ok(!isRecommendation('The system was down for two hours.'));
});

test('extracts English recommendation sentences', () => {
  const text = 'We recommend upgrading the platform. It is advisable to schedule a review.';
  const r = extractRecommendations(text);
  assert.equal(r.total, 2);
});

test('extracts Spanish recommendations', () => {
  const text = 'Recomendamos revisar el procedimiento. Se sugiere documentar los cambios.';
  const r = extractRecommendations(text);
  assert.equal(r.total, 2);
});

test('dedupes identical recommendations', () => {
  const text = 'We recommend upgrading. We recommend upgrading.';
  const r = extractRecommendations(text);
  assert.equal(r.total, 1);
});

test('caps recommendations per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `We recommend action ${i}. `;
  const r = extractRecommendations(text);
  assert.ok(r.recommendations.length <= 14);
});

test('buildRecommendationsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'We recommend upgrading.' },
    { name: 'b.md', extractedText: 'Recomendamos respaldar los datos.' },
  ];
  const r = buildRecommendationsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderRecommendationsBlock returns markdown when items exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'We recommend upgrading.' }];
  const r = buildRecommendationsForFiles(files);
  const md = renderRecommendationsBlock(r);
  assert.match(md, /^## RECOMMENDATIONS/);
});

test('renderRecommendationsBlock empty when nothing found', () => {
  assert.equal(renderRecommendationsBlock({ perFile: [] }), '');
  assert.equal(renderRecommendationsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildRecommendationsForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'We recommend X.' }]);
  assert.ok(Array.isArray(r.perFile));
});
