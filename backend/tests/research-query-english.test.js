'use strict';

// Prod 2026-09-27: «busca papers sobre telemedicina en arxiv» reached arXiv as
// «telemedicina» (the planner read the accentless request as English and had
// no lexicon entry) and arXiv, which only indexes English, returned one
// off-topic record. «telemedicine» returns ten.

const test = require('node:test');
const assert = require('node:assert/strict');
const qi = require('../src/services/research/research-query-intelligence');
const { runAgenticBatch } = require('../src/services/searchBrain/agenticBatch');

test('accentless Spanish requests are Spanish', () => {
  for (const text of ['busca papers sobre telemedicina', 'telemedicina rural en el peru', 'estudios que comparan dos metodos']) {
    assert.equal(qi.detectLanguage(text), 'es', text);
  }
  for (const text of ['federated learning for privacy in hospitals', 'the impact of telehealth on rural care']) {
    assert.equal(qi.detectLanguage(text), 'en', text);
  }
});

test('a Spanish topic gets an English-only query variant', () => {
  for (const [text, english] of [
    ['busca papers sobre telemedicina', 'telemedicine'],
    ['telemedicina rural en el Perú', 'telemedicine rural peru'],
    ['salud mental en adolescentes', 'mental health adolescents'],
    ['calidad de vida en universidades', 'quality of life universities'],
    ['prevalencia de obesidad infantil', 'obesity children prevalence'],
    ['investigacion cualitativa sobre violencia de genero', 'gender violence research qualitative'],
  ]) {
    const plan = qi.analyzeQuery(text, { maxQueries: 3 });
    assert.equal(plan.englishQuery, english, text);
    assert.ok(plan.searchQueries.includes(english), `${text}: ${plan.searchQueries.join(' | ')}`);
    assert.ok(plan.searchQueries[0].length > 0 && plan.searchQueries.length <= 3);
  }
  assert.equal(qi.analyzeQuery('the impact of telehealth on rural care').englishQuery, null);
});

test('suffix rules translate productive Latin endings and leave the rest', () => {
  const { suffixToEnglish } = qi._internal;
  for (const [es, en] of [['educacion', 'education'], ['intervenciones', 'interventions'], ['universidad', 'university'],
    ['universidades', 'universities'], ['biologia', 'biology'], ['prevalencia', 'prevalence'], ['tolerancia', 'tolerance'],
    ['autismo', 'autism'], ['administrativa', 'administrative'], ['cualitativa', 'qualitative'], ['cuantitativo', 'quantitative'],
    ['rural', 'rural'], ['covid', 'covid']]) {
    assert.equal(suffixToEnglish(es), en, es);
  }
});

async function lanes(query, providers) {
  const calls = [];
  for await (const _event of runAgenticBatch({
    query, providers, target: 10, batchSize: 5, topK: 3, resolveDois: false,
    deps: {
      retrieve: async ({ source, query: laneQuery }) => { calls.push({ source, query: String(laneQuery) }); return []; },
      rerank: async ({ results }) => ({ results, reranked: false }),
      sleep: async () => {},
    },
  })) { /* drain */ }
  return calls;
}

test('English-only indexes search only the English variant; the rest search every variant', async () => {
  const calls = await lanes('telemedicina rural en el Perú', ['arxiv', 'openalex']);
  const arxiv = calls.filter((call) => call.source === 'arxiv').map((call) => call.query);
  const openalex = calls.filter((call) => call.source === 'openalex').map((call) => call.query);
  assert.ok(arxiv.length > 0 && arxiv.every((q) => q === 'telemedicine rural peru'), arxiv.join(' | '));
  assert.ok(openalex.includes('telemedicina rural peru') && openalex.includes('telemedicine rural peru'), openalex.join(' | '));
  const named = await lanes('busca papers sobre telemedicina en arxiv');
  assert.ok(named.length > 0 && named.every((call) => call.source === 'arxiv' && call.query === 'telemedicine'),
    JSON.stringify(named));
});
