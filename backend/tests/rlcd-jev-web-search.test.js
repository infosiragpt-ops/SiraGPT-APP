'use strict';

/**
 * RLCD × Jev — búsquedas web.
 *   1. El juez de turno decide si buscar, en qué fuente y con qué frescura
 *      (misma llamada fan-out; sin coste extra).
 *   2. applyTurnJudgement → force / suggest / tool / freshness con umbrales y
 *      flag; el ledger registra `web_search_intent`; la lane se fuerza a
 *      agéntica cuando la web es imprescindible.
 *   3. El filtro de resultados puntúa cada hit, descarta los irrelevantes,
 *      pone el esencial primero y registra `web_search_filter`.
 *   4. Cableado: web_search tool, agentic loop (initialToolChoice + freshness
 *      por defecto + guía), ai.js y catálogo de observabilidad.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const judge = require('../src/services/rlcd/jev-turn-judge');
const webFilter = require('../src/services/rlcd/jev-web-filter');
const ledger = require('../src/services/rlcd/decision-ledger');

const ENV = { TYPESAFE_API_KEY: 'k' };

function fakeFetch(body, status = 200) {
  const fn = async (url, init) => {
    fn.calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return { ok: status < 300, status, statusText: '', headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  fn.calls = [];
  return fn;
}

function answer({ lane = 'chat_only', laneP = 0.8, need = 'no_web', needP = 0.8, source = 'general', fresh = 'any' } = {}) {
  const laneProbs = { chat_only: 0.05, tools_agent: 0.05, generate_media: 0.02, edit_document: 0.02, create_document: 0.02, clarify: 0.04 };
  laneProbs[lane] = laneP;
  const needProbs = { no_web: 0.05, web_recommended: 0.05, web_required: 0.05 };
  needProbs[need] = needP;
  return {
    model: 'jev-1.13.0',
    usage: { input_tokens: 200, output_tokens: 0 },
    answers: {
      lane: { type: 'choice', choice: lane, probabilities: laneProbs, confidence: laneP },
      needs_context: { type: 'noul', noul: 0.1 },
      depth: { type: 'score', score: 1.2, legend: Object.fromEntries(judge.DEPTH_LEVELS.map((l, i) => [String(i), l])), probabilities: { 0: 0.1, 1: 0.7, 2: 0.2, 3: 0, 4: 0 }, confidence: 0.7 },
      model_family: { type: 'choice', choice: 'balanced', probabilities: { balanced: 0.8, fast_cheap: 0.1 }, confidence: 0.75 },
      web_need: { type: 'choice', choice: need, probabilities: needProbs, confidence: needP },
      web_source: { type: 'choice', choice: source, probabilities: { [source]: 0.7, general: 0.2 }, confidence: 0.7 },
      web_freshness: { type: 'choice', choice: fresh, probabilities: { [fresh]: 0.7, any: 0.2 }, confidence: 0.7 },
    },
  };
}

test('buildQuestions asks whether/where/how fresh to search, with the documented criteria', () => {
  const q = judge.buildQuestions({});
  assert.deepEqual(Object.keys(q.web_need.criteria), ['no_web', 'web_recommended', 'web_required']);
  assert.deepEqual(Object.keys(q.web_source.criteria), ['general', 'news', 'academic', 'social', 'code']);
  assert.deepEqual(Object.keys(q.web_freshness.criteria), ['any', 'day', 'week', 'month', 'year']);
  assert.deepEqual(judge.WEB_SOURCE_TOOL, { general: 'web_search', news: 'web_search', academic: 'scientific_search', social: 'x_search', code: 'github_search' });
  assert.deepEqual(judge.WEB_FRESHNESS_PARAM, { day: 'pd', week: 'pw', month: 'pm', year: 'py' });
});

test('judgeTurn parses the web answers in the same fan-out; missing answers → webSearch null', async () => {
  const fetchImpl = fakeFetch(answer({ need: 'web_required', needP: 0.9, source: 'news', fresh: 'week' }));
  const j = await judge.judgeTurn({ text: '¿qué pasó hoy con el precio del dólar?', env: ENV, fetchImpl });
  assert.equal(fetchImpl.calls.length, 1, 'one call for every question');
  assert.deepEqual(j.webSearch, {
    need: 'web_required', probability: 0.9, probabilities: { no_web: 0.05, web_recommended: 0.05, web_required: 0.9 }, confidence: 0.9,
    source: 'news', sourceProbability: 0.7, freshness: 'week', freshnessProbability: 0.7,
  });
  const legacy = answer(); delete legacy.answers.web_need; delete legacy.answers.web_source; delete legacy.answers.web_freshness;
  const j2 = await judge.judgeTurn({ text: 'hola', env: ENV, fetchImpl: fakeFetch(legacy) });
  assert.equal(j2.webSearch, null);
});

test('applyTurnJudgement: required+confident → force with the source tool and freshness; recommended → suggest; no_web → nothing; flag off → advisory', async () => {
  const env = ENV;
  const req = await judge.judgeTurn({ text: 'x', env, fetchImpl: fakeFetch(answer({ need: 'web_required', needP: 0.9, source: 'academic', fresh: 'year' })) });
  const a = judge.applyTurnJudgement(req, { env });
  assert.equal(a.webSearch.force, true); assert.equal(a.webSearch.suggest, true);
  assert.equal(a.webSearch.tool, 'scientific_search'); assert.equal(a.webSearch.freshness, 'py');
  assert.ok(a.raw.webSearch > 0.9 && a.calibrated.webSearch > 0.9);

  const rec = await judge.judgeTurn({ text: 'x', env, fetchImpl: fakeFetch(answer({ need: 'web_recommended', needP: 0.6, source: 'social', fresh: 'day' })) });
  const b = judge.applyTurnJudgement(rec, { env });
  assert.equal(b.webSearch.force, false); assert.equal(b.webSearch.suggest, true);
  assert.equal(b.webSearch.tool, 'x_search'); assert.equal(b.webSearch.freshness, 'pd');

  const weak = await judge.judgeTurn({ text: 'x', env, fetchImpl: fakeFetch(answer({ need: 'web_required', needP: 0.6 })) });
  assert.equal(judge.applyTurnJudgement(weak, { env }).webSearch.force, false, 'p(required)=0.6 < 0.75 → no force');

  const none = await judge.judgeTurn({ text: 'x', env, fetchImpl: fakeFetch(answer({ need: 'no_web', needP: 0.9 })) });
  const c = judge.applyTurnJudgement(none, { env });
  assert.equal(c.webSearch.need, 'no_web'); assert.equal(c.webSearch.force, false); assert.equal(c.webSearch.suggest, false);
  assert.equal(c.webSearch.freshness, null); assert.equal(c.webSearch.tool, 'web_search');

  const off = judge.applyTurnJudgement(req, { env: { ...env, SIRAGPT_RLCD_JEV_WEB_SEARCH: '0' } });
  assert.equal(off.webSearch.force, false); assert.equal(off.webSearch.suggest, false);
});

test('rlcd.judgeTurnWithJev records web_search_intent and applyJevLane forces the agentic lane when the web is required', async () => {
  const rlcd = require('../src/services/rlcd');
  rlcd.ledger.reset();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(answer({ lane: 'chat_only', laneP: 0.8, need: 'web_required', needP: 0.9, source: 'general', fresh: 'week' }));
  try {
    const judged = await rlcd.judgeTurnWithJev({ chatId: 'c1', text: '¿cuál es la última versión de Node?', env: ENV });
    assert.ok(judged);
    const kinds = judged.decisionIds.map((id) => rlcd.ledger.getDecision(id).kind);
    assert.ok(kinds.includes('web_search_intent'), kinds.join(','));
    const web = rlcd.ledger.getDecision(judged.decisionIds.find((id) => rlcd.ledger.getDecision(id).kind === 'web_search_intent'));
    assert.equal(web.choice, 'web_required:force:general');
    assert.equal(web.meta.freshness, 'pw');
    const lane = { agentic: false, forced: false };
    const id = rlcd.applyJevLane(lane, judged, { heuristicAgentic: false, chatId: 'c1', env: ENV });
    assert.ok(id);
    assert.equal(lane.agentic, true); assert.equal(lane.reason, 'jev_web');
    assert.equal(rlcd.ledger.getDecision(id).choice, 'force_agentic_web:chat_only');
    assert.ok(ledger.DECISION_KINDS.includes('web_search_intent') && ledger.DECISION_KINDS.includes('web_search_filter'));
  } finally {
    globalThis.fetch = prevFetch;
    rlcd.ledger.reset();
  }
});

test('web filter: one fan-out per hit, drops irrelevant, keeps ≥2, essential first, records web_search_filter, fail-open', async () => {
  const results = [
    { title: 'Spam SEO', url: 'https://spam.example/a', snippet: 'compra ahora', source: 'ddg' },
    { title: 'Node.js releases', url: 'https://nodejs.org/en/about/previous-releases', snippet: 'Node.js 24 is Current', source: 'brave' },
    { title: 'Foro viejo', url: 'https://forum.example/x', snippet: 'node 10 problemas', source: 'ddg' },
    { title: 'Blog sobre versiones', url: 'https://blog.example/node', snippet: 'resumen de versiones de Node', source: 'ddg' },
  ];
  const legend = { 0: webFilter.LEVELS[0], 1: webFilter.LEVELS[1], 2: webFilter.LEVELS[2] };
  const body = { model: 'jev-1.13.0', usage: {}, answers: {
    r1: { type: 'score', score: 0.1, legend, probabilities: { 0: 0.92, 1: 0.05, 2: 0.03 }, confidence: 0.9 },
    r2: { type: 'score', score: 1.9, legend, probabilities: { 0: 0.02, 1: 0.1, 2: 0.88 }, confidence: 0.9 },
    r3: { type: 'score', score: 0.2, legend, probabilities: { 0: 0.85, 1: 0.1, 2: 0.05 }, confidence: 0.8 },
    r4: { type: 'score', score: 1.1, legend, probabilities: { 0: 0.1, 1: 0.7, 2: 0.2 }, confidence: 0.7 },
  } };
  ledger.reset();
  const fetchImpl = fakeFetch(body);
  const out = await webFilter.filterResults({ query: 'última versión de Node', results, chatId: 'c9', env: ENV, fetchImpl, ledger });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(Object.keys(fetchImpl.calls[0].body.questions).length, 4);
  assert.equal(fetchImpl.calls[0].body.state.resultados[1].id, 'R2');
  assert.deepEqual(out.results.map((r) => r.title), ['Node.js releases', 'Blog sobre versiones']);
  assert.equal(out.dropped, 2);
  assert.ok(out.results[0].jevRelevance > out.results[1].jevRelevance);
  assert.equal(ledger.getDecision(out.decisionId).kind, 'web_search_filter');
  assert.equal(ledger.getDecision(out.decisionId).choice, 'drop:2');
  // fewer than 3 hits or the flag off → untouched (null)
  assert.equal(await webFilter.filterResults({ query: 'q', results: results.slice(0, 2), env: ENV, fetchImpl }), null);
  assert.equal(await webFilter.filterResults({ query: 'q', results, env: { ...ENV, SIRAGPT_RLCD_JEV_WEB_FILTER: '0' }, fetchImpl }), null);
  // provider error → null (caller keeps the original order)
  assert.equal(await webFilter.filterResults({ query: 'q', results, env: ENV, fetchImpl: fakeFetch({ error: 'x' }, 500) }), null);
  ledger.reset();
});

test('wiring: web_search tool applies the filter, the agentic loop honours the judgement, ai.js passes it, catalog + config know the new kinds', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const tools = read('src/services/agents/agent-tools.js');
  assert.match(tools, /require\('\.\.\/rlcd\/jev-web-filter'\)/);
  assert.match(tools, /webFilter\.filterResults\(\{ query, results, chatId: args\?\.chatId \|\| null, ledger: rlcd\.ledger \}\)/);
  assert.match(tools, /\.\.\.\(jev \? \{ jev \} : \{\}\),/);
  const stream = read('src/services/agentic-chat-stream.js');
  assert.match(stream, /webSearchIntent = null,/);
  assert.match(stream, /const jevWebTool = webSearchIntent && webSearchIntent\.force && availableToolNames\.has\(webSearchIntent\.tool\) \? webSearchIntent\.tool : null;/);
  assert.match(stream, /if \(!initialToolChoice && jevWebTool\) initialToolChoice = jevWebTool;/);
  assert.match(stream, /freshness: \(args && args\.freshness\) \|\| webSearchIntent\.freshness/);
  assert.match(stream, /Jev \(juez de turno\) estima que esta petición necesita fuentes actuales/);
  const ai = read('src/routes/ai.js');
  assert.match(ai, /req\._rlcdWebSearch = __a\.webSearch;/);
  assert.match(ai, /generateLog\.info\('rlcd\.web_search_judged'/);
  assert.match(ai, /webSearchIntent: req\._rlcdWebSearch \|\| null,/);
  const obs = read('src/services/ai/generate-request-observability.js');
  for (const ev of ['rlcd.web_search_judged', 'rlcd.web_filtered']) assert.ok(obs.includes(`'${ev}',`), ev);
  const cfg = require('../src/services/rlcd/config').describe(ENV);
  assert.ok(cfg.kinds.web_search_intent && cfg.kinds.web_search_filter);
  assert.ok(cfg.flags.jevWebSearch.value && cfg.flags.jevWebFilter.value);
  assert.equal(cfg.thresholds.jevWebForce.value, 0.75); assert.equal(cfg.thresholds.jevWebSuggest.value, 0.5); assert.equal(cfg.thresholds.jevWebDrop.value, 0.8);
});
