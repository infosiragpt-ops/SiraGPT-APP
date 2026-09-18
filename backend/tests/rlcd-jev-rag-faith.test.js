'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rag = require('../src/services/rlcd/jev-rag-filter');
const faith = require('../src/services/rlcd/jev-faithfulness');
const ledger = require('../src/services/rlcd/decision-ledger');

function fakeFetch(body, status = 200) {
  const fn = async (url, init) => {
    fn.calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return { ok: status < 300, status, statusText: '', headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  fn.calls = [];
  return fn;
}
const ENV = { TYPESAFE_API_KEY: 'k' };
const legend = { 0: rag.LEVELS[0], 1: rag.LEVELS[1], 2: rag.LEVELS[2] };
const score = (p0, p1, p2) => ({ type: 'score', score: p1 + 2 * p2, legend, probabilities: { 0: p0, 1: p1, 2: p2 }, confidence: Math.max(p0, p1, p2) });

test.beforeEach(() => ledger.reset());

test('rag filter: one fan-out per hit, drops irrelevant, keeps ≥2, essential first, records rag_filter', async () => {
  const hits = [
    { title: 'A', source: 'a.pdf', text: 'ruido', score: 0.9 },
    { title: 'B', source: 'b.pdf', text: 'contexto', score: 0.8 },
    { title: 'C', source: 'c.pdf', text: 'la clave', score: 0.7 },
    { title: 'D', source: 'd.pdf', text: 'más ruido', score: 0.6 },
  ];
  const fetchImpl = fakeFetch({ model: 'jev-1.13.0', answers: { s1: score(0.9, 0.08, 0.02), s2: score(0.2, 0.6, 0.2), s3: score(0.02, 0.1, 0.88), s4: score(0.85, 0.1, 0.05) }, usage: {} });
  const out = await rag.filterHits({ query: '¿cuál es la clave?', hits, chatId: 'c1', env: ENV, fetchImpl, ledger });
  assert.equal(out.dropped, 2);
  assert.deepEqual(out.hits.map((h) => h.title), ['C', 'B']);
  const body = fetchImpl.calls[0].body;
  assert.equal(Object.keys(body.questions).length, 4);
  assert.equal(body.state.fragmentos[2].id, 'S3');
  assert.equal(ledger.getDecision(out.decisionId).kind, 'rag_filter');
  assert.equal(ledger.getDecision(out.decisionId).choice, 'drop:2');

  // everything irrelevant → still keeps the two least-irrelevant
  const allBad = fakeFetch({ model: 'jev-1.13.0', answers: { s1: score(0.95, 0.03, 0.02), s2: score(0.9, 0.08, 0.02), s3: score(0.85, 0.1, 0.05), s4: score(0.99, 0.01, 0) }, usage: {} });
  const o2 = await rag.filterHits({ query: 'x', hits, env: ENV, fetchImpl: allBad, ledger });
  assert.equal(o2.hits.length, 2);
  assert.deepEqual(o2.hits.map((h) => h.title), ['C', 'B']);

  assert.equal(await rag.filterHits({ query: 'x', hits: hits.slice(0, 2), env: ENV, fetchImpl }), null, 'needs ≥3 hits');
  assert.equal(await rag.filterHits({ query: 'x', hits, env: { ...ENV, SIRAGPT_RLCD_JEV_RAG_FILTER: '0' }, fetchImpl }), null);
  assert.equal(await rag.filterHits({ query: 'x', hits, env: ENV, fetchImpl: fakeFetch({ e: 1 }, 500) }), null, 'fail-open');
});

test('faithfulness: verdict high / low / unclear, outcomes, footer language, trims sources', async () => {
  const answer = 'La política de reembolsos cubre cargos duplicados en un plazo de 30 días según el documento adjunto, y el importe fue de 49 USD.';
  const sources = [{ kind: 'rag_evidence', text: 'Duplicate charges are eligible for a refund within 30 days. Charge: 49 USD.' }];
  const high = fakeFetch({ model: 'jev-1.13.0', answers: { supported: { type: 'noul', noul: 0.92 }, invented_citation: { type: 'noul', noul: 0.05 }, coverage: { type: 'score', score: 1.8, legend: { 0: 'a', 1: 'b', 2: 'c' }, probabilities: { 0: 0.05, 1: 0.1, 2: 0.85 }, confidence: 0.8 } }, usage: {} });
  const h = await faith.checkAnswer({ question: '¿me devuelven el cargo?', answer, sources, env: ENV, fetchImpl: high });
  assert.equal(h.verdict, 'high');
  assert.equal(h.outcome, 'high_faithfulness');
  assert.equal(h.footer, null);
  assert.equal(high.calls[0].body.state.fuentes[0].tipo, 'rag_evidence');

  const low = fakeFetch({ model: 'jev-1.13.0', answers: { supported: { type: 'noul', noul: 0.2 }, invented_citation: { type: 'noul', noul: 0.7 } }, usage: {} });
  const l = await faith.checkAnswer({ question: 'q', answer, sources, language: 'en', env: ENV, fetchImpl: low });
  assert.equal(l.verdict, 'low');
  assert.equal(l.outcome, 'low_faithfulness');
  assert.match(l.footer, /Grounding check/);
  const lEs = await faith.checkAnswer({ question: 'q', answer, sources, language: 'es', env: ENV, fetchImpl: low });
  assert.match(lEs.footer, /Comprobación de fuentes/);

  const mid = fakeFetch({ model: 'jev-1.13.0', answers: { supported: { type: 'noul', noul: 0.6 }, invented_citation: { type: 'noul', noul: 0.3 } }, usage: {} });
  const m = await faith.checkAnswer({ question: 'q', answer, sources, env: ENV, fetchImpl: mid });
  assert.equal(m.verdict, 'unclear');
  assert.equal(m.outcome, null);

  assert.equal(await faith.checkAnswer({ question: 'q', answer: 'corto', sources, env: ENV, fetchImpl: high }), null);
  assert.equal(await faith.checkAnswer({ question: 'q', answer, sources: [], env: ENV, fetchImpl: high }), null);
  const trimmed = faith.trimSources([{ kind: 'file', text: 'x'.repeat(10000) }, { kind: 'web', text: 'y'.repeat(10000) }]);
  assert.ok(trimmed.reduce((a, s) => a + s.texto.length, 0) <= faith.MAX_SOURCE_CHARS);
});

test('wiring: route filters hits after rerank and checks the answer after the heuristic gate; kinds/events registered', () => {
  const ai = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
  const rerankAt = ai.indexOf("generateLog.warnError('rag.rerank_failed', rerankErr);");
  const filterAt = ai.indexOf('ragFilter.filterHits({');
  const evidenceAt = ai.indexOf('const evidenceBlock = operationalRagContext?.contextBlock');
  assert.ok(rerankAt > 0 && filterAt > rerankAt && evidenceAt > filterAt, 'filter runs after rerank and before the evidence block is rendered');
  assert.match(ai, /operationalRag\.buildEvidenceBlock\(\{/);
  assert.match(ai, /jevFaith\.checkAnswer\(\{ question: prompt, answer: fullResponseContent/);
  assert.match(ai, /source: 'jev_faithfulness'/);
  assert.match(ai, /__jf\.verdict === 'low' && __jf\.footer && __faith\.action !== 'annotate'/);
  assert.ok(ledger.DECISION_KINDS.includes('rag_filter'));
  const obs = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'ai', 'generate-request-observability.js'), 'utf8');
  for (const ev of ['rlcd.rag_filtered', 'rlcd.jev_faithfulness']) assert.ok(obs.includes(`'${ev}',`), ev);
  const cfg = require('../src/services/rlcd/config').describe({});
  assert.ok(cfg.kinds.rag_filter && cfg.thresholds.jevRagDrop && cfg.thresholds.jevFaithHigh && cfg.flags.jevRagFilter && cfg.flags.jevFaithfulness);
  const ops = require('../src/services/rag/operational-runtime');
  assert.equal(typeof ops.buildEvidenceBlock, 'function');
});
