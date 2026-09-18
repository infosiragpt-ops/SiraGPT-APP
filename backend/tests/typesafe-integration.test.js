'use strict';

/**
 * TypeSafe Jev — integration contracts:
 *  - provider inference / connection readiness / catalog definitions
 *  - source pins (admin connections, bridge, health, gateway manifest, route)
 *  - catalog rows created from code (no migration)
 *  - RLCD refinement with Jev (fail-open, veto, force)
 *  - agent tool `decide_with_jev`
 *  - aiService.generateStream branches to the decision adapter
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const { inferProviderFromModelId, providerConnectionReady, listKnownProviders } = require('../src/services/ai/provider-inference');
const visible = require('../src/services/visible-model-catalog');
const catalog = require('../src/services/typesafe-catalog');
const jev = require('../src/services/rlcd/jev-decider');
const rlcd = require('../src/services/rlcd');
const { decideWithJevTool } = require('../src/services/agents/typesafe-decision-tool');

function fakeFetch(body, status = 200) {
  const fn = async (url, init) => {
    fn.calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return { ok: status < 300, status, statusText: '', headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  fn.calls = [];
  return fn;
}

test('provider inference: typesafe/jev-* and bare jev ids resolve to TypeSafe', () => {
  assert.equal(inferProviderFromModelId('typesafe/jev-latest'), 'TypeSafe');
  assert.equal(inferProviderFromModelId('typesafe/jev-1.13'), 'TypeSafe');
  assert.equal(inferProviderFromModelId('jev-1.13.0'), 'TypeSafe');
  assert.equal(inferProviderFromModelId('muse-spark-1.2'), 'Meta');
  assert.ok(listKnownProviders().includes('TypeSafe'));
  assert.equal(providerConnectionReady('TypeSafe', {}), false);
  assert.equal(providerConnectionReady('TypeSafe', { TYPESAFE_API_KEY: 'k' }), true);
});

test('visible catalog: Jev definitions surface only with an active DB row, keep TypeSafe routing', () => {
  const defs = visible.VISIBLE_TEXT_MODEL_DEFINITIONS.filter((d) => d.provider === 'TypeSafe');
  assert.deepEqual(defs.map((d) => d.name), ['typesafe/jev-latest', 'typesafe/jev-1.13']);
  assert.ok(defs[0].aliases.includes('~typesafe/jev-latest'));
  assert.equal(visible.curateVisibleTextModels([]).some((m) => m.provider === 'TypeSafe'), false);
  const rows = visible.curateVisibleTextModels([
    { id: 'typesafe-jev-latest', name: 'typesafe/jev-latest', provider: 'OpenRouter', type: 'TEXT', isActive: true },
    { id: 'x', name: 'typesafe/jev-1.13', provider: 'TypeSafe', type: 'TEXT', isActive: false },
  ]);
  const jevRows = rows.filter((m) => /jev/.test(m.name));
  assert.equal(jevRows.length, 1);
  assert.equal(jevRows[0].provider, 'TypeSafe');
  assert.equal(jevRows[0].icon, 'TypeSafeLogo');
  assert.equal(jevRows[0].displayName, 'TypeSafe Jev');
});

test('typesafe-catalog: rows are created once, active, only when the key is configured', async () => {
  catalog.resetForTests();
  const created = [];
  const prisma = {
    aiModel: {
      findMany: async () => [{ name: 'typesafe/jev-1.13' }],
      create: async ({ data }) => { created.push(data); return data; },
    },
  };
  assert.equal((await catalog.ensureTypeSafeCatalogRows(prisma, { env: {} })).reason, 'not_configured');
  const r = await catalog.ensureTypeSafeCatalogRows(prisma, { env: { TYPESAFE_API_KEY: 'k' } });
  assert.deepEqual({ created: r.created, skipped: r.skipped }, { created: 1, skipped: 1 });
  assert.equal(created[0].name, 'typesafe/jev-latest');
  assert.equal(created[0].isActive, true);
  assert.equal(created[0].provider, 'TypeSafe');
  assert.equal(created[0].icon, 'TypeSafeLogo');
  const again = await catalog.ensureTypeSafeCatalogRows(prisma, { env: { TYPESAFE_API_KEY: 'k' } });
  assert.equal(again.reason, 'cached');
  assert.equal(created.length, 1);
});

test('source pins: admin connections, bridge, health, gateway manifest, route audit, agentic gate', () => {
  const adminRoute = read('src/routes/admin-connections.js');
  assert.match(adminRoute, /'typesafe',/);
  assert.match(adminRoute, /typesafe: 'TypeSafe AI API \(Jev, decisiones\)'/);
  const bridge = read('src/services/admin-connections-bridge.js');
  assert.match(bridge, /typesafe: 'TYPESAFE_API_KEY'/);
  assert.match(bridge, /typesafe: 'TypeSafe'/);
  assert.match(bridge, /api\.typesafe\.ai\/v1\/models/);
  const health = read('src/services/observability/health-check.js');
  assert.match(health, /typesafe: providerConnectionReady\('TypeSafe', env\)/);
  const gateway = read('src/services/ai-product-os/litellm-gateway.js');
  assert.match(gateway, /typesafe: \{\s*provider: "typesafe"/);
  assert.match(gateway, /request_format: "typesafe_systemone"/);
  const aiRoute = read('src/routes/ai.js');
  assert.match(aiRoute, /\{ name: 'TypeSafe', envKey: 'TYPESAFE_API_KEY' \}/);
  assert.match(aiRoute, /if \(provider === "TypeSafe"\) \{/);
  assert.match(aiRoute, /&& !\/\^typesafe\$\/i\.test\(String\(actualProvider \|\| ''\)\)/);
  assert.match(aiRoute, /refineMediaIntentWithJev\(req\._rlcdMedia/);
  assert.match(aiRoute, /ensureTypeSafeCatalogRows\(prisma\)/);
  const aiService = read('src/services/ai-service.js');
  assert.match(aiService, /if \(\/\^typesafe\$\/i\.test\(String\(provider \|\| ''\)\)\) \{[\s\S]{0,600}streamTypeSafeDecision\(/);
  const stream = read('src/services/agentic-chat-stream.js');
  assert.match(stream, /decideWithJevTool\];/);
  const selector = read('src/services/agents/tool-selector.js');
  assert.match(selector, /'decide_with_jev'\]\);/);
  const ctx = read('src/services/context-window.js');
  assert.match(ctx, /'typesafe\/jev-latest': 64000/);
  const envDoc = read('../docs/ENV_VARIABLES.md');
  assert.match(envDoc, /TYPESAFE_API_KEY/);
});

test('jev-decider: questions, flag, and merge rules (force / ask / veto)', () => {
  assert.equal(jev.isJevEnabled({}), false);
  assert.equal(jev.isJevEnabled({ TYPESAFE_API_KEY: 'k' }), true);
  assert.equal(jev.isJevEnabled({ TYPESAFE_API_KEY: 'k', SIRAGPT_RLCD_JEV: '0' }), false);
  const q = jev.buildMediaQuestions();
  assert.equal(q.tool.type, 'choice');
  assert.ok(Object.keys(q.tool.criteria).includes('chat_only'));
  assert.equal(q.wants_artifact.type, 'noul');

  const base = { kind: 'image', tool: 'generate_image', action: 'ask', force: false, ask: true, question: 'x', raw: 0.55, calibrated: 0.55, decisionId: 'h1', repaired: true };
  const ledger = { calibrated: (_k, c) => ({ calibrated: c }) };
  const opts = { ledger, forceThreshold: 0.6, askThreshold: 0.35, steering: true, text: 'cre aun aimgen de un gato' };
  const forced = jev.mergeJevDecision(base, { tool: 'generate_image', confidence: 0.9, probability: 0.92, wantsArtifact: 0.95, probabilities: { generate_image: 0.92, chat_only: 0.03 }, model: 'jev-1.13.0', latencyMs: 90 }, opts);
  assert.equal(forced.action, 'force');
  assert.equal(forced.kind, 'image');
  assert.equal(forced.source, 'jev');
  assert.ok(forced.raw > 0.9);
  const vetoed = jev.mergeJevDecision({ ...base, action: 'force', force: true }, { tool: 'chat_only', confidence: 0.85, probability: 0.9, wantsArtifact: 0.05, probabilities: { generate_image: 0.05, chat_only: 0.9 }, model: 'jev-1.13.0', latencyMs: 90 }, { ...opts, text: 'que es una imagen raster' });
  assert.equal(vetoed.action, 'none');
  assert.equal(vetoed.force, false);
  assert.ok(vetoed.raw < 0.35);
  const asked = jev.mergeJevDecision(base, { tool: 'generate_video', confidence: 0.4, probability: 0.45, wantsArtifact: 0.5, probabilities: { generate_video: 0.45, chat_only: 0.4 }, model: 'jev-1.13.0', latencyMs: 90 }, opts);
  assert.equal(asked.action, 'ask');
  assert.equal(asked.kind, 'video');
  assert.match(asked.question, /un vídeo/);
  assert.equal(jev.mergeJevDecision(base, null, opts), base);
});

test('jev-decider: askJevMediaIntent posts a structured state and fails open', async () => {
  const fetchImpl = fakeFetch({
    model: 'jev-1.13.0',
    answers: {
      tool: { type: 'choice', choice: 'generate_image', probabilities: { generate_image: 0.88, chat_only: 0.05 }, confidence: 0.86 },
      wants_artifact: { type: 'noul', noul: 0.93 },
    },
    usage: { input_tokens: 100, output_tokens: 0 },
  });
  const env = { TYPESAFE_API_KEY: 'k' };
  const a = await jev.askJevMediaIntent({ text: 'cre aun aimgen de un gato', env, fetchImpl });
  assert.equal(a.tool, 'generate_image');
  assert.equal(a.kind, 'image');
  assert.equal(a.wantsArtifact, 0.93);
  assert.equal(fetchImpl.calls[0].body.state.mensaje, 'cre aun aimgen de un gato');
  assert.equal(fetchImpl.calls[0].body.model, 'jev-latest');
  const failing = fakeFetch({ error: 'nope' }, 500);
  assert.equal(await jev.askJevMediaIntent({ text: 'hola', env: { ...env, TYPESAFE_RETRIES: '0' }, fetchImpl: failing }), null);
});

test('rlcd.refineMediaIntentWithJev returns the base untouched when Jev is off or irrelevant', async () => {
  const base = { kind: null, action: 'none', raw: null, decisionId: null };
  assert.equal(await rlcd.refineMediaIntentWithJev(base, { text: 'hola', env: {} }), base);
  const sure = { kind: 'image', action: 'force', raw: 0.9, repaired: false, decisionId: 'd' };
  assert.equal(await rlcd.refineMediaIntentWithJev(sure, { text: 'crea una imagen', env: { TYPESAFE_API_KEY: 'k', TYPESAFE_BASE_URL: 'http://127.0.0.1:9' } }), sure);
  assert.equal(await rlcd.refineMediaIntentWithJev(base, { text: 'cuánto es 2+2', env: { TYPESAFE_API_KEY: 'k', TYPESAFE_BASE_URL: 'http://127.0.0.1:9' } }), base);
});

test('decide_with_jev tool: not configured → ok:false; configured → normalised answers', async () => {
  const noKey = await decideWithJevTool.execute({ state: 'x', questions: { q: { type: 'noul', instructions: '?' } } }, { env: {} });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.code, 'typesafe_not_configured');
  const fetchImpl = fakeFetch({
    model: 'jev-1.13.0',
    answers: {
      dept: { type: 'choice', choice: 'technical', probabilities: { billing: 0.1, technical: 0.85, sales: 0.05 }, confidence: 0.82 },
      urgent: { type: 'noul', noul: 0.9 },
      mood: { type: 'score', score: 1.6, legend: { 0: 'Calm', 1: 'Frustrated', 2: 'Angry' }, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 }, confidence: 0.7 },
    },
    usage: { input_tokens: 50, output_tokens: 0 },
  });
  const out = await decideWithJevTool.execute(
    { state: 'Help! payouts failing', questions: { dept: { type: 'choice', instructions: 'team?', criteria: { billing: null, technical: null, sales: null } }, urgent: { type: 'noul', instructions: 'urgent?' }, mood: { type: 'score', instructions: 'mood', criteria: ['Calm', 'Frustrated', 'Angry'] } } },
    { env: { TYPESAFE_API_KEY: 'k' }, fetchImpl },
  );
  assert.equal(out.ok, true);
  assert.equal(out.answers.dept.answer, 'technical');
  assert.equal(out.answers.dept.band, 'act');
  assert.equal(out.answers.urgent.answer, 'yes');
  assert.equal(out.answers.mood.label, 'Angry');
  assert.equal(out.usage.input_tokens, 50);
  const bad = await decideWithJevTool.execute({ state: 'x', questions: { q: { type: 'poem', instructions: '?' } } }, { env: { TYPESAFE_API_KEY: 'k' }, fetchImpl });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'typesafe_invalid_request');
});

test('aiService.generateStream serves a TypeSafe turn through the decision adapter', async () => {
  const prevKey = process.env.TYPESAFE_API_KEY;
  const prevFetch = globalThis.fetch;
  process.env.TYPESAFE_API_KEY = 'k';
  globalThis.fetch = fakeFetch({
    model: 'jev-1.13.0',
    answers: { decision: { type: 'noul', noul: 0.91 } },
    usage: { input_tokens: 20, output_tokens: 0 },
  });
  try {
    const aiService = require('../src/services/ai-service');
    const frames = [];
    const res = { write: (s) => { frames.push(String(s)); return true; }, writableEnded: false, destroyed: false, on() {}, off() {} };
    const out = await aiService.generateStream({
      provider: 'TypeSafe',
      model: 'typesafe/jev-latest',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hola' }, { role: 'assistant', content: 'qué tal' }, { role: 'user', content: '¿Es seguro desplegar el viernes?' }],
      res,
      userPrompt: '¿Es seguro desplegar el viernes?',
    });
    assert.match(out, /Decisión Jev · `jev-1.13.0`/);
    assert.match(out, /\*\*Sí\*\* \(probabilidad de sí 91 %\)/);
    const delta = frames.find((f) => f.includes('"type":"text_delta"'));
    assert.ok(delta, 'text_delta frame emitted');
    const posted = globalThis.fetch.calls[0].body;
    assert.equal(posted.model, 'jev-latest');
    assert.equal(posted.state.conversacion.length, 2);
    assert.equal(posted.questions.decision.type, 'noul');
  } finally {
    if (prevKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = prevKey;
    globalThis.fetch = prevFetch;
  }
});
