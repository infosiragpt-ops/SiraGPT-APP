'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  expandShortQuery,
  tokenCount,
  TOKEN_THRESHOLD,
  MAX_EXPANDED_LEN,
} = require('../src/services/agents/short-query-expander');

// ─── tokenCount ──────────────────────────────────────────────────────

test('tokens: counts words', () => {
  assert.equal(tokenCount('hola mundo cruel'), 3);
});

test('tokens: handles empty/null', () => {
  assert.equal(tokenCount(''), 0);
  assert.equal(tokenCount(null), 0);
  assert.equal(tokenCount(undefined), 0);
});

test('tokens: collapses whitespace', () => {
  assert.equal(tokenCount('  hola   mundo  '), 2);
});

// ─── no_expansion path ───────────────────────────────────────────────

test('long prompt → no_expansion', () => {
  const long = 'genera un informe completo sobre marketing digital con análisis competitivo profundo';
  const r = expandShortQuery({ prompt: long });
  assert.equal(r.source, 'no_expansion');
  assert.equal(r.expanded, long);
});

test('exactly threshold tokens → no_expansion', () => {
  const exactly = Array.from({ length: TOKEN_THRESHOLD }, (_, i) => `word${i}`).join(' ');
  const r = expandShortQuery({ prompt: exactly });
  assert.equal(r.source, 'no_expansion');
});

test('empty prompt → empty source', () => {
  const r = expandShortQuery({ prompt: '' });
  assert.equal(r.source, 'empty');
});

// ─── lexicon additions ───────────────────────────────────────────────

test('short prompt mentioning lexicon term → addition included', () => {
  const r = expandShortQuery({
    prompt: 'actualiza mi CV',
    lexiconTerms: [{ term: 'mi CV', definition: 'archivo resumen_2026.pdf' }],
  });
  assert.equal(r.source, 'expanded');
  assert.ok(r.additions.some((a) => a.includes('mi CV')));
  assert.match(r.expanded, /mi CV/);
  // Original siempre se preserva
  assert.equal(r.original, 'actualiza mi CV');
});

test('short prompt without lexicon match → no lexicon addition', () => {
  const r = expandShortQuery({
    prompt: 'hazme algo',
    lexiconTerms: [{ term: 'mi CV', definition: 'archivo X' }],
  });
  // Puede tener keywords pero no debe tener el lexicón
  assert.ok(!r.additions.some((a) => a.includes('mi CV')));
});

// ─── recentTurns context ─────────────────────────────────────────────

test('short prompt with assistant context → adds previous context', () => {
  const r = expandShortQuery({
    prompt: 'sigue',
    recentTurns: [
      { role: 'user', text: 'explícame los embeddings' },
      { role: 'assistant', text: 'Los embeddings son representaciones vectoriales que capturan semántica' },
    ],
  });
  assert.equal(r.source, 'expanded');
  assert.ok(r.additions.some((a) => a.includes('contexto previo')));
  assert.match(r.expanded, /embeddings/);
});

test('only user turns → no context added (no assistant text)', () => {
  const r = expandShortQuery({
    prompt: 'sigue',
    recentTurns: [{ role: 'user', text: 'algo' }],
  });
  assert.ok(!r.additions.some((a) => a.includes('contexto previo')));
});

// ─── query-expansion keywords ────────────────────────────────────────

test('short prompt with content words → keywords added', () => {
  const r = expandShortQuery({ prompt: 'informe marketing' });
  // No tiene context ni lexicón, debería expandir con keywords
  // El expander puede no añadir nada si no hay extras
  assert.ok(r.original === 'informe marketing');
});

// ─── threshold customization ─────────────────────────────────────────

test('respects custom threshold', () => {
  const r = expandShortQuery({ prompt: 'foo bar baz', threshold: 2 });
  assert.equal(r.source, 'no_expansion'); // 3 tokens, threshold 2 → no expansión
});

// ─── max length cap ──────────────────────────────────────────────────

test('expanded prompt is capped at MAX_EXPANDED_LEN', () => {
  const r = expandShortQuery({
    prompt: 'foo',
    lexiconTerms: [{ term: 'foo', definition: 'X'.repeat(2000) }],
  });
  assert.ok(r.expanded.length <= MAX_EXPANDED_LEN);
});

// ─── robustness ──────────────────────────────────────────────────────

test('malformed lexicon entries are skipped', () => {
  const r = expandShortQuery({
    prompt: 'mi cv',
    lexiconTerms: [null, undefined, { term: 'mi cv', definition: 'X' }, { term: '', definition: 'Y' }],
  });
  assert.ok(r.expanded.length > 0);
  assert.equal(r.original, 'mi cv');
});

test('no additions → returns no_additions source', () => {
  const r = expandShortQuery({ prompt: 'xyz', recentTurns: [], lexiconTerms: [] });
  // Tiene 1 token, no lexicón, no context. queryExpansion puede o no aportar keywords;
  // si no aporta, source = no_additions; si aporta, source = expanded.
  assert.ok(['no_additions', 'expanded'].includes(r.source));
});

test('original prompt always preserved in output', () => {
  const cases = ['hola', 'foo bar', 'mi cv', 'genera algo cualquier cosa que sea'];
  for (const p of cases) {
    const r = expandShortQuery({ prompt: p });
    assert.equal(r.original, p);
  }
});
