'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const billing = require('../src/services/ai/billing-failover');

function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

test('isBillingError: credit/quota/balance errors yes; rate limits, auth and transient no', () => {
  const yes = [
    httpError(400, 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'),
    httpError(402, 'Payment Required'),
    httpError(402, 'Insufficient credits. Add more using https://openrouter.ai/settings/credits'),
    httpError(402, 'Insufficient Balance'),
    httpError(402, 'Billing verification failed. Please check your payment method.'),
    httpError(429, 'You exceeded your current quota, please check your plan and billing details.', { code: 'insufficient_quota' }),
    Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}'), { status: 400 }),
  ];
  const no = [
    httpError(429, 'Rate limit reached for requests'),
    httpError(429, 'Too Many Requests'),
    httpError(401, 'Incorrect API key provided'),
    httpError(403, 'Forbidden'),
    httpError(500, 'Internal server error'),
    httpError(503, 'Service unavailable'),
    httpError(400, 'Unknown parameter: reasoning'),
    null,
  ];
  for (const err of yes) assert.equal(billing.isBillingError(err), true, err.message);
  for (const err of no) assert.equal(billing.isBillingError(err), false, err ? err.message : 'null');
});

test('out-of-credit memo: marks the provider, re-arms on a new key and after the TTL', () => {
  billing.__resetForTests();
  const env = { ANTHROPIC_API_KEY: 'sk-ant-old', SIRAGPT_BILLING_FAILOVER_MEMO_MS: '60000' };
  billing.markOutOfCredit('Anthropic', httpError(400, 'credit balance is too low'), env);
  assert.equal(billing.isOutOfCredit('Anthropic', env), true);
  assert.equal(billing.isOutOfCredit('anthropic', env), true, 'case-insensitive');
  assert.equal(billing.isOutOfCredit('xAI', env), false);
  // An admin saves a funded key → the provider is tried again immediately.
  assert.equal(billing.isOutOfCredit('Anthropic', { ...env, ANTHROPIC_API_KEY: 'sk-ant-new' }), false);
  billing.markOutOfCredit('Meta', httpError(402, 'Billing verification failed'), { SIRAGPT_BILLING_FAILOVER_MEMO_MS: '1000' });
  const snap = billing.snapshot();
  assert.ok(snap.meta && snap.meta.status === 402);
  billing.__resetForTests();
  assert.equal(billing.isOutOfCredit('Meta'), false);
});

