'use strict';

// AgentRunner / doc-agent LLM runtime and the shared funding memo.
//
// Production (2026-09-28): the OpenAI and Gemini keys answered 429 «quota»
// and the runner (a) never told the picker (the wrapped E_PROVIDER lost the
// provider text), (b) retried a permanent «no credit» 429 up to ~9 times
// (3 loop retries × 2 SDK retries), and (c) told the user only "El modelo
// seleccionado no está disponible". The selected model still keeps its
// provider (no silent switch); the memo now learns the real cause, the retry
// stops at once, and the copy names it. Offline.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const rt = require('../src/services/doc-agent/llm-runtime');
const billing = require('../src/services/ai/billing-failover');
const keyHealth = require('../src/utils/provider-key-health');
const loop = require('../src/services/agent-runner/loop');

const OPENAI_KEY = 'sk-synthetic-openai-funding-test';

afterEach(() => {
  billing.__resetForTests();
  keyHealth.clear();
});

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  let out;
  try { out = fn(); } catch (err) { restore(); throw err; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status }, extra);
}

function throwingFactory(errorFor, counter) {
  return () => ({ chat: { completions: { create: async () => {
    counter.calls += 1;
    throw errorFor(counter.calls);
  } } } });
}

const QUOTA_429 = () => httpError(429, '429 You exceeded your current quota, please check your plan and billing details.', { code: 'insufficient_quota' });

test('an OpenAI «exceeded your current quota» 429 marks the provider «Sin saldo»', async () => {
  await withEnv({ OPENAI_API_KEY: OPENAI_KEY }, async () => {
    const counter = { calls: 0 };
    const client = rt.createFailoverClient([{ provider: 'OpenAI', model: 'gpt-6-sol', apiKey: OPENAI_KEY }], {
      createClient: throwingFactory(QUOTA_429, counter),
    });
    await assert.rejects(() => client.chat.completions.create({ messages: [] }), /exceeded your current quota/);
    assert.equal(billing.isOutOfCredit('OpenAI'), true);
    const { lastFailure } = client.describe();
    assert.deepEqual(lastFailure, { provider: 'OpenAI', status: 429, cause: 'billing' });
    assert.doesNotMatch(JSON.stringify(client.describe()), /quota|billing details/i, 'no provider text in the descriptor');
  });
});

test('a 401 marks the key as rejected (auth), not unfunded', async () => {
  await withEnv({ OPENAI_API_KEY: OPENAI_KEY }, async () => {
    const counter = { calls: 0 };
    const client = rt.createFailoverClient([{ provider: 'OpenAI', model: 'gpt-6-sol', apiKey: OPENAI_KEY }], {
      createClient: throwingFactory(() => httpError(401, 'Incorrect API key provided'), counter),
    });
    await assert.rejects(() => client.chat.completions.create({ messages: [] }));
    assert.equal(keyHealth.rejectionReason('openai', OPENAI_KEY), 'auth');
    assert.equal(billing.isOutOfCredit('OpenAI'), false);
    assert.equal(client.describe().lastFailure.cause, 'auth');
  });
});

test('a plain 403 (model not enabled for this key) does not mark the key dead for other ladders', async () => {
  const counter = { calls: 0 };
  const client = rt.createFailoverClient([{ provider: 'Gemini', model: 'gemini-3.5-pro', apiKey: 'gem-k' }], {
    createClient: throwingFactory(() => httpError(403, 'The caller does not have permission to use this model'), counter),
  });
  await assert.rejects(() => client.chat.completions.create({ messages: [] }));
  assert.equal(keyHealth.isRejected('gemini', 'gem-k'), false);
  assert.equal(client.describe().lastFailure.cause, 'forbidden');
  rt.noteLlmProviderFailure('Gemini', 'gem-k', httpError(403, 'API key not valid. Please pass a valid API key.'));
  assert.equal(keyHealth.rejectionReason('gemini', 'gem-k'), 'auth', 'an explicit invalid-key 403 still counts');
});

