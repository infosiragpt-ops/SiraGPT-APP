'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const judge = require('../src/services/rlcd/jev-turn-judge');
const config = require('../src/services/rlcd/config');

function fakeFetch(body, status = 200) {
  const fn = async (url, init) => {
    fn.calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return { ok: status < 300, status, statusText: '', headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  fn.calls = [];
  return fn;
}

const ENV = { TYPESAFE_API_KEY: 'k' };

function answer({ lane = 'chat_only', laneP = 0.8, needs = 0.1, depth = 1.2, fam = 'balanced', sat } = {}) {
  const laneProbs = { chat_only: 0.05, tools_agent: 0.05, generate_media: 0.02, edit_document: 0.02, create_document: 0.02, clarify: 0.04 };
  laneProbs[lane] = laneP;
  const answers = {
    lane: { type: 'choice', choice: lane, probabilities: laneProbs, confidence: laneP },
    needs_context: { type: 'noul', noul: needs },
    depth: { type: 'score', score: depth, legend: Object.fromEntries(judge.DEPTH_LEVELS.map((l, i) => [String(i), l])), probabilities: { 0: 0.1, 1: 0.7, 2: 0.2, 3: 0, 4: 0 }, confidence: 0.7 },
    model_family: { type: 'choice', choice: fam, probabilities: { [fam]: 0.8, fast_cheap: 0.1 }, confidence: 0.75 },
  };
  if (sat != null) answers.satisfaction = { type: 'noul', noul: sat };
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 200, output_tokens: 0 } };
}

test('buildQuestions: five questions with satisfaction only when a previous answer exists; state is structured', () => {
  const q = judge.buildQuestions({ hasPreviousAnswer: false });
  assert.deepEqual(Object.keys(q), ['lane', 'needs_context', 'depth', 'model_family', 'web_need', 'web_source', 'web_freshness']);
  assert.deepEqual(Object.keys(q.lane.criteria), Object.keys(judge.LANES));
  assert.equal(q.depth.criteria.length, 5);
  assert.ok(judge.buildQuestions({ hasPreviousAnswer: true }).satisfaction);
  const s = judge.buildState({ text: 'hola', history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], previousAnswer: 'b', hasImage: true, fileNames: ['x.png'] });
  assert.equal(s.mensaje_nuevo, 'hola');
  assert.equal(s.adjuntos.imagenes, true);
  assert.deepEqual(s.adjuntos.nombres, ['x.png']);
  assert.equal(s.conversacion_previa.length, 2);
  assert.equal(s.respuesta_anterior_del_asistente, 'b');
});

test('judgeTurn: posts one fan-out request and normalises every answer; fails open', async () => {
  const fetchImpl = fakeFetch(answer({ lane: 'tools_agent', laneP: 0.85, needs: 0.2, depth: 3.4, fam: 'coding', sat: 0.9 }));
  const j = await judge.judgeTurn({ text: 'clona el repo y dame la web en local', previousAnswer: 'ok', env: ENV, fetchImpl });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].body.model, 'jev-latest');
  assert.ok(fetchImpl.calls[0].body.questions.satisfaction);
  assert.equal(j.lane.choice, 'tools_agent');
  assert.equal(j.depth.label, 'complex');
  assert.equal(j.modelFamily.choice, 'coding');
  assert.equal(j.satisfaction, 0.9);
  assert.equal(j.model, 'jev-1.13.0');
  assert.equal(await judge.judgeTurn({ text: 'x', env: ENV, fetchImpl: fakeFetch({ error: 'x' }, 500) }), null);
  assert.equal(await judge.judgeTurn({ text: '', env: ENV, fetchImpl }), null);
});

test('applyTurnJudgement: force agentic, ask, compute level, satisfaction; respects user picks', () => {
  const env = { ...ENV };
  const ledger = { calibrated: (_k, v) => ({ calibrated: v }) };
  const j1 = { lane: { choice: 'tools_agent', confidence: 0.9, probability: 0.9, probabilities: { tools_agent: 0.9, chat_only: 0.05, clarify: 0.01 } }, needsContext: 0.1, depth: { score: 3.2, normalized: 0.8, label: 'complex', confidence: 0.8 }, modelFamily: { choice: 'coding', confidence: 0.9, probability: 0.9, probabilities: {} }, satisfaction: 0.9 };
  const a1 = judge.applyTurnJudgement(j1, { heuristicAgentic: false, ledger, env });
  assert.equal(a1.forceAgentic, true);
  assert.equal(a1.ask, false);
  assert.equal(a1.computeLevel, 'high');
  assert.equal(a1.satisfaction, 'liked');
  assert.equal(a1.modelFamily.steer, false, 'model steering is off by default');
  assert.equal(judge.applyTurnJudgement(j1, { heuristicAgentic: false, userSetEffort: true, ledger, env }).computeLevel, null);

  const j2 = { lane: { choice: 'clarify', confidence: 0.8, probability: 0.8, probabilities: { clarify: 0.8, generate_media: 0.15, chat_only: 0.05 } }, needsContext: 0.9, depth: { score: 0.2, normalized: 0.05, label: 'trivial', confidence: 0.9 }, modelFamily: null, satisfaction: 0.1 };
  const a2 = judge.applyTurnJudgement(j2, { ledger, env });
  assert.equal(a2.ask, true);
  assert.equal(a2.trivial, true);
  assert.equal(a2.computeLevel, 'minimal');
  assert.equal(a2.satisfaction, 'disliked');
  assert.match(judge.clarifyQuestion(j2), /generarlo/);

  const j3 = { lane: { choice: 'chat_only', confidence: 0.95, probability: 0.95, probabilities: { chat_only: 0.95, tools_agent: 0.02, clarify: 0.01 } }, needsContext: 0.05, depth: null, modelFamily: null, satisfaction: 0.5 };
  const a3 = judge.applyTurnJudgement(j3, { heuristicAgentic: true, heuristicAsk: true, ledger, env });
  assert.equal(a3.vetoAgentic, false, 'lane veto flag is off by default');
  assert.equal(a3.vetoAsk, true, 'confident "nothing missing" vetoes a heuristic ask');
  assert.equal(a3.satisfaction, null, 'ambiguous satisfaction yields no outcome');
  const a3v = judge.applyTurnJudgement(j3, { heuristicAgentic: true, ledger, env: { ...env, SIRAGPT_RLCD_JEV_LANE_VETO: '1' } });
  assert.equal(a3v.vetoAgentic, true);
  assert.equal(judge.applyTurnJudgement(null, {}).lane, null);
});

