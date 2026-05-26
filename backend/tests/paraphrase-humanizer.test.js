'use strict';

// Unit tests for the paraphrase humanizer (anti-AI-detection layer).
// Pure-JS module, no external deps — these tests run fast and are
// deterministic.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  humanizeText,
  humanizeChunked,
  estimateAIScore,
  listAITellPatterns,
  countAITellPatternsByLanguage,
  topAITellsFound,
  topAITellsByLanguage,
  clampScore,
  replaceAITells,
  cleanEmDashOveruse,
  boostBurstiness,
  matchCase,
} = require('../src/services/paraphrase-humanizer');

test('countAITellPatternsByLanguage: returns positive counts for english + spanish buckets', () => {
  const counts = countAITellPatternsByLanguage();
  assert.ok(counts.english > 0, 'should have English tells');
  assert.ok(counts.spanish > 0, 'should have Spanish tells');
  // Total across buckets equals total pattern count.
  const total = counts.english + counts.spanish + counts.other;
  assert.equal(total, listAITellPatterns().length);
});

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

test('boostBurstiness splits on semicolons in long sentences (AI signal)', () => {
  // 20+ words, semicolon → over the threshold (words>=18 AND ;>=1).
  const long = 'The model performs well across the entire benchmark suite of evaluations; it handles structured data inputs from many sources and produces faithful outputs reliably every single time.';
  const r = boostBurstiness(long);
  assert.ok(!r.text.includes(';'), `semicolon should be promoted to period: ${r.text}`);
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0].kind, 'burstiness');
  assert.equal(r.applied[0].from, 'semicolon-split');
});