// OpenRouter's real 402 carries both «fewer max_tokens» and «can only afford N».
const openRouterReservation = (requested, affordable) => httpError(402,
  `402 This request requires more credits, or fewer max_tokens. You requested up to ${requested} tokens, but can only afford ${affordable}. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account`);

test('reservation-size 402s and aborts never touch the memo; a near-empty balance does', async () => {
  await withEnv({ OPENROUTER_API_KEY: 'or-synthetic-key' }, async () => {
    rt.noteLlmProviderFailure('OpenRouter', 'or-synthetic-key', openRouterReservation(8192, 5000));
    assert.equal(billing.isOutOfCredit('OpenRouter'), false, 'the account still answers smaller requests');
    rt.noteLlmProviderFailure('OpenRouter', 'or-synthetic-key', Object.assign(new Error('Request was aborted.'), { name: 'AbortError', status: 402 }));
    assert.equal(billing.isOutOfCredit('OpenRouter'), false);
    rt.noteLlmProviderFailure('OpenRouter', 'or-synthetic-key', openRouterReservation(2048, 12));
    assert.equal(billing.isOutOfCredit('OpenRouter'), true, 'twelve affordable tokens is an empty account');
  });
  assert.equal(rt.classifyProviderFailure(openRouterReservation(8192, 5000)), 'reservation');
  assert.equal(rt.classifyProviderFailure(openRouterReservation(2048, 12)), 'billing');
  const controller = new AbortController();
  controller.abort();
  const counter = { calls: 0 };
  const client = rt.createFailoverClient([{ provider: 'xAI', model: 'grok-4.7', apiKey: 'xai-k' }], {
    createClient: throwingFactory(() => httpError(403, 'used all available credits'), counter),
  });
  await assert.rejects(() => client.chat.completions.create({ messages: [] }, { signal: controller.signal }));
  assert.equal(billing.isOutOfCredit('xAI'), false, 'a stopped request records nothing');
});