function fakeDeps({ outOfCredit = [], notReady = [], rejected = [], vision = {} } = {}) {
  const rows = [
    { id: 'm1', name: 'claude-fable-5-1', displayName: 'Claude Fable 5.1', provider: 'Anthropic', type: 'TEXT', isActive: true },
    { id: 'm2', name: 'typesafe/jev-latest', displayName: 'TypeSafe Jev', provider: 'TypeSafe', type: 'TEXT', isActive: true },
    { id: 'm3', name: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', provider: 'DeepSeek', type: 'TEXT', isActive: true },
    { id: 'm4', name: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', provider: 'DeepSeek', type: 'TEXT', isActive: true },
    { id: 'm5', name: 'grok-4.7', displayName: 'Grok 4.7', provider: 'xAI', type: 'TEXT', isActive: true },
    { id: 'm6', name: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', provider: 'Gemini', type: 'TEXT', isActive: true },
  ];
  for (const p of outOfCredit) billing.markOutOfCredit(p, httpError(402, 'Insufficient Balance'), {});
  return {
    prisma: { aiModel: { findMany: async () => rows } },
    catalog: { curateVisibleTextModels: (list) => list },
    inference: {
      resolveGenerateProvider: (provider) => provider,
      providerConnectionReady: (provider) => !notReady.includes(provider),
    },
    keyHealth: { isRejected: (p) => rejected.includes(p) },
    capabilities: { resolveModelCapabilities: (name) => ({ supportsImages: Boolean(vision[name]) }) },
  };
}

test('pickFailoverModel: comparable tier from the picker list, funded and configured, never the same provider', async () => {
  billing.__resetForTests();
  const pick = await billing.pickFailoverModel({ fromProvider: 'Anthropic', fromModel: 'claude-fable-5-1', env: {}, deps: fakeDeps() });
  assert.equal(pick.provider, 'xAI');
  assert.equal(pick.model, 'grok-4.7');
  assert.equal(pick.label, 'Grok 4.7');
  assert.equal(pick.fromLabel, 'Claude Fable 5.1');

  // Fast tier asks for a fast model first.
  const fast = await billing.pickFailoverModel({ fromProvider: 'Gemini', fromModel: 'gemini-3.8-flash', env: {}, deps: fakeDeps() });
  assert.equal(fast.model, 'deepseek-v4-flash', 'Flash → the funded fast model');

  // Out of credit / not configured / rejected providers are skipped; Jev never.
  billing.__resetForTests();
  const skip = await billing.pickFailoverModel({
    fromProvider: 'Anthropic',
    fromModel: 'claude-fable-5-1',
    env: {},
    deps: fakeDeps({ outOfCredit: ['xAI'], notReady: ['Gemini'] }),
  });
  assert.equal(skip.provider, 'DeepSeek');
  assert.equal(skip.model, 'deepseek-v4-pro', 'pro tier → DeepSeek V4 Pro');

  // Image turns only fail over to a vision-capable model.
  billing.__resetForTests();
  const vision = await billing.pickFailoverModel({
    fromProvider: 'Anthropic',
    fromModel: 'claude-fable-5-1',
    needsVision: true,
    env: {},
    deps: fakeDeps({ vision: { 'gemini-3.8-flash': true } }),
  });
  assert.equal(vision.model, 'gemini-3.8-flash');

  // Nothing funded → null (the turn keeps the honest error).
  billing.__resetForTests();
  const none = await billing.pickFailoverModel({
    fromProvider: 'Anthropic',
    fromModel: 'claude-fable-5-1',
    env: {},
    deps: fakeDeps({ outOfCredit: ['xAI', 'DeepSeek', 'Gemini'] }),
  });
  assert.equal(none, null);
  // Kill switch.
  assert.equal(await billing.pickFailoverModel({ fromProvider: 'Anthropic', fromModel: 'x', env: { SIRAGPT_BILLING_FAILOVER: '0' }, deps: fakeDeps() }), null);
  billing.__resetForTests();
});

test('pickFailoverModel works with the REAL picker curation (rows need id + isActive)', async () => {
  billing.__resetForTests();
  const rows = [
    { id: 'r1', name: 'claude-fable-5-1', displayName: 'Claude Fable 5.1', provider: 'Anthropic', type: 'TEXT', isActive: true },
    { id: 'r2', name: 'grok-4.7', displayName: 'Grok 4.7', provider: 'xAI', type: 'TEXT', isActive: true },
    { id: 'r3', name: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', provider: 'DeepSeek', type: 'TEXT', isActive: true },
  ];
  let seenSelect = null;
  const prisma = { aiModel: { findMany: async (args) => { seenSelect = args.select; return rows; } } };
  const pick = await billing.pickFailoverModel({
    fromProvider: 'Anthropic',
    fromModel: 'claude-fable-5-1',
    env: {},
    deps: {
      prisma,
      // real curation — the one that dropped every row when isActive wasn't selected
      catalog: require('../src/services/visible-model-catalog'),
      inference: { resolveGenerateProvider: (p) => p, providerConnectionReady: () => true },
      keyHealth: { isRejected: () => false },
      capabilities: { resolveModelCapabilities: () => ({ supportsImages: false }) },
    },
  });
  assert.equal(seenSelect.isActive, true, 'select must include isActive (curateVisibleTextModels filters on it)');
  assert.equal(seenSelect.id, true);
  assert.ok(pick, 'a funded model must be found from the real curated list');
  assert.notEqual(pick.provider, 'Anthropic');
  billing.__resetForTests();
});

test('buildNotice: short Spanish notice naming both models', () => {
  assert.equal(
    billing.buildNotice({ fromLabel: 'Claude Fable 5.1', toLabel: 'Grok 4.7' }),
    'Claude Fable 5.1 no está disponible ahora (el proveedor no tiene saldo); respondí con Grok 4.7.',
  );
});

function streamOf(text) {
  const parts = String(text).match(/.{1,6}/gs) || [];
  return {
    async *[Symbol.asyncIterator]() {
      for (const p of parts) yield { choices: [{ delta: { content: p } }] };
    },
  };
}

async function runGenerate({ primaryError, pick, getClient }) {
  const service = require('../src/services/ai-service');
  const originalGetClient = service.getClient;
  const originalPick = billing.pickFailoverModel;
  const frames = [];
  const failovers = [];
  billing.__resetForTests();
  service.getClient = getClient;
  billing.pickFailoverModel = async () => pick;
  const failingClient = {
    chat: { completions: { create: async () => { throw primaryError; } } },
  };
  try {
    const out = await service.generateStream({
      provider: 'Anthropic',
      model: 'claude-fable-5-1',
      client: failingClient,
      messages: [{ role: 'user', content: '¿Cuánto es 2 + 2?' }],
      res: { write: (chunk) => { frames.push(String(chunk)); return true; } },
      qualityGuard: false,
      skipDoneSentinel: true,
      onModelFailover: (info) => failovers.push(info),
    });
    return { out, frames: frames.join('\n'), failovers };
  } finally {
    service.getClient = originalGetClient;
    billing.pickFailoverModel = originalPick;
  }
}

test('generateStream: Anthropic «credit balance too low» fails over to a funded model with a visible notice', async () => {
  const seen = [];
  const { out, frames, failovers } = await runGenerate({
    primaryError: httpError(400, 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'),
    pick: { provider: 'xAI', model: 'grok-4.7', label: 'Grok 4.7', fromLabel: 'Claude Fable 5.1' },
    getClient: (provider) => {
      seen.push(provider);
      if (provider !== 'xAI') throw httpError(503, 'unexpected provider');
      return { chat: { completions: { create: async () => streamOf('2 + 2 = 4.') } } };
    },
  });
  assert.deepEqual(seen, ['xAI']);
  assert.match(out, /^_Claude Fable 5\.1 no está disponible ahora \(el proveedor no tiene saldo\); respondí con Grok 4\.7\._\n\n2 \+ 2 = 4\.$/);
  assert.match(frames, /"type":"model_failover"/);
  assert.match(frames, /respondí con Grok 4\.7/);
  assert.equal(failovers.length, 1);
  assert.equal(failovers[0].to.model, 'grok-4.7');
  assert.equal(failovers[0].from.label, 'Claude Fable 5.1');
  assert.equal(billing.isOutOfCredit('Anthropic'), true, 'the provider is marked «sin saldo» for the picker');
  assert.equal(/No cambié de modelo|no pudo completar/i.test(frames), false, 'no error shown when the failover answered');
  billing.__resetForTests();
});

test('generateStream: no funded model → the honest error, no notice; rate limits never fail over', async () => {
  const none = await runGenerate({
    primaryError: httpError(402, 'Insufficient Balance'),
    pick: null,
    getClient: () => { throw httpError(503, 'must not be called'); },
  });
  assert.equal(/respondí con/.test(none.frames), false);
  assert.match(none.frames, /"error"|error/);
  assert.equal(none.failovers.length, 0);

  let picked = false;
  const rate = await runGenerate({
    primaryError: httpError(429, 'Rate limit reached for requests'),
    pick: { provider: 'xAI', model: 'grok-4.7', label: 'Grok 4.7', fromLabel: 'Claude Fable 5.1' },
    getClient: () => { picked = true; return { chat: { completions: { create: async () => streamOf('x') } } }; },
  });
  assert.equal(picked, false, 'a rate limit is not a billing error');
  assert.equal(rate.failovers.length, 0);
  billing.__resetForTests();
});

test('turn-failure tracker records a billing failover as error_visible with a clear cause', () => {
  const classify = require('../src/services/observability/turn-failures/classify');
  const verdict = classify.classifyTurnOutcome({
    visibleText: '_Claude Fable 5.1 no está disponible ahora (el proveedor no tiene saldo); respondí con Grok 4.7._\n\n2 + 2 = 4.',
    finalText: '_Claude Fable 5.1 no está disponible ahora (el proveedor no tiene saldo); respondí con Grok 4.7._\n\n2 + 2 = 4.',
    prompt: '¿Cuánto es 2 + 2?',
    startedAt: 1,
    endedAt: 2000,
    notes: [
      { kind: 'model_failover', data: { reason: 'billing', fromProvider: 'Anthropic', status: 400, toLabel: 'Grok 4.7', toModel: 'grok-4.7' } },
    ],
  });
  assert.ok(verdict, 'recorded, not treated as a normal turn');
  assert.equal(verdict.category, 'error_visible');
  assert.match(verdict.cause, /Anthropic 400 sin saldo → respondió Grok 4\.7/);
  assert.deepEqual(verdict.reasons, ['billing_failover']);
});

test('picker list exposes «sin_saldo» and the reply persists which model answered', () => {
  const ai = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');
  assert.match(ai, /billingStatus: require\('\.\.\/services\/ai\/billing-failover'\)\.isOutOfCredit\(connectionProvider\) \? 'sin_saldo' : null/);
  assert.match(ai, /onModelFailover: \(info\) => \{ __modelFailover = info \|\| null; \}/);
  assert.match(ai, /modelFailover: \{\s*reason: __modelFailover\.reason \|\| 'billing'/);
});