test('config documents every judge threshold and flag', () => {
  const d = config.describe({});
  for (const k of ['jevLaneForce', 'jevAskThreshold', 'jevNeedsContext', 'jevAskVeto', 'jevDepthConfidence', 'jevModelConfidence', 'jevSatisfied', 'jevDissatisfied']) assert.ok(d.thresholds[k], k);
  for (const k of ['jevJudge', 'jevLaneSteering', 'jevLaneVeto', 'jevTriage', 'jevCompute', 'jevModelSteering', 'jevSatisfaction']) assert.ok(d.flags[k], k);
  assert.equal(d.flags.jevModelSteering.value, false);
});

test('route + service wiring: judge runs before recordTurnDecisions, lane opinion applied, events catalogued', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ai = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
  const judgeAt = ai.indexOf('rlcd.judgeTurnWithJev({');
  const recordAt = ai.indexOf('req._rlcdDecisionIds = rlcd.recordTurnDecisions({');
  assert.ok(judgeAt > 0 && recordAt > judgeAt, 'judge must run before this turn is recorded (satisfaction scores the previous turn)');
  assert.match(ai, /source: 'rlcd_jev', score: __a\.calibrated\.ask/);
  assert.match(ai, /rlcd\.applyJevLane\(__rlcdLane, req\._rlcdJudge/);
  assert.match(ai, /!\(__rlcdLane\.vetoed === true/);
  assert.match(ai, /userPickedModel: String\(model \|\| ''\)\.trim\(\)\.length > 0/);
  assert.match(ai, /userSetEffort: Boolean\(req\.body && req\.body\.reasoningEffort\)/);
  const obs = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'ai', 'generate-request-observability.js'), 'utf8');
  for (const ev of ['rlcd.turn_judged', 'rlcd.jev_ask', 'rlcd.jev_compute', 'rlcd.jev_lane']) assert.ok(obs.includes(`'${ev}',`), ev);
});

test('rlcd.judgeTurnWithJev records jev decisions and the previous-turn satisfaction outcome', async () => {
  const rlcd = require('../src/services/rlcd');
  const ledger = rlcd.ledger;
  ledger.reset();
  const prev = ledger.recordDecision({ kind: 'model_route', choice: 'grok', confidence: 0.8, chatId: 'c1' });
  ledger.markTurn('c1', [prev]);
  const prevFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(answer({ lane: 'clarify', laneP: 0.8, needs: 0.9, depth: 0.1, fam: 'fast_cheap', sat: 0.1 }));
  try {
    const out = await rlcd.judgeTurnWithJev({ chatId: 'c1', text: 'hazlo', previousAnswer: 'Aquí tienes', heuristicAsk: false, env: ENV });
    assert.ok(out);
    assert.equal(out.satisfactionOutcome, 'disliked');
    assert.equal(ledger.getDecision(prev).outcome.label, 'disliked');
    assert.equal(ledger.getDecision(prev).outcome.source, 'jev_satisfaction');
    assert.equal(out.actions.ask, true);
    assert.match(out.question, /concret|detalle|dato/);
    assert.equal(out.decisionIds.length, 3, 'intent_triage + compute_mode + model_route');
    const lane = { agentic: false, forced: false };
    globalThis.fetch = fakeFetch(answer({ lane: 'tools_agent', laneP: 0.9, needs: 0.1 }));
    const judged = await rlcd.judgeTurnWithJev({ chatId: 'c1', text: 'clona el repo', env: ENV });
    const id = rlcd.applyJevLane(lane, judged, { heuristicAgentic: false, chatId: 'c1', env: ENV });
    assert.ok(id);
    assert.equal(lane.forced, true);
    assert.equal(lane.reason, 'jev');
    assert.equal(await rlcd.judgeTurnWithJev({ chatId: 'c1', text: 'x', env: { ...ENV, SIRAGPT_RLCD_JEV_JUDGE: '0' } }), null);
  } finally {
    globalThis.fetch = prevFetch;
    ledger.reset();
  }
});
