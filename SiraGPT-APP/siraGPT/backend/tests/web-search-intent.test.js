'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectWebSearchIntent,
  detectBatch,
} = require('../src/services/web-search-intent');

test('empty input returns no intent', () => {
  const r = detectWebSearchIntent('');
  assert.equal(r.needsWebSearch, false);
  assert.equal(r.confidence, 0);
  assert.deepEqual(r.signals, []);
});

test('null/undefined input handled gracefully', () => {
  assert.equal(detectWebSearchIntent(null).needsWebSearch, false);
  assert.equal(detectWebSearchIntent(undefined).needsWebSearch, false);
});

test('flags temporal "today" in Spanish', () => {
  const r = detectWebSearchIntent('¿Qué noticias hay hoy sobre Argentina?');
  assert.equal(r.needsWebSearch, true);
  assert.ok(r.signals.some((s) => s.startsWith('temporal:today')));
  assert.ok(r.signals.some((s) => s.startsWith('live_event:news')));
});

test('flags temporal "today" in English', () => {
  const r = detectWebSearchIntent('What is happening today in tech?');
  assert.equal(r.needsWebSearch, true);
  assert.ok(r.signals.some((s) => s.startsWith('temporal:today')));
});

test('flags current/latest signals', () => {
  const r = detectWebSearchIntent('Dame las últimas novedades del mercado actual');
  assert.equal(r.needsWebSearch, true);
  assert.ok(r.signals.some((s) => s.includes('current')) || r.signals.some((s) => s.includes('latest')));
});

test('flags future year reference', () => {
  const r = detectWebSearchIntent('¿Qué se espera para 2026 en inteligencia artificial?');
  assert.equal(r.needsWebSearch, true);
  assert.ok(r.signals.some((s) => s.includes('this_year') || s.includes('currency_year')));
});

test('flags live-event price quote', () => {
  const r = detectWebSearchIntent('Cuál es el precio del bitcoin');
  assert.equal(r.needsWebSearch, true);
  assert.ok(r.signals.some((s) => s.startsWith('live_event:price_quote')));
});

test('flags weather query', () => {
  const r = detectWebSearchIntent('What is the weather in Madrid today?');
  assert.equal(r.needsWebSearch, true);
  assert.ok(r.signals.some((s) => s.startsWith('live_event:weather')));
});

test('flags explicit URL paste', () => {
  const r = detectWebSearchIntent('Lee este artículo: https://example.com/news/2026');
  assert.equal(r.needsWebSearch, true);
  assert.ok(r.signals.some((s) => s.includes('explicit_url') || s.includes('this_year')));
});

test('flags explicit search request', () => {
  const r = detectWebSearchIntent('Busca en internet información sobre criptomonedas');
  assert.equal(r.needsWebSearch, true);
  assert.ok(r.signals.some((s) => s.startsWith('explicit:explicit_search')));
});

test('does NOT flag pure creative writing', () => {
  const r = detectWebSearchIntent('Escríbeme un cuento sobre un dragón');
  assert.equal(r.needsWebSearch, false);
});

test('does NOT flag generic math problem', () => {
  const r = detectWebSearchIntent('Resuelve la integral de x al cubo');
  assert.equal(r.needsWebSearch, false);
});

test('does NOT flag general factual question without temporal marker', () => {
  const r = detectWebSearchIntent('¿Qué es el teorema de Pitágoras?');
  assert.equal(r.needsWebSearch, false);
});

test('does NOT flag general code question without freshness signal', () => {
  const r = detectWebSearchIntent('Cómo se hace una función recursiva en Python');
  assert.equal(r.needsWebSearch, false);
});

test('threshold can be tuned', () => {
  const prompt = 'Resultados del último partido';
  const strict = detectWebSearchIntent(prompt, { threshold: 0.9 });
  const lax = detectWebSearchIntent(prompt, { threshold: 0.1 });
  assert.equal(strict.needsWebSearch, false);
  assert.equal(lax.needsWebSearch, true);
});

test('includeNegatives:false ignores creative-writing dampener', () => {
  const prompt = 'Escríbeme un cuento sobre las noticias de hoy';
  const withNeg = detectWebSearchIntent(prompt);
  const withoutNeg = detectWebSearchIntent(prompt, { includeNegatives: false });
  assert.ok(withoutNeg.confidence >= withNeg.confidence);
});

test('detectBatch returns one result per prompt', () => {
  const results = detectBatch([
    'qué noticias hay hoy',
    'escríbeme un poema',
    'precio del oro',
  ]);
  assert.equal(results.length, 3);
  assert.equal(results[0].needsWebSearch, true);
  assert.equal(results[1].needsWebSearch, false);
  assert.equal(results[2].needsWebSearch, true);
});

test('confidence is clamped to [0,1]', () => {
  const veryStrong = detectWebSearchIntent(
    'Busca en internet las últimas noticias actuales del precio de bitcoin hoy en 2026 https://example.com/now',
  );
  assert.ok(veryStrong.confidence >= 0 && veryStrong.confidence <= 1);
});

test('confidence is deterministic for same input', () => {
  const a = detectWebSearchIntent('qué pasó ayer con el mercado');
  const b = detectWebSearchIntent('qué pasó ayer con el mercado');
  assert.equal(a.confidence, b.confidence);
  assert.deepEqual(a.signals.sort(), b.signals.sort());
});

test('confidence reflects strength: stronger signals → higher score', () => {
  const weak = detectWebSearchIntent('precios');
  const strong = detectWebSearchIntent('precio del bitcoin hoy en vivo');
  assert.ok(strong.confidence > weak.confidence);
});
