'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const provider = require('../src/services/codex/llm-provider');

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

test.beforeEach(() => provider.resetQuarantine());

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
