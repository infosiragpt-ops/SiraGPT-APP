'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const provider = require('../src/services/codex/llm-provider');
const billing = require('../src/services/ai/billing-failover');
const keyHealth = require('../src/utils/provider-key-health');

function envWith(overrides = {}) {
  return { NODE_ENV: 'test', ...overrides };
}

function fakeOpenAIStyle(reply = 'hola', usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (payload) => {
          calls.push(payload);
          return { id: 'gen1', choices: [{ message: { content: reply } }], usage };
        },
      },
    },
  };
}

test.beforeEach(() => { provider.resetQuarantine(); billing.__resetForTests(); });
test.afterEach(() => billing.__resetForTests());

test('ladder: anthropic wins when its key is set', () => {
  const env = envWith({ ANTHROPIC_API_KEY: 'k1', OPENROUTER_API_KEY: 'k2', CEREBRAS_API_KEY: 'k3' });
  assert.deepEqual(provider.resolveCandidates({ env }), ['anthropic', 'openrouter', 'cerebras']);
});

test('ladder: falls to openrouter then cerebras as keys disappear', () => {
  assert.deepEqual(provider.resolveCandidates({ env: envWith({ OPENROUTER_API_KEY: 'k', CEREBRAS_API_KEY: 'k' }) }), ['openrouter', 'cerebras']);
  assert.deepEqual(provider.resolveCandidates({ env: envWith({ CEREBRAS_API_KEY: 'k' }) }), ['cerebras']);
  assert.deepEqual(provider.resolveCandidates({ env: envWith() }), []);
});

test('CODEX_LLM_PROVIDER forces a single configured rung (or none)', () => {
  const env = envWith({ ANTHROPIC_API_KEY: 'k1', CEREBRAS_API_KEY: 'k3', CODEX_LLM_PROVIDER: 'cerebras' });
  assert.deepEqual(provider.resolveCandidates({ env }), ['cerebras']);
  const missing = envWith({ CEREBRAS_API_KEY: 'k3', CODEX_LLM_PROVIDER: 'anthropic' });
  assert.deepEqual(provider.resolveCandidates({ env: missing }), []);
});

