'use strict';

// Claude-style extended thinking — reasoning streaming pipeline.
//
// Pins the three layers added for the thinking-trace feature:
//   1. Gateway (litellm-gateway): the OpenRouter `reasoning: { effort }`
//      param is sent ONLY to models that support it (catalog flag, family
//      allowlist, env force/block CSVs), defaults to effort=medium, and is
//      fully omitted otherwise. History sanitisation keeps the raw
//      `reasoning_details` (signed Anthropic thinking) for OpenRouter and
//      strips it for every other provider.
//   2. Stream (ai-service.generateStream): `delta.reasoning` /
//      `delta.reasoning_content` is forwarded as typed SSE frames —
//      `reasoning_delta` (key `reasoning`, NOT `content`, so stale clients
//      ignore it), `text_delta` (keeps `content` for backward compat),
//      `tool_call_delta`, and a final `reasoning_done` with durationMs.
//   3. Sink: the route-level collector receives { text, details, durationMs }
//      for persistence on the Message row.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const gateway = require('../src/services/ai-product-os/litellm-gateway');
const service = require('../src/services/ai-service');

const ENV_KEYS = [
  'SIRAGPT_OPENROUTER_REASONING_FORCE',
  'SIRAGPT_OPENROUTER_REASONING_BLOCK',
  'SIRAGPT_OPENROUTER_REASONING_EFFORT',
  'SIRAGPT_REASONING_STREAM',
];

let savedEnv;
beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── 1. Gateway: per-model reasoning support ───────────────────────────────

describe('openRouterModelSupportsReasoning', () => {
  test('known reasoning families are supported', () => {
    for (const id of [
      'anthropic/claude-sonnet-4.5',
      'openai/o3-mini',
      'openai/gpt-5',
      'deepseek/deepseek-r1',
      'google/gemini-2.5-pro',
      'x-ai/grok-4',
      'openai/gpt-oss-120b',
    ]) {
      assert.equal(gateway.openRouterModelSupportsReasoning(id, null), true, id);
    }
  });

  test('non-reasoning models are NOT supported (param omitted)', () => {
    for (const id of ['meta-llama/llama-3.1-8b-instruct', 'mistralai/mistral-7b-instruct', '']) {
      assert.equal(gateway.openRouterModelSupportsReasoning(id, null), false, id || '(empty)');
    }
  });

  test('catalog reasoning flag wins for unknown families', () => {
    assert.equal(gateway.openRouterModelSupportsReasoning('somevendor/new-model', { reasoning: true }), true);
    assert.equal(gateway.openRouterModelSupportsReasoning('somevendor/new-model', { reasoning: false }), false);
  });

  test('env CSV force/block overrides', () => {
    process.env.SIRAGPT_OPENROUTER_REASONING_FORCE = 'somevendor/new';
    assert.equal(gateway.openRouterModelSupportsReasoning('somevendor/new-model', null), true);
    process.env.SIRAGPT_OPENROUTER_REASONING_BLOCK = 'claude';
    assert.equal(gateway.openRouterModelSupportsReasoning('anthropic/claude-sonnet-4.5', null), false);
  });
});

describe('resolveOpenRouterReasoningEffort', () => {
  test('defaults to medium (spec), env overridable', () => {
    assert.equal(gateway.resolveOpenRouterReasoningEffort(undefined), 'medium');
    assert.equal(gateway.resolveOpenRouterReasoningEffort('high'), 'medium'); // DeepSeek-era global default ≠ user choice
    process.env.SIRAGPT_OPENROUTER_REASONING_EFFORT = 'high';
    assert.equal(gateway.resolveOpenRouterReasoningEffort(undefined), 'high');
  });

  test('explicit levels map through', () => {
    assert.equal(gateway.resolveOpenRouterReasoningEffort('low'), 'low');
    assert.equal(gateway.resolveOpenRouterReasoningEffort('max'), 'high');
    assert.equal(gateway.resolveOpenRouterReasoningEffort('xhigh'), 'high');
  });
});

