/**
 * Tests for query-intelligence (stemming + synonyms + expansion + language
 * detection) and the stem/synonym-aware relevance matching it powers (v3).
 *
 * These guard the "100x" quality leap: results are now matched semantically,
 * so "IA" finds "inteligencia artificial" and "investigación" finds
 * "investigaciones" — without embeddings or an LLM call.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const qi = require('../src/services/agents/web-search/query-intelligence');
const relevance = require('../src/services/agents/web-search/relevance');
const webSearch = require('../src/services/agents/web-search');
const auditLog = require('../src/services/agents/audit-log');

// ── language detection ───────────────────────────────────────────────

test('detectLanguage distinguishes Spanish, English and ambiguous', () => {
  assert.equal(qi.detectLanguage('¿Qué noticias hay hoy sobre la economía?'), 'es');
  assert.equal(qi.detectLanguage('What is the latest news about the economy?'), 'en');
  assert.equal(qi.detectLanguage(''), 'und');
});

// ── stemming ─────────────────────────────────────────────────────────

test('stem collapses Spanish + English inflections', () => {
  assert.equal(qi.stem('investigaciones'), qi.stem('investigación'));
  assert.equal(qi.stem('transformers'), qi.stem('transformer'));
  // never over-truncates short words
  assert.equal(qi.stem('ia'), 'ia');
});

// ── synonym / acronym expansion ──────────────────────────────────────

test('expandTerm bridges acronyms and ES↔EN synonyms', () => {
  const ia = qi.expandTerm('ia');
  assert.ok(ia.has('inteligencia'));
  assert.ok(ia.has('artificial'));
  assert.ok(ia.has('ai'));
  const coche = qi.expandTerm('coche');
  assert.ok(coche.has('car') || coche.has('automovil'));
});

test('expandTerms detects synonym 2-grams (machine learning → ml)', () => {
  const set = qi.expandTerms(['machine', 'learning']);
  assert.ok(set.has('ml'));
});

test('queryVariants keeps the original and adds a synonym-substituted variant', () => {
  const variants = qi.queryVariants('precio ia');
  assert.ok(variants.includes('precio ia'));
  assert.ok(variants.some((v) => v.includes('inteligencia artificial')));
});

// ── semantic relevance matching (v3) ─────────────────────────────────

test('scoreResult matches a synonym ("IA" ↔ "inteligencia artificial")', () => {
  const r = { title: 'La inteligencia artificial avanza en 2026', url: 'https://x.test/a', snippet: '' };
  assert.ok(relevance.scoreResult('ia', r) > 0, 'synonym should count as a match');
});

test('scoreResult matches an inflected stem ("investigación" ↔ "investigaciones")', () => {
  const r = { title: 'Investigaciones recientes sobre el cancer de mama', url: 'https://x.test/b', snippet: 'estudio' };
  assert.ok(relevance.scoreResult('investigacion cancer', r) > 0);
});

test('scoreResult still returns 0 for genuinely unrelated content', () => {
  const r = { title: 'Receta de pasta con queso', url: 'https://x.test/c', snippet: 'cocina italiana' };
  assert.equal(relevance.scoreResult('inteligencia artificial', r), 0);
});

// ── searchMany end-to-end semantic recall ────────────────────────────

const originalAudit = auditLog.audit;
beforeEach(() => { webSearch.resetProviders(); webSearch.clearCache(); auditLog.audit = () => {}; });
afterEach(() => { auditLog.audit = originalAudit; webSearch.resetProviders(); webSearch.clearCache(); });

test('searchMany surfaces a synonym result that literal matching would drop', async () => {
  webSearch.setProviders([
    { id: 'duckduckgo', name: 'duckduckgo', priority: 10, enabled: true,
      async search() {
        return [
          { title: 'Inteligencia artificial: avances recientes', url: 'https://a.test/ai', snippet: 'modelos' },
          { title: 'Receta de cocina', url: 'https://a.test/food', snippet: 'pasta' },
        ];
      } },
  ]);
  const out = await webSearch.searchMany('IA avances', { maxResults: 10 });
  const urls = out.results.map((r) => r.url);
  assert.ok(urls.includes('https://a.test/ai'), 'synonym result should be kept');
  assert.ok(!urls.includes('https://a.test/food'), 'unrelated result should be dropped');
});

test('searchMany fan-out runs synonym-expanded query variants when enabled', async () => {
  const queriesSeen = [];
  webSearch.setProviders([
    { id: 'duckduckgo', name: 'duckduckgo', priority: 10, enabled: true,
      async search(qstr) {
        queriesSeen.push(qstr);
        return [{ title: `result for ${qstr}`, url: `https://a.test/${encodeURIComponent(qstr)}`, snippet: 'ia inteligencia' }];
      } },
  ]);
  await webSearch.searchMany('precio ia', { maxResults: 10, fanout: true });
  assert.ok(queriesSeen.length >= 2, `fan-out should issue multiple query variants, saw ${queriesSeen.length}`);
  assert.ok(queriesSeen.some((s) => s.includes('inteligencia artificial')));
});
