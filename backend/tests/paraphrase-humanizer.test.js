'use strict';

// Unit tests for the paraphrase humanizer (anti-AI-detection layer).
// Pure-JS module, no external deps — these tests run fast and are
// deterministic.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  humanizeText,
  estimateAIScore,
  listAITellPatterns,
  clampScore,
  replaceAITells,
  cleanEmDashOveruse,
  boostBurstiness,
  matchCase,
} = require('../src/services/paraphrase-humanizer');

test('listAITellPatterns includes well-known LLM-favourite tells', () => {
  const patterns = listAITellPatterns();
  assert.ok(patterns.includes('furthermore'));
  assert.ok(patterns.includes('moreover'));
  assert.ok(patterns.includes('delve'));
  assert.ok(patterns.includes('en conclusión'));
  assert.ok(patterns.includes('cabe destacar que'));
  assert.ok(patterns.length >= 20, 'should ship at least 20 known tells');
});

test('matchCase preserves uppercase / titlecase from the source', () => {
  assert.equal(matchCase('Furthermore', 'also'), 'Also');
  assert.equal(matchCase('FURTHERMORE', 'also'), 'ALSO');
  assert.equal(matchCase('furthermore', 'also'), 'also');
});

test('replaceAITells swaps "furthermore" → neutral synonym and reports the change', () => {
  const r = replaceAITells('Furthermore, the results were strong.');
  assert.ok(!/furthermore/i.test(r.text), `still contains "furthermore": ${r.text}`);
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0].kind, 'ai_tell');
  assert.equal(r.applied[0].from, 'Furthermore');
});

test('replaceAITells is deterministic — same input twice gives the same output', () => {
  const a = replaceAITells('Moreover, the report was extensive. Furthermore, we noticed gaps.');
  const b = replaceAITells('Moreover, the report was extensive. Furthermore, we noticed gaps.');
  assert.equal(a.text, b.text);
});

test('replaceAITells handles Spanish AI-tells too', () => {
  const r = replaceAITells('Cabe destacar que el modelo mejora notablemente. Sin embargo, persisten retos.');
  assert.ok(!/cabe destacar que/i.test(r.text), `Spanish tell not replaced: ${r.text}`);
  assert.ok(!/sin embargo/i.test(r.text), `Spanish tell not replaced: ${r.text}`);
  assert.ok(r.applied.length >= 2);
});

test('replaceAITells leaves text untouched when there are no tells', () => {
  const original = 'The cat sat on the mat. It was a sunny day.';
  const r = replaceAITells(original);
  assert.equal(r.text, original);
  assert.equal(r.applied.length, 0);
});

test('cleanEmDashOveruse collapses short " — X — " parentheticals into commas', () => {
  const r = cleanEmDashOveruse('The model — trained on Llama — handled the load.');
  assert.ok(!/—/.test(r.text), `em-dashes still present: ${r.text}`);
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0].kind, 'em_dash');
});

test('cleanEmDashOveruse leaves stand-alone em-dashes alone (only collapses pairs)', () => {
  const original = 'The result was clear — and surprising.';
  const r = cleanEmDashOveruse(original);
  assert.equal(r.text, original, 'single em-dash should not be collapsed');
});

test('boostBurstiness splits a long 3+comma sentence into two', () => {
  // 30+ words, 4 commas → over the threshold (commas>=3 AND words>=25).
  const long = 'The framework supports paraphrasing across multiple languages, citation extraction with DOI resolution, multi-language summarisation outputs, batch processing of thousands of documents, and full pipeline orchestration across distributed worker nodes around the world.';
  const r = boostBurstiness(long);
  // Result should have an extra period (the split).
  const periodsBefore = (long.match(/\./g) || []).length;
  const periodsAfter = (r.text.match(/\./g) || []).length;
  assert.ok(periodsAfter > periodsBefore, `expected more sentences after split: ${r.text}`);
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0].kind, 'burstiness');
});

test('boostBurstiness leaves short sentences untouched', () => {
  const original = 'The result was clear. We moved on.';
  const r = boostBurstiness(original);
  assert.equal(r.text.trim(), original);
  assert.equal(r.applied.length, 0);
});

test('estimateAIScore returns 0 for very short input', () => {
  assert.equal(estimateAIScore(''), 0);
  assert.equal(estimateAIScore('Hi.'), 0);
});

test('estimateAIScore rates AI-heavy text high and clean text low', () => {
  const aiLike = 'Furthermore, the analysis demonstrates significant impact. Moreover, results indicate strong correlation. Additionally, the methodology supports the conclusion. In conclusion, the findings are robust.';
  const human = 'I ran a few tests last week. Some passed. Others failed in weird ways I did not expect, so I went back to the logs. Turns out the cache was stale.';
  const scoreAI = estimateAIScore(aiLike);
  const scoreHuman = estimateAIScore(human);
  assert.ok(scoreAI > scoreHuman, `AI score ${scoreAI} should exceed human score ${scoreHuman}`);
  assert.ok(scoreAI > 0.3, `AI-like text should score > 0.3, got ${scoreAI}`);
});