test('a per-minute quota is a rate limit with its wait, not «no credit»', async () => {
  const counter = { calls: 0 };
  const client = rt.createFailoverClient([{ provider: 'Gemini', model: 'gemini-3.5-flash', apiKey: 'gem-k' }], {
    createClient: throwingFactory(() => httpError(429, 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 10 per minute. Please retry in 29.5s.'), counter),
  });
  await assert.rejects(() => client.chat.completions.create({ messages: [] }));
  assert.deepEqual(client.describe().lastFailure, { provider: 'Gemini', status: 429, cause: 'rate_limit', retryAfterMs: 29500 });
  await withEnv({ GEMINI_API_KEY: 'gem-k' }, () => {
    rt.noteLlmProviderFailure('Gemini', 'gem-k', httpError(429, 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 10 per minute. Please retry in 29.5s.'));
    assert.equal(billing.isOutOfCredit('Gemini'), false, 'the picker never says «Sin saldo» for a per-minute window');
    assert.equal(billing.isUnfunded('Gemini'), false);
  });
});

test('an empty DeepSeek direct account with OpenRouter configured benches the key, not the picker model', async () => {
  const env = { DEEPSEEK_API_KEY: 'ds-synthetic-key', OPENROUTER_API_KEY: 'or-synthetic-key' };
  await withEnv(env, () => {
    // The chat answers DeepSeek V4 through OpenRouter when the direct balance is empty.
    rt.noteLlmProviderFailure('DeepSeek', 'ds-synthetic-key', httpError(402, 'Insufficient Balance'));
    assert.equal(billing.isOutOfCredit('DeepSeek'), false, 'the picker keeps DeepSeek V4 answerable');
    assert.equal(keyHealth.rejectionReason('deepseek', 'ds-synthetic-key'), 'billing');
    assert.equal(billing.isUnfunded('DeepSeek'), true, 'unpinned ladders start elsewhere');
    assert.equal(rt.resolveDocAgentCandidates({ env }).at(-1).provider, 'DeepSeek');
  });
  billing.__resetForTests();
  keyHealth.clear();
  await withEnv({ DEEPSEEK_API_KEY: 'ds-synthetic-key', OPENROUTER_API_KEY: undefined }, () => {
    rt.noteLlmProviderFailure('DeepSeek', 'ds-synthetic-key', httpError(402, 'Insufficient Balance'));
    assert.equal(billing.isOutOfCredit('DeepSeek'), true, 'without OpenRouter nothing answers DeepSeek: «Sin saldo»');
  });
});

test('resolveDocAgentCandidates moves unfunded rungs last, keeps the explicit model first, never shrinks', () => {
  const env = { DEEPSEEK_API_KEY: 'ds', MODEL_API_KEY: 'meta', GEMINI_API_KEY: 'gem', XAI_API_KEY: 'xai', OPENROUTER_API_KEY: 'or', OPENAI_API_KEY: 'oa' };
  const before = rt.resolveDocAgentCandidates({ env }).map((c) => c.provider);
  assert.deepEqual(before, ['DeepSeek', 'Meta', 'Gemini', 'xAI', 'OpenRouter', 'OpenAI']);
  billing.markOutOfCredit('DeepSeek', httpError(402, 'Insufficient Balance'), env);
  keyHealth.markRejected('gemini', 'gem', httpError(401, 'API key not valid'), env, { reason: 'auth' });
  const after = rt.resolveDocAgentCandidates({ env }).map((c) => c.provider);
  assert.deepEqual(after, ['Meta', 'xAI', 'OpenRouter', 'OpenAI', 'DeepSeek', 'Gemini']);
  const explicit = rt.resolveDocAgentCandidates({ model: 'DeepSeek:deepseek-v4-flash', env });
  assert.equal(explicit[0].provider, 'DeepSeek', 'the explicit (picked) model never moves');
  assert.equal(explicit[0].model, 'deepseek-v4-flash');
  assert.equal(explicit.length, 6);
  // The picked-model path keeps its single candidate, funded or not.
  assert.deepEqual(rt.resolveDocAgentRunCandidates({ model: 'DeepSeek:deepseek-v4-pro', env }).map((c) => c.provider), ['DeepSeek']);
});

test('defaultCreateClient: SDK retries ≤1 and a finite timeout; OpenAI gets the sampling guard', () => {
  const ds = rt.defaultCreateClient({ provider: 'DeepSeek', model: 'deepseek-v4-pro', apiKey: 'k', baseURL: 'https://api.deepseek.com/v1' });
  assert.ok(ds.maxRetries <= 1, `maxRetries ${ds.maxRetries}`);
  assert.ok(Number.isFinite(ds.timeout) && ds.timeout > 0 && ds.timeout <= 180_000, `timeout ${ds.timeout}`);
  assert.equal(ds.chat.completions.__siraSamplingGuard, undefined);
  const oa = rt.defaultCreateClient({ provider: 'OpenAI', model: 'gpt-6-sol', apiKey: 'k', baseURL: 'https://api.openai.com/v1' });
  assert.equal(oa.chat.completions.__siraSamplingGuard, true);
  const tuned = rt.defaultCreateClient(
    { provider: 'Gemini', model: 'gemini-3.5-flash', apiKey: 'k', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
    { env: { SIRAGPT_DOC_AGENT_SDK_MAX_RETRIES: '0', SIRAGPT_DOC_AGENT_LLM_TIMEOUT_MS: '5000' } },
  );
  assert.equal(tuned.maxRetries, 0);
  assert.equal(tuned.timeout, 5000);
});

test('the runner tries an unfunded 429 once and a plain rate limit up to LLM_RETRY_MAX', async () => {
  const { createRunnerLlmClient } = require('../src/services/agent-runner');
  await withEnv({ OPENAI_API_KEY: OPENAI_KEY }, async () => {
    const unfunded = { calls: 0 };
    const client = createRunnerLlmClient({
      pickedModel: 'OpenAI:gpt-6-sol',
      env: { OPENAI_API_KEY: OPENAI_KEY },
      createClient: throwingFactory(QUOTA_429, unfunded),
    });
    await assert.rejects(
      () => loop.callModel({ client, model: 'gpt-6-sol', messages: [{ role: 'user', content: 'hola' }], tools: [], maxTokens: 256 }),
      { code: 'E_PROVIDER', status: 429 },
    );
    assert.equal(unfunded.calls, 1, 'no retry can refill an empty account');

    billing.__resetForTests();
    const limited = { calls: 0 };
    const rateLimited = createRunnerLlmClient({
      pickedModel: 'OpenAI:gpt-6-sol',
      env: { OPENAI_API_KEY: OPENAI_KEY },
      createClient: throwingFactory(() => httpError(429, 'Rate limit reached for requests', { headers: { 'retry-after-ms': '1' } }), limited),
    });
    await assert.rejects(() => loop.callModel({ client: rateLimited, model: 'gpt-6-sol', messages: [{ role: 'user', content: 'hola' }], tools: [], maxTokens: 256 }));
    assert.equal(limited.calls, loop.LLM_RETRY_MAX);
    assert.equal(billing.isOutOfCredit('OpenAI'), false, 'a rate limit is not «Sin saldo»');
  });
});

test('the E_PROVIDER event names «sin saldo», keeps the model, and the diagnostic says out_of_credit', async () => {
  const { createRunnerLlmClient } = require('../src/services/agent-runner');
  await withEnv({ OPENAI_API_KEY: OPENAI_KEY }, async () => {
    const counter = { calls: 0 };
    const client = createRunnerLlmClient({
      pickedModel: 'OpenAI:gpt-6-sol',
      env: { OPENAI_API_KEY: OPENAI_KEY },
      createClient: throwingFactory(QUOTA_429, counter),
    });
    const events = [];
    const lines = [];
    const originalWarn = console.warn;
    console.warn = (...parts) => lines.push(parts.join(' '));
    let result;
    try {
      result = await loop.runAgentLoop({
        client,
        model: 'gpt-6-sol',
        messages: [{ role: 'user', content: 'Crea un Excel' }],
        tools: [],
        executors: {},
        maxIterations: 2,
        onEvent: (e) => events.push(e),
      });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(result.stoppedReason, 'E_PROVIDER');
    const error = events.find((e) => e.type === 'error' && e.code === 'E_PROVIDER');
    assert.ok(error);
    assert.equal(error.message, result.errorMessage);
    assert.equal(error.retryable, false, 'resending to an empty account cannot work');
    assert.match(error.message, /El proveedor del modelo seleccionado no tiene saldo en este momento/);
    assert.match(error.message, /No cambié de modelo/);
    assert.match(error.message, /DeepSeek V4 Flash/, 'a funded alternative is suggested by display name');
    assert.doesNotMatch(error.message, /gpt-6-sol|OpenRouter|quota|429/i, 'never a raw id, the router or provider text');
    const diag = lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
      .find((l) => l && l.event === 'selected_model_failure');
    assert.equal(diag.category, 'out_of_credit');
    assert.equal(diag.provider, 'OpenAI');
    assert.equal(diag.status, 429);
    assert.equal(counter.calls, 1);
  });
});

test('the copy names each cause: rejected key, provider down, per-minute limit with its wait', () => {
  const failure = (lastFailure) => ({ describe: () => ({ provider: lastFailure.provider, lastFailure }) });
  const wrapped = (status) => Object.assign(new Error('El modelo seleccionado no está disponible.'), { code: 'E_PROVIDER', status, failureProvider: 'Gemini' });
  const auth = loop.providerFailurePublicMessage(wrapped(401), { client: failure({ provider: 'Gemini', status: 401, cause: 'auth' }), model: 'gemini-3.5-flash' });
  assert.match(auth, /rechazó la clave de acceso configurada/);
  const down = loop.providerFailurePublicMessage(wrapped(503), { client: failure({ provider: 'Gemini', status: 503, cause: 'unavailable' }), model: 'gemini-3.5-flash' });
  assert.match(down, /no está respondiendo en este momento/);
  const limited = loop.providerFailurePublicMessage(wrapped(429), { client: failure({ provider: 'Gemini', status: 429, cause: 'rate_limit', retryAfterMs: 29_500 }), model: 'gemini-3.5-flash' });
  assert.match(limited, /límite de solicitudes por minuto\. Espera 30 segundos/);
  const noWait = loop.providerFailurePublicMessage(wrapped(429), { client: {}, model: 'gemini-3.5-flash' });
  assert.match(noWait, /Espera unos segundos/);
  for (const text of [auth, down, limited, noWait]) {
    assert.match(text, /modelo seleccionado/);
    assert.doesNotMatch(text, /gemini-3\.5-flash|OpenRouter/i);
  }
  // A caller label wins; a DeepSeek tier is named by its display name.
  const labelled = loop.providerFailurePublicMessage(wrapped(503), { client: {}, model: 'x-ai/grok-4.7', modelLabel: 'Grok 4.7' });
  assert.match(labelled, /\(Grok 4\.7\)/);
  const flash = loop.providerFailurePublicMessage(Object.assign(new Error('x'), { code: 'E_PROVIDER', status: 402 }), { client: {}, model: 'deepseek-v4-flash' });
  assert.match(flash, /\(DeepSeek V4 Flash\) no tiene saldo/);
  assert.doesNotMatch(flash, /por ejemplo/, 'never suggests the model that just failed');
  const pro = loop.providerFailurePublicMessage(Object.assign(new Error('x'), { code: 'E_PROVIDER', status: 402 }), { client: {}, model: 'deepseek-v4-pro' });
  assert.match(pro, /\(DeepSeek V4 Pro\) no tiene saldo/);
  assert.doesNotMatch(pro, /por ejemplo/, 'Pro and Flash share the DeepSeek account');
  // A client without describe(): a «no credits» 429 is billing, not a per-minute limit.
  const bare = loop.providerFailurePublicMessage(Object.assign(new Error('You have no credits remaining'), { code: 'E_PROVIDER', status: 429 }), { client: {}, model: 'x-ai/grok-4.7', modelLabel: 'Grok 4.7' });
  assert.match(bare, /\(Grok 4\.7\) no tiene saldo/);
  // Credit left, but not for a reply this large: its own copy, not «Sin saldo».
  const reservationErr = Object.assign(new Error('x'), { code: 'E_PROVIDER', status: 402 });
  const reservation = loop.providerFailurePublicMessage(reservationErr, {
    client: failure({ provider: 'OpenRouter', status: 402, cause: 'reservation' }),
    model: 'x-ai/grok-4.7',
    modelLabel: 'Grok 4.7',
  });
  assert.match(reservation, /no tiene saldo suficiente para una respuesta de este tamaño/);
  assert.notEqual(reservationErr.failureUnfunded, true, 'the account is not empty');
  withEnv({ DEEPSEEK_API_KEY: 'ds-synthetic-key' }, () => {
    billing.markOutOfCredit('DeepSeek', httpError(402, 'Insufficient Balance'));
    const grok = loop.providerFailurePublicMessage(Object.assign(new Error('x'), { code: 'E_PROVIDER', status: 402 }), { client: {}, model: 'x-ai/grok-4.7', modelLabel: 'Grok 4.7' });
    assert.doesNotMatch(grok, /por ejemplo/, 'an unfunded DeepSeek is never suggested');
  });
  // Truncation and signed-call copy is kept as is.
  assert.equal(loop.providerFailurePublicMessage({ code: 'E_PROVIDER', publicMessage: 'copia' }, {}), 'copia');
});
