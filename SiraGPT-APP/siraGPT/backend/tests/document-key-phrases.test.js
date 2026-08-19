'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-key-phrases');
const { buildKeyPhrasesForFiles, renderKeyPhrasesBlock, _internal } = engine;
const { tokenize, nGrams, termFrequency } = _internal;

test('tokenize: keeps 3+ char content tokens', () => {
  const out = tokenize('Acme Corp grew 32% to $4.2M.');
  assert.ok(out.includes('acme'));
  assert.ok(out.includes('corp'));
});

test('nGrams: drops stop-words and short tokens', () => {
  const ngs = nGrams(['acme', 'and', 'corp'], 2);
  assert.equal(ngs.length, 0);
});

test('nGrams: keeps clean bigrams', () => {
  const ngs = nGrams(['supply', 'chain', 'resilience'], 2);
  assert.ok(ngs.includes('supply chain'));
});

test('termFrequency counts n-grams', () => {
  const tf = termFrequency('Supply chain risks. Supply chain resilience. Supply chain map.');
  assert.ok((tf.get('supply chain') || 0) >= 3);
});

test('buildKeyPhrasesForFiles: empty list', () => {
  const r = buildKeyPhrasesForFiles([]);
  assert.equal(r.perFile.length, 0);
});

test('buildKeyPhrasesForFiles: single file degrades to TF', () => {
  const files = [{
    name: 'doc.md',
    extractedText: 'Supply chain resilience matters. Supply chain risks are surveyed. Supply chain map across regions.',
  }];
  const r = buildKeyPhrasesForFiles(files);
  assert.equal(r.perFile.length, 1);
  const phrases = r.perFile[0].phrases.map((p) => p.phrase);
  assert.ok(phrases.some((p) => p.includes('supply chain')));
});

test('multi-file TF-IDF surfaces document-specific phrases', () => {
  const files = [
    { name: 'a.md', extractedText: 'Quantum computing breakthroughs are common in quantum research labs. Quantum projects continue.' },
    { name: 'b.md', extractedText: 'Cooking recipes for chocolate cake involve mixing flour and sugar.' },
  ];
  const r = buildKeyPhrasesForFiles(files);
  // 'quantum' should rank for file A, 'chocolate' (or similar) for B.
  const aPhrases = r.perFile.find((p) => p.file === 'a.md').phrases.map((p) => p.phrase).join(' ');
  const bPhrases = r.perFile.find((p) => p.file === 'b.md').phrases.map((p) => p.phrase).join(' ');
  assert.match(aPhrases, /quantum/);
  assert.match(bPhrases, /(chocolate|recipe|sugar|cake)/);
});

test('renderKeyPhrasesBlock returns markdown when phrases exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Supply chain. Supply chain. Supply chain.' }];
  const r = buildKeyPhrasesForFiles(files);
  const md = renderKeyPhrasesBlock(r);
  assert.match(md, /^## KEY PHRASES/);
});

test('renderKeyPhrasesBlock empty when no files', () => {
  assert.equal(renderKeyPhrasesBlock({ perFile: [] }), '');
  assert.equal(renderKeyPhrasesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildKeyPhrasesForFiles([{ name: 'noisy', extractedText: null }, { name: 'good', extractedText: 'Supply chain supply chain supply chain.' }]);
  assert.equal(r.perFile.length, 1);
});

test('aggregate is sorted by score descending', () => {
  const files = [
    { name: 'a.md', extractedText: 'Supply chain. Supply chain. Routine.' },
    { name: 'b.md', extractedText: 'Supply chain. Routine routine routine.' },
  ];
  const r = buildKeyPhrasesForFiles(files);
  for (let i = 1; i < r.aggregate.length; i++) {
    assert.ok(r.aggregate[i].score <= r.aggregate[i - 1].score);
  }
});

test('phrase set is bilingual (English + Spanish)', () => {
  const text = 'Cadena de suministro robusta. Cadena de suministro segura. Supply chain resilience.';
  const r = buildKeyPhrasesForFiles([{ name: 'mix.md', extractedText: text }]);
  const phrases = r.perFile[0].phrases.map((p) => p.phrase).join(' ');
  assert.match(phrases, /(cadena|suministro|supply chain)/);
});

test('counts ≥ 2 required for single-file TF results', () => {
  const r = buildKeyPhrasesForFiles([{ name: 'doc.md', extractedText: 'Only once: quantum.' }]);
  const phrases = r.perFile[0]?.phrases || [];
  for (const p of phrases) assert.ok(p.count >= 2);
});

test('preserves source filename per entry', () => {
  const files = [
    { name: 'one.md', extractedText: 'Supply chain. Supply chain.' },
    { name: 'two.md', extractedText: 'Chocolate cake. Chocolate cake.' },
  ];
  const r = buildKeyPhrasesForFiles(files);
  const sources = r.perFile.map((p) => p.file).sort();
  assert.deepEqual(sources, ['one.md', 'two.md']);
});