test('humanizeText: lowers the AI score on a clearly AI-flavoured paragraph', () => {
  const input = 'Furthermore, the framework demonstrates significant capacity. Moreover, the results indicate strong performance. Additionally, the architecture supports scalability. In conclusion, the findings are robust.';
  const r = humanizeText({ text: input, language: 'en', intensity: 'medium' });
  assert.ok(r.aiScoreAfter < r.aiScoreBefore, `expected score to drop: ${r.aiScoreBefore} → ${r.aiScoreAfter}`);
  assert.ok(r.deltaScore > 0);
  assert.ok(r.applied.length >= 3);
  assert.ok(!/furthermore/i.test(r.text));
  assert.ok(!/moreover/i.test(r.text));
});

test('humanizeText: idempotent on clean text (no oscillation, no diff)', () => {
  const clean = 'I built a small prototype yesterday. It worked. Then I broke it on purpose to study the failure.';
  const r1 = humanizeText({ text: clean });
  const r2 = humanizeText({ text: r1.text });
  assert.equal(r1.text, clean, 'clean text should pass through unchanged');
  assert.equal(r2.text, r1.text, 'second pass over clean text is a no-op');
});

test('humanizeText: empty input returns empty output, no crash', () => {
  const r = humanizeText({ text: '' });
  assert.equal(r.text, '');
  assert.equal(r.applied.length, 0);
  assert.equal(r.deltaScore, 0);
});

test('humanizeText: intensity controls pass count (low=1, high=3) but never inflates output', () => {
  const input = 'Furthermore, the framework demonstrates power. Moreover, the data shows growth. Additionally, the gains compound.';
  const low = humanizeText({ text: input, intensity: 'low' });
  const high = humanizeText({ text: input, intensity: 'high' });
  // High intensity should reach a fixed point at or below low intensity's score.
  assert.ok(high.aiScoreAfter <= low.aiScoreAfter);
});

test('humanizeText: surfaces language and intensity in the result envelope', () => {
  const r = humanizeText({ text: 'Furthermore, all is well.', language: 'en', intensity: 'high' });
  assert.equal(r.language, 'en');
  assert.equal(r.intensity, 'high');
});

test('clampScore: clamps to [0,1] with 3-decimal rounding', () => {
  assert.equal(clampScore(0.5), 0.5);
  assert.equal(clampScore(0), 0);
  assert.equal(clampScore(1), 1);
  assert.equal(clampScore(-0.5), 0);
  assert.equal(clampScore(2), 1);
  assert.equal(clampScore(0.123456), 0.123);
  assert.equal(clampScore(NaN), 0, 'NaN should clamp to safe default 0');
  assert.equal(clampScore(Infinity), 0, 'Infinity is not finite — clamp to 0');
  assert.equal(clampScore('not a number'), 0);
  assert.equal(clampScore(null), 0);
  assert.equal(clampScore(undefined), 0);
});

test('Round-2 AI-tells: "tapestry of", "testament to", "navigate the complexities" caught', () => {
  const en = 'The model is a testament to engineering. It must navigate the complexities of tapestry of options.';
  const r = humanizeText({ text: en, language: 'en' });
  assert.ok(!/tapestry of/i.test(r.text), r.text);
  assert.ok(!/testament to/i.test(r.text), r.text);
  assert.ok(!/navigate the complexities of/i.test(r.text), r.text);
});

test('Round-2 AI-tells (Spanish): "es decir,", "por otro lado,", "en definitiva", "desempeña un papel"', () => {
  const es = 'Es decir, el modelo desempeña un papel central. Por otro lado, en definitiva, hay mejoras pendientes.';
  const r = humanizeText({ text: es, language: 'es' });
  assert.ok(!/es decir,/i.test(r.text), r.text);
  assert.ok(!/por otro lado,/i.test(r.text), r.text);
  assert.ok(!/en definitiva/i.test(r.text), r.text);
  assert.ok(!/desempeña un papel/i.test(r.text), r.text);
});

test('humanizeText: Spanish text loses "cabe destacar que" / "sin embargo"', () => {
  const input = 'Cabe destacar que el sistema funcionó. Sin embargo, hubo demoras. Asimismo, se identificaron fallos. En conclusión, hay margen de mejora.';
  const r = humanizeText({ text: input, language: 'es' });
  assert.ok(!/cabe destacar que/i.test(r.text), r.text);
  assert.ok(!/sin embargo/i.test(r.text), r.text);
  assert.ok(!/asimismo/i.test(r.text), r.text);
  assert.ok(!/en conclusión/i.test(r.text), r.text);
});
