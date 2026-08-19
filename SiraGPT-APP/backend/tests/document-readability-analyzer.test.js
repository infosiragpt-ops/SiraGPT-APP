'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-readability-analyzer');
const { analyzeReadability, buildReadabilityForFiles, renderReadabilityBlock, _internal } = engine;
const { splitSentences, tokenizeWords, countSyllablesEnglish, countSyllablesSpanish, detectLanguage, fleschReadingEase, fleschKincaidGrade, fernandezHuerta } = _internal;

// ──────────────────────────────────────────────────────────────────────────
// Tokenisers
// ──────────────────────────────────────────────────────────────────────────

test('splitSentences: handles common abbreviations without breaking', () => {
  const sentences = splitSentences('Dr. Smith arrived at 10 a.m. The meeting started.');
  assert.equal(sentences.length, 2);
});

test('splitSentences: handles multiple terminators', () => {
  const sentences = splitSentences('Hello! Are you ready? Let us begin.');
  assert.equal(sentences.length, 3);
});

test('splitSentences: handles Spanish punctuation', () => {
  const sentences = splitSentences('¿Estás listo? ¡Vamos! Comenzamos ahora.');
  assert.ok(sentences.length >= 3);
});

test('tokenizeWords: keeps hyphens and apostrophes inside words', () => {
  const words = tokenizeWords("It's a state-of-the-art system.");
  assert.ok(words.includes("it's") || words.includes("It's"));
  assert.ok(words.some((w) => /state-of-the-art/i.test(w)));
});

// ──────────────────────────────────────────────────────────────────────────
// Syllable counters
// ──────────────────────────────────────────────────────────────────────────

test('countSyllablesEnglish: common words', () => {
  assert.equal(countSyllablesEnglish('hello'), 2);
  assert.equal(countSyllablesEnglish('beautiful'), 3);
  assert.equal(countSyllablesEnglish('readability'), 5);
  assert.ok(countSyllablesEnglish('cat') >= 1);
});

test('countSyllablesEnglish: short words always get at least 1', () => {
  assert.equal(countSyllablesEnglish('a'), 1);
  assert.equal(countSyllablesEnglish('I'), 1);
});

test('countSyllablesSpanish: handles diphthongs', () => {
  // "agua" has 2 syllables (a-gua); "cuento" has 2 (cuen-to)
  assert.equal(countSyllablesSpanish('agua'), 2);
  assert.equal(countSyllablesSpanish('cuento'), 2);
  assert.equal(countSyllablesSpanish('hola'), 2);
  assert.ok(countSyllablesSpanish('arquitectura') >= 5);
});

// ──────────────────────────────────────────────────────────────────────────
// Language detection
// ──────────────────────────────────────────────────────────────────────────

test('detectLanguage: identifies Spanish from common words', () => {
  const text = 'El sistema procesa los documentos con una precisión muy alta y devuelve resultados en segundos para los usuarios.';
  assert.equal(detectLanguage(text), 'es');
});

test('detectLanguage: identifies English from common words', () => {
  const text = 'The system processes the documents with very high accuracy and returns results in seconds for the users who need them.';
  assert.equal(detectLanguage(text), 'en');
});

test('detectLanguage: defaults to en for short/ambiguous samples', () => {
  assert.equal(detectLanguage('hola'), 'en');
});

// ──────────────────────────────────────────────────────────────────────────
// Score computations
// ──────────────────────────────────────────────────────────────────────────

test('fleschReadingEase: easy text scores high', () => {
  // ~10 words / sentence, ~1.3 syllables / word ⇒ FRE in the 80s-90s
  const score = fleschReadingEase(20, 2, 26);
  assert.ok(score > 75, `expected easy text >75, got ${score}`);
});

test('fleschReadingEase: dense text scores low', () => {
  // 35 words / sentence, 2.0 syllables / word ⇒ FRE in the negative range
  const score = fleschReadingEase(35, 1, 70);
  assert.ok(score < 30, `expected hard text <30, got ${score}`);
});

test('fleschKincaidGrade: increases with complexity', () => {
  const easy = fleschKincaidGrade(20, 2, 26);
  const hard = fleschKincaidGrade(35, 1, 70);
  assert.ok(hard > easy);
});

test('fernandezHuerta: returns Spanish-adapted Flesch number', () => {
  const score = fernandezHuerta(50, 5, 90);
  assert.ok(typeof score === 'number');
  assert.ok(score > 0);
});

// ──────────────────────────────────────────────────────────────────────────
// analyzeReadability — integrated
// ──────────────────────────────────────────────────────────────────────────