describe('buildProviderChatPayload — OpenRouter reasoning param', () => {
  test('supported model gets reasoning effort medium', () => {
    const { payload } = gateway.buildProviderChatPayload({
      provider: 'OpenRouter',
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hola' }],
      stream: true,
    });
    assert.deepEqual(payload.reasoning, { effort: 'medium' });
  });

  test('unsupported model: reasoning param fully omitted', () => {
    const { payload } = gateway.buildProviderChatPayload({
      provider: 'OpenRouter',
      model: 'meta-llama/llama-3.1-8b-instruct',
      messages: [{ role: 'user', content: 'hola' }],
      stream: true,
    });
    assert.equal('reasoning' in payload, false);
  });

  test('disabled thinking level → exclude (model thinks, nothing streamed)', () => {
    const { payload } = gateway.buildProviderChatPayload({
      provider: 'OpenRouter',
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hola' }],
      thinkingLevel: 'off',
    });
    assert.deepEqual(payload.reasoning, { exclude: true });
  });

  test('caller-supplied reasoning via extra is never overridden', () => {
    const { payload } = gateway.buildProviderChatPayload({
      provider: 'OpenRouter',
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: 'hola' }],
      extra: { reasoning: { exclude: true } },
    });
    assert.deepEqual(payload.reasoning, { exclude: true });
  });

  test('non-OpenRouter providers never receive the unified reasoning param', () => {
    const { payload } = gateway.buildProviderChatPayload({
      provider: 'OpenAI',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hola' }],
    });
    assert.equal('reasoning' in payload, false);
  });
});

describe('sanitizeMessagesForProvider — reasoning_details replay', () => {
  const history = () => ([
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: 'respuesta', reasoning: 'pensé', reasoning_details: [{ type: 'reasoning.encrypted', data: 'sig' }] },
  ]);

  test('kept verbatim for OpenRouter (signed Anthropic thinking chain)', () => {
    const { payload } = gateway.buildProviderChatPayload({
      provider: 'OpenRouter',
      model: 'anthropic/claude-sonnet-4.5',
      messages: history(),
    });
    const assistant = payload.messages.find((m) => m.role === 'assistant');
    assert.deepEqual(assistant.reasoning_details, [{ type: 'reasoning.encrypted', data: 'sig' }]);
  });

  test('stripped for every other provider (unknown field would 400)', () => {
    const { payload } = gateway.buildProviderChatPayload({
      provider: 'OpenAI',
      model: 'gpt-4o',
      messages: history(),
    });
    const assistant = payload.messages.find((m) => m.role === 'assistant');
    assert.equal('reasoning_details' in assistant, false);
    assert.equal('reasoning' in assistant, false);
  });
});

// ── 2/3. Stream: typed SSE frames + sink ─────────────────────────────────

function makeFakeStream(chunks) {
  return { [Symbol.asyncIterator]: async function* gen() { for (const c of chunks) yield c; } };
}

function fakeRes() {
  const frames = [];
  return {
    frames,
    writableEnded: false,
    destroyed: false,
    write(s) { frames.push(String(s)); return true; },
  };
}

function parseDataFrames(frames) {
  return frames
    .filter((f) => f.startsWith('data: ') && !f.includes('[DONE]'))
    .map((f) => { try { return JSON.parse(f.slice(6)); } catch { return null; } })
    .filter(Boolean);
}

async function runStreamWith(chunks, { reasoningSink = {}, env = {} } = {}) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const res = fakeRes();
  const originalGetClient = service.getClient;
  service.getClient = () => ({
    chat: { completions: { create: async () => makeFakeStream(chunks) } },
  });
  try {
    const out = await service.generateStream({
      provider: 'OpenRouter',
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hola' }],
      res,
      qualityGuard: false,
      skipDoneSentinel: true,
      reasoningSink,
    });
    return { out, events: parseDataFrames(res.frames), sink: reasoningSink };
  } finally {
    service.getClient = originalGetClient;
  }
}

