'use strict';

/**
 * Item 1 (prod 2026-09-27): `OpenAI:gpt-6-sol … 400 Unsupported value:
 * 'temperature' does not support 0.55 with this model.` Reasoning-class
 * OpenAI models accept only their default sampling values.
 *
 *  (a) the default-temperature-only predicate covers the gpt-6, gpt-5, o1, o3 and o4 families
 *      and the gateway omits the knobs up front;
 *  (b) the generic guard retries ONCE without the rejected parameter and
 *      memoises the model for the rest of the process;
 *  (c) every first-party OpenAI client (chat route, agent runner, contract
 *      resolver side channel) goes through the shared helper.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sampling = require('../src/services/ai/openai-sampling-params');
const { buildProviderChatPayload } = require('../src/services/ai-product-os/litellm-gateway');

const SRC = path.join(__dirname, '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

function unsupported(param, value = 0.55) {
  const err = new Error(`400 Unsupported value: '${param}' does not support ${value} with this model. Only the default (1) value is supported.`);
  err.status = 400;
  return err;
}

test.beforeEach(() => sampling.__resetForTests());

test('isDefaultTemperatureOnlyModel: reasoning families yes, gpt-4o family no', () => {
  for (const m of ['gpt-6-sol', 'gpt-6', 'GPT-6-mini', 'gpt-5', 'gpt-5.1', 'gpt-5-mini', 'o1', 'o1-mini', 'o3', 'o3-pro', 'o4-mini', 'openai/gpt-6-sol']) {
    assert.equal(sampling.isDefaultTemperatureOnlyModel(m), true, m);
  }
  for (const m of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o2-fake', 'omni-x', 'deepseek-v4-flash', 'claude-fable-5-1', '', null]) {
    assert.equal(sampling.isDefaultTemperatureOnlyModel(m), false, String(m));
  }
});

test('stripUnsupportedSampling: knobs removed for default-only models, kept otherwise, memo honoured', () => {
  const payload = { model: 'gpt-6-sol', temperature: 0.55, top_p: 0.9, presence_penalty: 0.1, frequency_penalty: 0.2, max_completion_tokens: 10 };
  sampling.stripUnsupportedSampling('gpt-6-sol', payload);
  assert.deepEqual(Object.keys(payload).sort(), ['max_completion_tokens', 'model']);

  const kept = { model: 'gpt-4o', temperature: 0.55, top_p: 0.9 };
  sampling.stripUnsupportedSampling('gpt-4o', kept);
  assert.equal(kept.temperature, 0.55);
  assert.equal(kept.top_p, 0.9);

  // Runtime memo: a model that rejected `temperature` once loses only that knob.
  assert.equal(sampling.rememberUnsupported('gpt-4o-new', 'temperature'), true);
  assert.equal(sampling.rememberUnsupported('gpt-4o-new', 'max_tokens'), false, 'only sampling knobs are memoised');
  assert.deepEqual(sampling.rememberedUnsupported('openai/gpt-4o-new'), ['temperature'], 'provider prefix normalised');
  const memo = { model: 'gpt-4o-new', temperature: 0.55, top_p: 0.9 };
  sampling.stripUnsupportedSampling('gpt-4o-new', memo);
  assert.equal('temperature' in memo, false);
  assert.equal(memo.top_p, 0.9);
});

test('unsupportedSamplingParamFromError: names the parameter, ignores other 400s and statuses', () => {
  assert.equal(sampling.unsupportedSamplingParamFromError(unsupported('temperature')), 'temperature');
  assert.equal(sampling.unsupportedSamplingParamFromError(unsupported('top_p', 0.9)), 'top_p');
  const nested = Object.assign(new Error('400 bad request'), { status: 400, error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model." } });
  assert.equal(sampling.unsupportedSamplingParamFromError(nested), 'temperature');
  assert.equal(sampling.unsupportedSamplingParamFromError(Object.assign(new Error("Unsupported value: 'reasoning_effort'"), { status: 400 })), null);
  assert.equal(sampling.unsupportedSamplingParamFromError(Object.assign(new Error("Unsupported value: 'temperature'"), { status: 429 })), null, 'only 400s');
  assert.equal(sampling.unsupportedSamplingParamFromError(Object.assign(new Error('Invalid max_tokens'), { status: 400 })), null);
  assert.equal(sampling.unsupportedSamplingParamFromError(null), null);
});

test('gateway payload omits temperature/top_p/penalties for every reasoning-class OpenAI model', () => {
  for (const model of ['gpt-6-sol', 'gpt-5', 'gpt-5-mini', 'o1', 'o3-mini', 'o4-mini']) {
    const built = buildProviderChatPayload({
      provider: 'OpenAI', model, messages: [{ role: 'user', content: 'hola' }], stream: true,
      extra: { temperature: 0.55, top_p: 0.9, presence_penalty: 0.1, frequency_penalty: 0.1 },
    });
    assert.equal(built.provider, 'openai');
    for (const p of sampling.SAMPLING_PARAMS) assert.equal(p in built.payload, false, `${model}.${p}`);
  }
  const memoised = buildProviderChatPayload({ provider: 'OpenAI', model: 'gpt-4o', extra: { temperature: 0.55 } });
  assert.equal(memoised.payload.temperature, 0.55, 'gpt-4o keeps temperature until it rejects it');
  sampling.rememberUnsupported('gpt-4o', 'temperature');
  const after = buildProviderChatPayload({ provider: 'OpenAI', model: 'gpt-4o', extra: { temperature: 0.55 } });
  assert.equal('temperature' in after.payload, false, 'the gateway honours the runtime memo');
  // OpenRouter slugs keep the knob: the 400 is first-party only.
  const viaRouter = buildProviderChatPayload({ provider: 'OpenRouter', model: 'openai/gpt-5', extra: { temperature: 0.55 } });
  assert.equal(viaRouter.payload.temperature, 0.55);
});

test('wrapOpenAIChatClient: strips up front, retries once without the rejected knob, memoises the model', async () => {
  const calls = [];
  let rejectOnce = true;
  const client = {
    chat: {
      completions: {
        create: async (params) => {
          calls.push({ ...params });
          if (rejectOnce && 'temperature' in params) { rejectOnce = false; throw unsupported('temperature', params.temperature); }
          return { choices: [{ message: { content: 'ok' } }] };
        },
      },
    },
  };
  const warnings = [];
  const wrapped = sampling.wrapOpenAIChatClient(client, { log: { warn: (l) => warnings.push(l) } });
  assert.equal(wrapped, client, 'same client instance');
  assert.equal(sampling.wrapOpenAIChatClient(client), client, 'idempotent');

  // Known family: no round-trip is wasted.
  await client.chat.completions.create({ model: 'gpt-6-sol', temperature: 0.55, messages: [] });
  assert.equal(calls.length, 1);
  assert.equal('temperature' in calls[0], false);

  // Unknown model: one 400 → one retry without the knob → memo.
  const original = { model: 'gpt-4o-future', temperature: 0.55, top_p: 0.9, messages: [] };
  const out = await client.chat.completions.create(original);
  assert.equal(out.choices[0].message.content, 'ok');
  assert.equal(calls.length, 3, 'exactly one retry');
  assert.equal(calls[1].temperature, 0.55);
  assert.equal('temperature' in calls[2], false);
  assert.equal(calls[2].top_p, 0.9, 'only the rejected parameter is dropped on the retry');
  assert.equal(original.temperature, 0.55, 'the caller payload is never mutated');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /gpt-4o-future rejected 'temperature'/);
  assert.doesNotMatch(warnings[0], /sk-/, 'never logs secrets');

  // Later calls skip the knob without a network round-trip.
  await client.chat.completions.create({ model: 'gpt-4o-future', temperature: 0.3, messages: [] });
  assert.equal(calls.length, 4);
  assert.equal('temperature' in calls[3], false);

  // A second 400 for another reason is NOT retried (once only).
  const other = { chat: { completions: { create: async () => { throw Object.assign(new Error('400 Invalid schema'), { status: 400 }); } } } };
  sampling.wrapOpenAIChatClient(other);
  await assert.rejects(() => other.chat.completions.create({ model: 'gpt-4o', temperature: 0.5 }), /Invalid schema/);
});

test('source contract: every first-party OpenAI client and the chat retry go through the shared helper', () => {
  const ai = read('routes/ai.js');
  assert.match(ai, /require\('\.\.\/services\/ai\/openai-sampling-params'\)/);
  assert.match(ai, /return wrapOpenAIChatClient\(new OpenAI\(\{\s*apiKey: process\.env\.OPENAI_API_KEY\s*\}\)\);/);

  const runner = read('services/agents/agent-task-runner.js');
  assert.match(runner, /wrapOpenAIChatClient\(client, \{ provider: target\.provider \|\| 'OpenAI' \}\)/);

  const resolver = read('services/agents/task-contract-resolver.js');
  assert.match(resolver, /openai-sampling-params'\)\.wrapOpenAIChatClient\(client\)/);

  const gateway = read('services/ai-product-os/litellm-gateway.js');
  assert.match(gateway, /stripUnsupportedSampling\(runtime\.model_id, payload\)/);

  const service = read('services/ai-service.js');
  assert.match(service, /openaiSampling\.unsupportedSamplingParamFromError\(error\)/);
  assert.match(service, /openaiSampling\.rememberUnsupported\(currentRuntimeModel, unsupported\)/);
  // The generic guard runs BEFORE the reasoning_effort guard so a knob 400 is
  // retried exactly once with the knob stripped.
  assert.ok(service.indexOf('unsupportedSamplingParamFromError(error)') < service.indexOf("reasoning_effort rejected ("));
});
