'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const typesafe = require('../src/services/providers/typesafe');
const chat = require('../src/services/typesafe-decision-chat');

const ENV = { TYPESAFE_API_KEY: 'ts-test-key', TYPESAFE_RETRIES: '1' };

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    const r = await handler(calls.length, url, init);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: r.statusText || '',
      headers: { get: (k) => (r.headers || {})[k.toLowerCase()] || null },
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    };
  };
  fn.calls = calls;
  return fn;
}

test('model ids: catalog ↔ API mapping and detection', () => {
  assert.equal(typesafe.toApiModel('typesafe/jev-latest'), 'jev-latest');
  assert.equal(typesafe.toApiModel('~typesafe/jev-latest'), 'jev-latest');
  assert.equal(typesafe.toApiModel('typesafe/jev-1.13'), 'jev-1.13.0');
  assert.equal(typesafe.toApiModel('jev-1.14'), 'jev-1.14.0');
  assert.equal(typesafe.toApiModel('typesafe/jev-preview'), 'jev-preview');
  assert.equal(typesafe.toCatalogId('jev-1.13.0'), 'typesafe/jev-1.13');
  assert.equal(typesafe.toCatalogId('jev-latest'), 'typesafe/jev-latest');
  assert.equal(typesafe.isTypeSafeModel('typesafe/jev-latest'), true);
  assert.equal(typesafe.isTypeSafeModel('jev-1.13.0'), true);
  assert.equal(typesafe.isTypeSafeModel('gpt-5.1'), false);
  assert.equal(typesafe.isTypeSafeModel('anthropic/claude-jevous'), false);
  assert.equal(typesafe.TYPESAFE_MODELS.map((m) => m.id).join(','), 'typesafe/jev-latest,typesafe/jev-1.13');
});

test('isConfigured reads TYPESAFE_API_KEY only', () => {
  assert.equal(typesafe.isConfigured({}), false);
  assert.equal(typesafe.isConfigured({ TYPESAFE_API_KEY: '  ' }), false);
  assert.equal(typesafe.isConfigured({ TYPESAFE_API_KEY: 'k' }), true);
});

test('validateQuestions enforces the System One schema locally', () => {
  assert.throws(() => typesafe.validateQuestions({}), /at least one/);
  assert.throws(() => typesafe.validateQuestions({ a: { type: 'poem', instructions: 'x' } }), /unknown type/);
  assert.throws(() => typesafe.validateQuestions({ a: { type: 'choice', instructions: 'x', criteria: { only: null } } }), /at least two/);
  assert.throws(() => typesafe.validateQuestions({ a: { type: 'score', instructions: 'x', criteria: ['one'] } }), /at least two levels/);
  const ok = typesafe.validateQuestions({
    n: { type: 'NOUL', instructions: 'yes?' },
    c: { type: 'choice', instructions: 'pick', criteria: { a: null, b: 'bee' } },
    s: { type: 'score', instructions: 'rate', criteria: ['low', 'high'], extra: 'dropped' },
  });
  assert.equal(ok.n.type, 'noul');
  assert.equal(ok.s.extra, undefined);
});

test('evaluate posts to /v1/systemone with the mapped model and returns answers + usage', async () => {
  const fetchImpl = fakeFetch(async () => ({
    status: 200,
    body: {
      model: 'jev-1.13.0',
      answers: { is_urgent: { type: 'noul', noul: 0.92 } },
      usage: { input_tokens: 312, output_tokens: 48 },
    },
  }));
  const res = await typesafe.evaluate({
    state: 'Help! My payouts have been failing for 3 days.',
    model: 'typesafe/jev-1.13',
    questions: { is_urgent: { type: 'noul', instructions: 'Does this convey urgency?' } },
    env: ENV,
    fetchImpl,
  });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer ts-test-key');
  assert.equal(fetchImpl.calls[0].body.model, 'jev-1.13.0');
  assert.equal(res.model, 'jev-1.13.0');
  assert.equal(res.answers.is_urgent.noul, 0.92);
  assert.equal(res.usage.input_tokens, 312);
  assert.ok(res.latencyMs >= 0);
});

test('evaluate retries 429/529 with backoff and surfaces typed errors', async () => {
  const fetchImpl = fakeFetch(async (n) => (n === 1
    ? { status: 529, body: { error: 'overloaded' }, headers: { 'retry-after': '0' } }
    : { status: 200, body: { model: 'jev-1.13.0', answers: {}, usage: {} } }));
  const res = await typesafe.evaluate({ state: 'x', questions: { q: { type: 'noul', instructions: '?' } }, env: ENV, fetchImpl });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(res.model, 'jev-1.13.0');

  const unauthorized = fakeFetch(async () => ({ status: 401, body: { message: 'bad key' } }));
  await assert.rejects(
    () => typesafe.evaluate({ state: 'x', questions: { q: { type: 'noul', instructions: '?' } }, env: ENV, fetchImpl: unauthorized }),
    (err) => err.code === 'typesafe_auth' && err.status === 401 && err.retryable === false,
  );
  assert.equal(unauthorized.calls.length, 1, '401 must not retry');

  await assert.rejects(
    () => typesafe.evaluate({ state: 'x', questions: { q: { type: 'noul', instructions: '?' } }, env: {}, fetchImpl }),
    (err) => err.code === 'typesafe_not_configured',
  );
});