describe('generateStream — typed reasoning SSE frames', () => {
  test('reasoning deltas stream, close with reasoning_done, then text deltas', async () => {
    const { out, events, sink } = await runStreamWith([
      { choices: [{ delta: { reasoning: 'Pienso ' } }] },
      { choices: [{ delta: { reasoning: 'mucho.', reasoning_details: [{ type: 'reasoning.text', text: 'Pienso mucho.' }] } }] },
      { choices: [{ delta: { content: 'Hola' } }] },
      { choices: [{ delta: { content: ' mundo' } }] },
    ]);

    assert.equal(out, 'Hola mundo');

    const types = events.map((e) => e.type);
    const firstText = types.indexOf('text_delta');
    const doneIdx = types.indexOf('reasoning_done');
    assert.deepEqual(types.filter((t) => t === 'reasoning_delta').length, 2);
    assert.ok(doneIdx !== -1, 'reasoning_done emitted');
    assert.ok(doneIdx < firstText, 'reasoning closes BEFORE the first visible token');
    assert.equal(typeof events[doneIdx].durationMs, 'number');

    // Backward compat: text frames keep `content`; reasoning frames must NOT
    // carry `content` (a stale client appends every `content` it sees).
    for (const e of events) {
      if (e.type === 'text_delta') assert.equal(typeof e.content, 'string');
      if (e.type === 'reasoning_delta') {
        assert.equal(typeof e.reasoning, 'string');
        assert.equal('content' in e, false);
      }
    }

    // Sink for persistence.
    assert.equal(sink.text, 'Pienso mucho.');
    assert.deepEqual(sink.details, [{ type: 'reasoning.text', text: 'Pienso mucho.' }]);
    assert.equal(typeof sink.durationMs, 'number');
  });

  test('DeepSeek-style reasoning_content is forwarded the same way', async () => {
    const { events, sink } = await runStreamWith([
      { choices: [{ delta: { reasoning_content: 'razono' } }] },
      { choices: [{ delta: { content: 'listo' } }] },
    ]);
    assert.ok(events.some((e) => e.type === 'reasoning_delta' && e.reasoning === 'razono'));
    assert.equal(sink.text, 'razono');
  });

  test('non-reasoning stream: only text deltas, no reasoning frames, empty sink', async () => {
    const { out, events, sink } = await runStreamWith([
      { choices: [{ delta: { content: 'Hola' } }] },
      { choices: [{ delta: { content: '!' } }] },
    ]);
    assert.equal(out, 'Hola!');
    assert.ok(events.every((e) => e.type !== 'reasoning_delta' && e.type !== 'reasoning_done'));
    assert.equal(sink.text, undefined);
  });

  test('tool_call_delta frames carry name + partial args', async () => {
    const { events } = await runStreamWith([
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'web_search', arguments: '{"q":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"clima"}' } }] } }] },
      { choices: [{ delta: { content: 'ok' } }] },
    ]);
    const toolEvents = events.filter((e) => e.type === 'tool_call_delta');
    assert.equal(toolEvents.length, 2);
    assert.equal(toolEvents[0].name, 'web_search');
    assert.equal(toolEvents[0].argsDelta, '{"q":');
    assert.equal(toolEvents[1].argsDelta, '"clima"}');
  });

  test('kill switch SIRAGPT_REASONING_STREAM=0 restores legacy behaviour', async () => {
    const { out, events, sink } = await runStreamWith(
      [
        { choices: [{ delta: { reasoning: 'oculto' } }] },
        { choices: [{ delta: { content: 'visible' } }] },
      ],
      { env: { SIRAGPT_REASONING_STREAM: '0' } },
    );
    assert.equal(out, 'visible');
    assert.ok(events.every((e) => e.type !== 'reasoning_delta' && e.type !== 'reasoning_done'));
    assert.equal(sink.text, undefined);
  });
});