test('model overrides via env; sane defaults otherwise', () => {
  assert.equal(provider.modelFor('anthropic', envWith()), 'claude-sonnet-4-6');
  assert.equal(provider.modelFor('anthropic', envWith({ CODEX_ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001' })), 'claude-haiku-4-5-20251001');
  assert.equal(provider.modelFor('openrouter', envWith({ CODEX_OPENROUTER_MODEL: 'deepseek/deepseek-chat' })), 'deepseek/deepseek-chat');
});

test('toAnthropicPayload extracts system and coalesces same-role runs', () => {
  const { system, messages } = provider.toAnthropicPayload([
    { role: 'system', content: 'S1' },
    { role: 'user', content: 'U1' },
    { role: 'user', content: '[TOOL_RESULT x] ok' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'U2' },
  ]);
  assert.equal(system, 'S1');
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.match(messages[0].content, /U1[\s\S]*TOOL_RESULT/);
});

test('toAnthropicPayload guarantees a leading user turn', () => {
  const { messages } = provider.toAnthropicPayload([
    { role: 'system', content: 'S' },
    { role: 'assistant', content: 'A' },
  ]);
  assert.equal(messages[0].role, 'user');
});

test('chatComplete via anthropic ctor maps content and usage', async () => {
  const created = [];
  class FakeAnthropic {
    constructor(opts) { this.opts = opts; }

    get messages() {
      return {
        create: async (payload) => {
          created.push(payload);
          return { id: 'msg1', content: [{ type: 'text', text: 'listo' }], usage: { input_tokens: 7, output_tokens: 3 } };
        },
      };
    }
  }
  const out = await provider.chatComplete({
    messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }],
    env: envWith({ ANTHROPIC_API_KEY: 'k1' }),
    clients: { anthropicCtor: FakeAnthropic },
  });
  assert.equal(out.content, 'listo');
  assert.equal(out.usage.provider, 'Anthropic');
  assert.equal(out.usage.tokensIn, 7);
  assert.equal(created[0].system, 'S');
  assert.ok(created[0].max_tokens >= 4096);
});

test('failover: a throwing provider is quarantined and the next rung answers', async () => {
  class BoomAnthropic {
    // eslint-disable-next-line class-methods-use-this
    get messages() { return { create: async () => { throw new Error('401 bad key'); } }; }
  }
  const or = fakeOpenAIStyle('desde openrouter');
  const env = envWith({ ANTHROPIC_API_KEY: 'bad', OPENROUTER_API_KEY: 'ok' });
  const out = await provider.chatComplete({
    messages: [{ role: 'user', content: 'U' }],
    env,
    clients: { anthropicCtor: BoomAnthropic, openrouter: or },
  });
  assert.equal(out.content, 'desde openrouter');
  // While quarantined, anthropic is deprioritised behind openrouter.
  assert.deepEqual(provider.resolveCandidates({ env }), ['openrouter', 'anthropic']);
});

test('quarantine expires after the TTL', async () => {
  class BoomAnthropic {
    // eslint-disable-next-line class-methods-use-this
    get messages() { return { create: async () => { throw new Error('down'); } }; }
  }
  const or = fakeOpenAIStyle('x');
  const env = envWith({ ANTHROPIC_API_KEY: 'k', OPENROUTER_API_KEY: 'k' });
  let t = 1_000_000;
  const now = () => t;
  await provider.chatComplete({ messages: [{ role: 'user', content: 'U' }], env, now, clients: { anthropicCtor: BoomAnthropic, openrouter: or } });
  assert.deepEqual(provider.resolveCandidates({ env, now }), ['openrouter', 'anthropic']);
  t += provider.FAILOVER_TTL_MS + 1;
  assert.deepEqual(provider.resolveCandidates({ env, now }), ['anthropic', 'openrouter']);
});

test('chatComplete throws the FIRST error when every rung fails', async () => {
  class BoomAnthropic {
    // eslint-disable-next-line class-methods-use-this
    get messages() { return { create: async () => { throw new Error('primary boom'); } }; }
  }
  const badOr = { chat: { completions: { create: async () => { throw new Error('secondary boom'); } } } };
  await assert.rejects(
    provider.chatComplete({
      messages: [{ role: 'user', content: 'U' }],
      env: envWith({ ANTHROPIC_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }),
      clients: { anthropicCtor: BoomAnthropic, openrouter: badOr },
    }),
    /primary boom/,
  );
});

test('chatComplete with no keys throws a clear config error', async () => {
  await assert.rejects(provider.chatComplete({ messages: [], env: envWith() }), /no LLM provider configured/);
});

test('describeActiveProvider reports the next-serving rung', () => {
  const env = envWith({ OPENROUTER_API_KEY: 'k' });
  assert.deepEqual(provider.describeActiveProvider({ env }), { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' });
  assert.deepEqual(provider.describeActiveProvider({ env: envWith() }), { provider: null, model: null });
});

test('cerebras keeps its conservative default maxTokens; claude gets more room', () => {
  assert.equal(provider.defaultMaxTokensFor('cerebras'), 2048);
  assert.ok(provider.defaultMaxTokensFor('anthropic') >= 4096);
});

test('isBillingExhaustedError classifies credit exhaustion errors and extends quarantine TTL', async () => {
  assert.equal(provider.isBillingExhaustedError({ status: 402, message: '402 Insufficient Balance' }), true);
  assert.equal(provider.isBillingExhaustedError({ status: 400, message: '400 {"error":{"message":"Your credit balance is too low to access the Anthropic API."}}' }), true);
  assert.equal(provider.isBillingExhaustedError({ status: 402, message: '402 Insufficient credits' }), true);
  assert.equal(provider.isBillingExhaustedError({ status: 429, message: '429 rate limit exceeded' }), false);
  assert.equal(provider.isBillingExhaustedError({ status: 503, message: 'service unavailable' }), false);

  class UnfundedAnthropic {
    // eslint-disable-next-line class-methods-use-this
    get messages() {
      return {
        create: async () => {
          const err = new Error('400 {"error":{"message":"Your credit balance is too low to access the Anthropic API."}}');
          err.status = 400;
          throw err;
        },
      };
    }
  }
  const or = fakeOpenAIStyle('ok');
  const env = envWith({ ANTHROPIC_API_KEY: 'k', OPENROUTER_API_KEY: 'k' });
  let t = 1_000_000;
  const now = () => t;
  await provider.chatComplete({ messages: [{ role: 'user', content: 'U' }], env, now, clients: { anthropicCtor: UnfundedAnthropic, openrouter: or } });
  t += provider.FAILOVER_TTL_MS + 1;
  // Still quarantined after 5 min because billing cooldown is 6h
  assert.deepEqual(provider.resolveCandidates({ env, now }), ['openrouter', 'anthropic']);
  // Rotating the API key clears quarantine immediately
  assert.deepEqual(provider.resolveCandidates({ env: { ...env, ANTHROPIC_API_KEY: 'k-rotated' }, now }), ['anthropic', 'openrouter']);
  // Re-quarantine and verify expiry after BILLING_COOLDOWN_MS
  await provider.chatComplete({ messages: [{ role: 'user', content: 'U' }], env, now, clients: { anthropicCtor: UnfundedAnthropic, openrouter: or } });
  t += provider.BILLING_COOLDOWN_MS + 1;
  assert.deepEqual(provider.resolveCandidates({ env, now }), ['anthropic', 'openrouter']);
});




test('internal selection skips a shared billing memo and reports the eligible provider', async () => {
  const env = envWith({ ANTHROPIC_API_KEY: 'test-ant', OPENROUTER_API_KEY: 'test-or' });
  billing.markOutOfCredit('anthropic', { status: 400, message: 'credit balance is too low' }, env);
  let anthropicCalls = 0;
  class Anthropic { messages = { create: async () => { anthropicCalls += 1; throw new Error('must skip unfunded key'); } }; }
  const openrouter = fakeOpenAIStyle('eligible response');
  const out = await provider.chatComplete({ messages: [], env, clients: { anthropicCtor: Anthropic, openrouter } });
  assert.equal(anthropicCalls, 0);
  assert.equal(out.content, 'eligible response');
  assert.deepEqual(provider.describeActiveProvider({ env }), { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' });
});

test('an internal call with only a memoized provider returns its cause without transport', async () => {
  const env = envWith({ ANTHROPIC_API_KEY: 'test-ant' });
  billing.markOutOfCredit('anthropic', { status: 400, message: 'credit balance is too low' }, env);
  let calls = 0;
  class Anthropic { messages = { create: async () => { calls += 1; throw new Error('transport must not run'); } }; }
  await assert.rejects(provider.chatComplete({ messages: [], env, clients: { anthropicCtor: Anthropic } }), { code: billing.UNFUNDED_MEMO_CODE });
  assert.equal(calls, 0);
  assert.deepEqual(provider.describeActiveProvider({ env }), { provider: null, model: null });
});

test('internal key-health gating skips a rejected 401 but preserves generic 403 compatibility', async () => {
  const env = envWith({ ANTHROPIC_API_KEY: 'test-ant', OPENROUTER_API_KEY: 'test-or' });
  let calls = 0;
  class Anthropic { messages = { create: async () => { calls += 1; return { content: [{ type: 'text', text: 'accepted' }] }; } }; }
  keyHealth.markRejected('anthropic', env.ANTHROPIC_API_KEY, { status: 401 }, env);
  await provider.chatComplete({ messages: [], env, clients: { anthropicCtor: Anthropic, openrouter: fakeOpenAIStyle() } });
  assert.equal(calls, 0);
  keyHealth.markRejected('anthropic', env.ANTHROPIC_API_KEY, { status: 403 }, env);
  const out = await provider.chatComplete({ messages: [], env, clients: { anthropicCtor: Anthropic } });
  assert.equal(calls, 1);
  assert.equal(out.content, 'accepted');
});

test('a rotated key or expired shared memo makes an internal provider eligible again', async (t) => {
  const env = envWith({ ANTHROPIC_API_KEY: 'test-old' });
  const start = Date.now();
  t.mock.method(Date, 'now', () => start);
  billing.markOutOfCredit('anthropic', { status: 400, message: 'credit balance is too low' }, env, { ttlMs: 1000 });
  assert.deepEqual(provider.describeActiveProvider({ env }), { provider: null, model: null });
  t.mock.method(Date, 'now', () => start + 1001);
  assert.equal(provider.describeActiveProvider({ env }).provider, 'anthropic');
  billing.markOutOfCredit('anthropic', { status: 400, message: 'credit balance is too low' }, env);
  assert.equal(provider.describeActiveProvider({ env: { ...env, ANTHROPIC_API_KEY: 'test-new' } }).provider, 'anthropic');
});

test('a selected model still probes its own key and clears shared billing only after a real answer', async () => {
  const env = envWith({ ANTHROPIC_API_KEY: 'test-ant', OPENROUTER_API_KEY: 'test-or' });
  billing.markOutOfCredit('anthropic', { status: 400, message: 'credit balance is too low' }, env);
  let calls = 0;
  class Anthropic { messages = { create: async () => { calls += 1; return { content: [{ type: 'text', text: 'recovered answer' }] }; } }; }
  const openrouter = fakeOpenAIStyle();
  const out = await provider.chatComplete({ messages: [], model: 'claude-sonnet-4-6', env, clients: { anthropicCtor: Anthropic, openrouter } });
  assert.equal(out.content, 'recovered answer');
  assert.equal(calls, 1);
  assert.equal(openrouter.calls.length, 0);
  assert.equal(billing.isOutOfCredit('anthropic', env), false);
  assert.equal(keyHealth.isRejected('anthropic', env.ANTHROPIC_API_KEY), false);
});

test('an empty selected response does not erase billing evidence', async () => {
  const env = envWith({ ANTHROPIC_API_KEY: 'test-ant' });
  billing.markOutOfCredit('anthropic', { status: 400, message: 'credit balance is too low' }, env);
  class Anthropic { messages = { create: async () => ({ content: [] }) }; }
  await provider.chatComplete({ messages: [], model: 'claude-sonnet-4-6', env, clients: { anthropicCtor: Anthropic } });
  assert.equal(billing.isOutOfCredit('anthropic', env), true);
});

test('a selected response keeps an unrelated key-health auth rejection', async () => {
  const env = envWith({ ANTHROPIC_API_KEY: 'test-ant' });
  keyHealth.markRejected('anthropic', env.ANTHROPIC_API_KEY, { status: 401 }, env);
  class Anthropic { messages = { create: async () => ({ content: [{ type: 'text', text: 'accepted' }] }) }; }
  await provider.chatComplete({ messages: [], model: 'claude-sonnet-4-6', env, clients: { anthropicCtor: Anthropic } });
  assert.equal(keyHealth.rejectionReason('anthropic', env.ANTHROPIC_API_KEY), 'auth');
});

test('an old-key answer cannot clear a new-key billing memo', async () => {
  const env = envWith({ ANTHROPIC_API_KEY: 'test-old' });
  class Anthropic { messages = { create: async () => {
    env.ANTHROPIC_API_KEY = 'test-new';
    billing.markOutOfCredit('anthropic', { status: 400, message: 'credit balance is too low' }, env);
    return { content: [{ type: 'text', text: 'old-key answer' }] };
  } }; }
  await provider.chatComplete({ messages: [], model: 'claude-sonnet-4-6', env, clients: { anthropicCtor: Anthropic } });
  assert.equal(billing.isOutOfCredit('anthropic', env), true);
  assert.equal(keyHealth.isRejected('anthropic', env.ANTHROPIC_API_KEY), true);
});


test('internal last-resort candidates also respect the shared memo', async (t) => {
  const env = envWith({ ANTHROPIC_API_KEY: 'test-ant', XAI_API_KEY: 'test-xai', GEMINI_API_KEY: 'test-gemini' });
  billing.markOutOfCredit('anthropic', { status: 400, message: 'credit balance is too low' }, env);
  billing.markOutOfCredit('xai', { status: 402, message: 'insufficient credits' }, env);
  const structured = require('../src/services/ai/structured-generation');
  const routed = [];
  t.mock.method(structured, 'clientForModel', (model) => {
    routed.push(model);
    return { model, provider: 'Gemini', client: fakeOpenAIStyle('funded answer') };
  });
  const result = await provider.chatComplete({ messages: [], env });
  assert.deepEqual(routed, ['gemini-2.5-flash']);
  assert.equal(result.content, 'funded answer');
});

test('a selected provider failure keeps the original error and shared evidence', async () => {
  const env = envWith({ ANTHROPIC_API_KEY: 'test-ant', OPENROUTER_API_KEY: 'test-or' });
  const failure = Object.assign(new Error('credit balance is too low'), { status: 400 });
  billing.markOutOfCredit('anthropic', failure, env);
  let calls = 0;
  class Anthropic { messages = { create: async () => { calls += 1; throw failure; } }; }
  const openrouter = fakeOpenAIStyle();
  await assert.rejects(provider.chatComplete({ messages: [], model: 'claude-sonnet-4-6', env,
    clients: { anthropicCtor: Anthropic, openrouter } }), (error) => error === failure);
  assert.equal(calls, 1);
  assert.equal(openrouter.calls.length, 0);
  assert.equal(billing.isOutOfCredit('anthropic', env), true);
});


test('a selected first-party answer cannot clear a replacement key outside the internal ladder', async () => {
  const env = envWith({ OPENAI_API_KEY: 'test-old' });
  class OpenAI { chat = { completions: { create: async () => {
    env.OPENAI_API_KEY = 'test-new';
    billing.markOutOfCredit('openai', { status: 402, message: 'insufficient credits' }, env);
    return { choices: [{ message: { content: 'old-key answer' } }] };
  } } }; }
  await provider.chatComplete({ messages: [], model: 'gpt-6', env, clients: { openAICtor: OpenAI } });
  assert.equal(billing.isOutOfCredit('openai', env), true);
  assert.equal(keyHealth.isRejected('openai', env.OPENAI_API_KEY), true);
});