test('summarizeAnswer + confidenceBand normalise the three answer types', () => {
  const noul = typesafe.summarizeAnswer({ type: 'noul', noul: 0.9 });
  assert.equal(noul.yes, true);
  assert.ok(Math.abs(noul.confidence - 0.8) < 1e-9);
  const choice = typesafe.summarizeAnswer({ type: 'choice', choice: 'technical', probabilities: { billing: 0.08, technical: 0.85, sales: 0.07 }, confidence: 0.82 });
  assert.equal(choice.value, 'technical');
  assert.equal(choice.ranked[0][0], 'technical');
  assert.ok(Math.abs(choice.margin - 0.77) < 1e-9);
  const score = typesafe.summarizeAnswer({ type: 'score', score: 1.6, legend: { 0: 'Calm', 1: 'Frustrated', 2: 'Very angry' }, probabilities: { 0: 0.05, 1: 0.3, 2: 0.65 }, confidence: 0.78 });
  assert.equal(score.label, 'Very angry');
  assert.ok(Math.abs(score.normalized - 0.8) < 1e-9);
  assert.equal(typesafe.confidenceBand(0.9), 'act');
  assert.equal(typesafe.confidenceBand(0.6), 'confirm');
  assert.equal(typesafe.confidenceBand(0.2), 'escalate');
});

test('decision chat: message shapes map to noul / choice / score / json / fallback', () => {
  const b = (t, o) => chat.buildDecisionRequest(t, o);
  assert.equal(b('¿Es seguro desplegar el viernes?').mode, 'noul');
  assert.equal(b('Should we ship on Friday?').mode, 'noul');
  const enumerated = b('¿Qué framework elijo?\na) Next.js\nb) Remix\nc) Astro');
  assert.equal(enumerated.mode, 'choice');
  assert.deepEqual(Object.keys(enumerated.questions.decision.criteria), ['Next.js', 'Remix', 'Astro', 'ninguna de las anteriores']);
  assert.equal(enumerated.questions.decision.instructions, '¿Qué framework elijo?');
  const labelled = b('opciones: comprar, alquilar, esperar\n¿Qué hago con el piso?');
  assert.equal(labelled.mode, 'choice');
  assert.equal(labelled.questions.decision.instructions, '¿Qué hago con el piso?');
  const inline = b('¿Lanzo la campaña en marzo, abril o mayo?');
  assert.equal(inline.mode, 'choice');
  assert.deepEqual(Object.keys(inline.questions.decision.criteria).slice(0, 3), ['Lanzo la campaña en marzo', 'abril', 'mayo']);
  const score = b('Puntúa del 1 al 5 la claridad de este texto: hola');
  assert.equal(score.mode, 'score');
  assert.deepEqual(score.questions.decision.criteria, ['1', '2', '3', '4', '5']);
  assert.deepEqual(score.scale, { lo: 1, hi: 5 });
  const json = b('Evalúa esto:\n```json\n{"state":"hola","questions":{"u":{"type":"noul","instructions":"urgent?"}},"model":"jev-1.13"}\n```');
  assert.equal(json.mode, 'json');
  assert.equal(json.state, 'hola');
  assert.equal(json.model, 'jev-1.13');
  const longOr = b('¿Debería desplegar la nueva versión el viernes por la tarde o el lunes por la mañana? Somos un equipo de 3 personas.');
  assert.equal(longOr.mode, 'choice');
  assert.deepEqual(Object.keys(longOr.questions.decision.criteria).slice(0, 2), ['Debería desplegar la nueva versión el viernes por la tarde', 'el lunes por la mañana']);
  assert.equal(longOr.questions.decision.instructions, '¿Debería desplegar la nueva versión el viernes por la tarde o el lunes por la mañana?');
  const fb = b('quiero una moto roja');
  assert.equal(fb.mode, 'fallback');
  assert.ok(fb.hint);
  assert.equal(fb.questions.decision.type, 'noul');
});

test('decision chat: history and documents become a structured state', () => {
  const r = chat.buildDecisionRequest('¿Es urgente?', {
    history: [{ role: 'user', content: 'Mi pago falla desde hace 3 días' }, { role: 'assistant', content: 'Lo reviso' }],
    documents: 'Ticket #1',
  });
  assert.equal(r.state.mensaje, '¿Es urgente?');
  assert.equal(r.state.conversacion.length, 2);
  assert.equal(r.state.conversacion[0].de, 'usuario');
  assert.equal(r.state.documentos, 'Ticket #1');
});

test('decision chat: runDecisionTurn renders a card and maps errors to user-facing text', async () => {
  const fetchImpl = fakeFetch(async () => ({
    status: 200,
    body: {
      model: 'jev-1.13.0',
      answers: { decision: { type: 'choice', choice: 'Remix', probabilities: { 'Next.js': 0.2, Remix: 0.7, Astro: 0.1 }, confidence: 0.66 } },
      usage: { input_tokens: 40, output_tokens: 0 },
    },
  }));
  const turn = await chat.runDecisionTurn({ text: '¿Qué framework?\na) Next.js\nb) Remix\nc) Astro', model: 'typesafe/jev-latest', env: ENV, fetchImpl });
  assert.match(turn.text, /Decisión Jev · `jev-1.13.0`/);
  assert.match(turn.text, /\*\*Remix\*\* · confianza 0\.66 · recomendación: confirmar antes de actuar/);
  assert.match(turn.text, /\| Remix \| 70 % \|/);
  assert.equal(turn.usage.promptTokens, 40);

  const missing = await chat.runDecisionTurn({ text: '¿Es urgente?', env: {}, fetchImpl });
  assert.match(missing.text, /Jev no está configurado/);
  assert.equal(missing.error.code, 'typesafe_not_configured');
});