test('analyzeReadability: empty input returns no-content verdict', () => {
  const r = analyzeReadability('');
  assert.equal(r.verdict, 'no-content');
});

test('analyzeReadability: tolerates non-string input', () => {
  const r = analyzeReadability(null);
  assert.equal(r.verdict, 'no-content');
});

test('analyzeReadability: easy English text → easy verdict', () => {
  const text = 'The cat sat on the mat. It looked at me. I gave it food. The cat ate fast. Then it slept.';
  const r = analyzeReadability(text);
  assert.equal(r.language, 'en');
  assert.ok(['easy', 'medium'].includes(r.verdict), `expected easy/medium for simple text, got ${r.verdict}`);
});

test('analyzeReadability: dense academic text → hard verdict', () => {
  const text = 'The aforementioned multidimensional epistemological framework establishes a comprehensive interdisciplinary methodology fundamentally predicated upon the systematic deconstruction and subsequent reconstitution of paradigmatic theoretical constructs underlying contemporary phenomenological investigations of intersubjective hermeneutical dynamics within heterogeneous sociocultural environments.';
  const r = analyzeReadability(text);
  assert.equal(r.language, 'en');
  assert.ok(['hard', 'very-hard'].includes(r.verdict), `expected hard verdict for dense text, got ${r.verdict}`);
});

test('analyzeReadability: returns Spanish scores when Spanish is detected', () => {
  const text = 'El sistema procesa los documentos con una precisión muy alta y devuelve resultados en segundos para los usuarios que lo necesitan diariamente.';
  const r = analyzeReadability(text);
  assert.equal(r.language, 'es');
  assert.ok('fernandezHuerta' in r.scores);
});

test('analyzeReadability: counts polysyllabic and long words', () => {
  const text = 'Multidisciplinary readability analysis encompasses sophisticated computational methodologies and complementary linguistic instrumentation.';
  const r = analyzeReadability(text);
  assert.ok(r.polysyllabicRatio > 0.5);
  assert.ok(r.longWordRatio > 0.5);
});

test('analyzeReadability: bucket distribution sums to sentence count', () => {
  const text = 'Short. Now a slightly longer sentence with more content. ' + 'And ' + 'a '.repeat(40) + 'final very long sentence to push it past thirty-five words for testing purposes.';
  const r = analyzeReadability(text);
  const totalBucketed = r.sentenceBuckets.short + r.sentenceBuckets.medium + r.sentenceBuckets.long + r.sentenceBuckets.veryLong;
  assert.equal(totalBucketed, r.sentences);
});

test('analyzeReadability: respects opts.language override', () => {
  const text = 'The text is short.';
  const r = analyzeReadability(text, { language: 'es' });
  assert.equal(r.language, 'es');
});

// ──────────────────────────────────────────────────────────────────────────
// File-level + render
// ──────────────────────────────────────────────────────────────────────────

test('buildReadabilityForFiles: aggregates across files', () => {
  const files = [
    { originalName: 'a.md', extractedText: 'Short text. Easy to read.' },
    { originalName: 'b.md', extractedText: 'Multidimensional epistemological frameworks pervade contemporary discourse.' },
  ];
  const r = buildReadabilityForFiles(files);
  assert.equal(r.perFile.length, 2);
  assert.ok(r.aggregate.words > 0);
});

test('buildReadabilityForFiles: tolerates non-array input', () => {
  const r = buildReadabilityForFiles(null);
  assert.deepEqual(r.perFile, []);
});

test('renderReadabilityBlock: returns empty when no content', () => {
  assert.equal(renderReadabilityBlock(null), '');
  assert.equal(renderReadabilityBlock({ words: 0 }), '');
});

test('renderReadabilityBlock: includes verdict badge and tone hint', () => {
  const r = analyzeReadability('The cat sat on the mat. It looked at me. I gave it food. The cat ate fast.');
  const block = renderReadabilityBlock(r);
  assert.match(block, /## READABILITY/);
  assert.match(block, /Tone hint/);
  assert.match(block, /CEFR/);
});

test('renderReadabilityBlock: includes per-file section for multi-file', () => {
  const r = buildReadabilityForFiles([
    { originalName: 'a.md', extractedText: 'Short text. Easy to read every day.' },
    { originalName: 'b.md', extractedText: 'Highly complex multidisciplinary epistemological frameworks dominate.' },
  ]);
  const block = renderReadabilityBlock(r);
  assert.match(block, /Per-file readability/);
  assert.match(block, /a\.md/);
  assert.match(block, /b\.md/);
});