test('boostBurstiness leaves semicolons in short sentences alone', () => {
  const short = 'A; B.';
  const r = boostBurstiness(short);
  assert.ok(r.text.includes(';'), 'short sentences should keep their semicolons');
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

test('humanizeChunked: bypasses chunking when text fits maxChunkChars', () => {
  const input = 'Furthermore, the data is fine. Moreover, the gains compound.';
  const r = humanizeChunked({ text: input, maxChunkChars: 1000 });
  assert.equal(r.chunked, undefined, 'small inputs should not be chunked');
});

test('humanizeChunked: splits paragraph-boundary inputs > maxChunkChars', () => {
  // Make each paragraph contain a tell + push past the chunk threshold.
  const para = 'Furthermore, ' + ('lorem ipsum '.repeat(50));
  const input = `${para}\n\n${para}\n\n${para}`;
  const r = humanizeChunked({ text: input, maxChunkChars: 50 });
  assert.equal(r.chunked, true);
  assert.equal(r.chunkCount, 3);
  assert.ok(!r.text.match(/furthermore/i), `tells should be replaced across chunks: ${r.text.slice(0, 200)}`);
});

test('humanizeChunked: aggregated aiScores stay in [0,1]', () => {
  const para = 'Furthermore, all systems are clearly very robust. '.repeat(20);
  const input = `${para}\n\n${para}\n\n${para}`;
  const r = humanizeChunked({ text: input, maxChunkChars: 100 });
  assert.ok(r.aiScoreBefore >= 0 && r.aiScoreBefore <= 1);
  assert.ok(r.aiScoreAfter >= 0 && r.aiScoreAfter <= 1);
});

test('topAITellsByLanguage(en): only matches English tells, ignores Spanish', () => {
  const mixed = 'Furthermore, the results are strong. Cabe destacar que el dato es real.';
  const en = topAITellsByLanguage(mixed, 'english');
  assert.ok(en.find((t) => t.pattern === 'furthermore'));
  assert.ok(!en.find((t) => t.pattern === 'cabe destacar que'));
});

test('topAITellsByLanguage(es): only matches Spanish tells', () => {
  const mixed = 'Furthermore, the results are strong. Cabe destacar que el dato es real.';
  const es = topAITellsByLanguage(mixed, 'spanish');
  assert.ok(es.find((t) => t.pattern === 'cabe destacar que'));
  assert.ok(!es.find((t) => t.pattern === 'furthermore'));
});

test('topAITellsByLanguage: unknown language returns []', () => {
  assert.deepEqual(topAITellsByLanguage('Furthermore', 'french'), []);
  assert.deepEqual(topAITellsByLanguage('', 'english'), []);
});

test('topAITellsFound: returns nothing for clean text', () => {
  assert.deepEqual(topAITellsFound('I like clean prose. No noise here.'), []);
  assert.deepEqual(topAITellsFound(''), []);
});

test('topAITellsFound: counts AI-tells and sorts by frequency desc', () => {
  const text = 'Furthermore, this. Furthermore, that. Moreover, the other. Delve into more.';
  const top = topAITellsFound(text);
  assert.equal(top[0].pattern, 'furthermore');
  assert.equal(top[0].count, 2);
  assert.equal(top[1].pattern, 'moreover');
  assert.equal(top[1].count, 1);
  assert.ok(top.find((t) => t.pattern === 'delve'));
});

test('topAITellsFound: respects limit', () => {
  const text = 'Furthermore. Moreover. Additionally. Delve into. Navigate.';
  const top = topAITellsFound(text, { limit: 2 });
  assert.equal(top.length, 2);
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

test('excludeTells keeps the named patterns verbatim (case-insensitive)', () => {
  const input = 'Moreover, the data is solid. Furthermore, the model converges.';
  const r = humanizeText({ text: input, language: 'en', excludeTells: ['moreover'] });
  // "moreover" should survive; "furthermore" should be replaced.
  assert.ok(/moreover/i.test(r.text), `expected moreover kept: ${r.text}`);
  assert.ok(!/furthermore/i.test(r.text), `expected furthermore replaced: ${r.text}`);
});

test('excludeTells with the empty array changes nothing', () => {
  const input = 'Furthermore, the data converges.';
  const a = humanizeText({ text: input, language: 'en' });
  const b = humanizeText({ text: input, language: 'en', excludeTells: [] });
  assert.equal(a.text, b.text);
});

test('replaceAITells: excludeTells param skips named keys', () => {
  const out = replaceAITells('Furthermore, moreover, the data is fine.', { excludeTells: ['furthermore', 'moreover'] });
  assert.ok(/furthermore/i.test(out.text));
  assert.ok(/moreover/i.test(out.text));
  assert.equal(out.applied.length, 0);
});

test('humanizeText: Spanish text loses "cabe destacar que" / "sin embargo"', () => {
  const input = 'Cabe destacar que el sistema funcionó. Sin embargo, hubo demoras. Asimismo, se identificaron fallos. En conclusión, hay margen de mejora.';
  const r = humanizeText({ text: input, language: 'es' });
  assert.ok(!/cabe destacar que/i.test(r.text), r.text);
  assert.ok(!/sin embargo/i.test(r.text), r.text);
  assert.ok(!/asimismo/i.test(r.text), r.text);
  assert.ok(!/en conclusión/i.test(r.text), r.text);
});

test('topAITellsFound: returns top patterns sorted by count', () => {
  const text = 'Furthermore, furthermore, moreover, this is important. Furthermore, it is worth noting that.';
  const hits = topAITellsFound(text);
  assert.ok(Array.isArray(hits));
  assert.ok(hits.length > 0);
  assert.ok(hits[0].count >= hits[hits.length - 1].count, 'should be sorted descending');
  assert.ok(hits.every((h) => typeof h.pattern === 'string' && h.count > 0));
});

test('topAITellsFound: empty text returns empty array', () => {
  assert.deepEqual(topAITellsFound(''), []);
  assert.deepEqual(topAITellsFound('   '), []);
  assert.deepEqual(topAITellsFound(null), []);
});

test('topAITellsFound: respects limit option', () => {
  const text = 'Furthermore, moreover, additionally, it is worth noting that, this is important, in conclusion.';
  const hits = topAITellsFound(text, { limit: 2 });
  assert.ok(hits.length <= 2);
});

test('topAITellsFound: clean text with no AI tells returns empty array', () => {
  const hits = topAITellsFound('The cat sat on the mat. It was a sunny day.');
  assert.deepEqual(hits, []);
});
