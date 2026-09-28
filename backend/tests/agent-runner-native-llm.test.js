const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  FLASH,
  PRO,
  MAX_TOKENS_DEFAULT,
  resolveNativeDeepSeekModel,
  hasUsableDeepSeekKey,
  repairToolArgs,
  isTransientLlmError,
  backoffMs,
} = require('../src/services/agent-runner/native-llm');

const loop = require('../src/services/agent-runner/loop');

describe('native-llm module', () => {
  test('tiers and anti-402 cap', () => {
    assert.match(FLASH, /deepseek-v4-flash/);
    assert.match(PRO, /deepseek-v4-pro/);
    assert.equal(MAX_TOKENS_DEFAULT, 2048);
    assert.equal(loop.MAX_TOKENS_DEFAULT, 2048);
  });

  test('resolveNativeDeepSeekModel tier mapping', () => {
    assert.equal(resolveNativeDeepSeekModel(''), FLASH);
    assert.equal(resolveNativeDeepSeekModel(null), FLASH);
    assert.equal(resolveNativeDeepSeekModel('deepseek-v4-pro'), PRO);
    assert.equal(resolveNativeDeepSeekModel('DEEPSEEK-REASONER'), PRO);
    assert.equal(resolveNativeDeepSeekModel('deepseek-chat'), FLASH);
    assert.equal(resolveNativeDeepSeekModel('whatever'), FLASH);
  });

  test('hasUsableDeepSeekKey rejects missing/placeholder keys', () => {
    assert.equal(hasUsableDeepSeekKey({}), false);
    assert.equal(hasUsableDeepSeekKey({ DEEPSEEK_API_KEY: 'your_key_here' }), false);
    assert.equal(hasUsableDeepSeekKey({ DEEPSEEK_API_KEY: 'sk-reallylongkey1234567890abcdef' }), true);
  });

  test('repairToolArgs salvages broken JSON', () => {
    // clean JSON
    assert.deepEqual(repairToolArgs('{"a":1}'), { ok: true, value: { a: 1 } });
    // object passthrough
    assert.deepEqual(repairToolArgs({ a: 2 }), { ok: true, value: { a: 2 } });
    // null → empty args
    assert.deepEqual(repairToolArgs(null), { ok: true, value: {} });
    // fenced
    assert.deepEqual(repairToolArgs('```json\n{"path":"x"}\n```'), { ok: true, value: { path: 'x' } });
    // trailing comma
    assert.deepEqual(repairToolArgs('{"a":1,}'), { ok: true, value: { a: 1 } });
    // trailing prose after the object
    assert.deepEqual(repairToolArgs('{"cmd":"ls"} hope this works'), { ok: true, value: { cmd: 'ls' } });
    // single quotes (no double quotes present)
    assert.deepEqual(repairToolArgs("{'code':'print(1)'}"), { ok: true, value: { code: 'print(1)' } });
    // hopeless garbage fails cleanly
    assert.equal(repairToolArgs('{not json at all').ok, false);
  });

  test('isTransientLlmError classifies retryable vs permanent', () => {
    assert.equal(isTransientLlmError({ status: 429 }), true);
    assert.equal(isTransientLlmError({ status: 503 }), true);
    assert.equal(isTransientLlmError({ status: 402 }), false);
    assert.equal(isTransientLlmError({ status: 400 }), false);
    assert.equal(isTransientLlmError(new Error('socket hang up')), true);
    assert.equal(isTransientLlmError(null), false);
  });

  test('backoffMs grows exponentially and caps', () => {
    const a = backoffMs(0, { jitter: false });
    const b = backoffMs(3, { jitter: false });
    const c = backoffMs(10, { jitter: false, maxMs: 8000 });
    assert.equal(a, 500);
    assert.ok(b > a);
    assert.ok(c <= 8000);
  });

  test('loop exports stall-guard primitives', () => {
    assert.equal(typeof loop.stallIfNoEvent20sMidStream, 'function');
    assert.equal(typeof loop.heartbeatFence, 'function');
    assert.equal(typeof loop.stealStaleFence, 'function');
    assert.equal(typeof loop.classifyLoopError, 'function');
  });

  test('stallIfNoEvent20sMidStream flags idle beyond budget', () => {
    const t0 = 1_000_000;
    // No event for 25s with a 20s budget → stalled.
    assert.equal(loop.stallIfNoEvent20sMidStream({ lastEventAt: t0, now: t0 + 25_000 }).stalled, true);
    // Event 10s ago → not stalled.
    assert.equal(loop.stallIfNoEvent20sMidStream({ lastEventAt: t0, now: t0 + 10_000 }).stalled, false);
    // First token (newer than generation start) is the anchor: 35s since the
    // token arrived with a 20s budget → stalled.
    assert.equal(loop.stallIfNoEvent20sMidStream({ lastEventAt: t0, firstTokenAt: t0 + 30_000, now: t0 + 55_000 }).stalled, true);
    // Missing anchors → never stalls.
    assert.equal(loop.stallIfNoEvent20sMidStream({}).stalled, false);
  });

  test('classifyLoopError returns Spanish copy for loop_stall', () => {
    const c = loop.classifyLoopError({ code: 'loop_stall' });
    assert.equal(c.code, 'loop_stall');
    assert.equal(c.retryable, false);
    assert.ok(c.message.includes('bucle'));
  });

  test('heartbeatFence writes lease; stealStaleFence honors freshness', async () => {
    const store = new Map();
    const kv = {
      get: async (k) => store.get(k),
      set: async (k, v) => { store.set(k, v); },
    };
    assert.equal(await loop.heartbeatFence(kv, 'thread-1', 'tok-1', { now: 1000 }), true);
    const fresh = await loop.stealStaleFence(kv, 'thread-1', { now: 2000 });
    assert.equal(fresh.stolen, false);
    assert.equal(fresh.token, 'tok-1');
    // 61s later the fence is expired → stealable.
    const stale = await loop.stealStaleFence(kv, 'thread-1', { now: 62_000 });
    assert.equal(stale.stolen, true);
    // No KV → fail-open steal.
    assert.equal((await loop.stealStaleFence(null, 'thread-1')).stolen, true);
  });

  test('runAgentLoop stops with loop_stall when provider never progresses', async () => {
    let calls = 0;
    const hangingClient = {
      chat: {
        completions: {
          create: async () => {
            calls += 1;
            // Simulate a provider that accepts the call but never yields:
            // each iteration "succeeds" without tool calls or content.
            return { choices: [{ message: { content: '' } }] };
          },
        },
      },
    };
    const events = [];
    const result = await loop.runAgentLoop({
      client: hangingClient,
      model: FLASH,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      executors: {},
      maxIterations: 10,
      onEvent: (e) => events.push(e),
      stallMs: 30, // tiny budget so the synthetic clock trips immediately
    });
    assert.equal(result.stoppedReason, 'loop_stall');
    assert.equal(result.errorCode, 'loop_stall');
    assert.ok(calls <= 3);
    assert.ok(events.some((e) => e.code === 'loop_stall'));
  });

  test('DeepSeek thinking is replayed unchanged after a tool call', async () => {
    const messages = [{ role: 'user', content: 'lee un archivo' }];
    const seen = [];
    const client = { chat: { completions: { create: async (payload) => {
      seen.push(payload);
      if (seen.length === 1) {
        return { choices: [{ message: {
          content: '',
          reasoning_content: 'razonamiento devuelto por el proveedor',
          tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
        } }] };
      }
      assert.equal(payload.messages[1].reasoning_content, 'razonamiento devuelto por el proveedor');
      const replayedCall = payload.messages[1].tool_calls[0];
      assert.deepEqual(Object.keys(replayedCall).sort(), ['function', 'id', 'type'], 'provider transcript must not contain internal tool-call fields');
      assert.deepEqual(Object.keys(replayedCall.function).sort(), ['arguments', 'name']);
      assert.equal(replayedCall.id, 'read-1');
      assert.equal(replayedCall.function.arguments, '{"path":"a.txt"}');
      assert.equal(payload.messages[2].role, 'tool');
      assert.equal(payload.messages[2].tool_call_id, 'read-1');
      return { choices: [{ message: { content: 'Leí el archivo.' } }] };
    } } } };
    const result = await loop.runAgentLoop({
      client,
      model: 'deepseek-v4-pro',
      messages,
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
      executors: { read_file: async () => 'contenido' },
      maxIterations: 2,
    });
    assert.equal(result.finalText, 'Leí el archivo.');
    assert.equal(seen.length, 2);
  });

  test('native GPT 6 uses max_completion_tokens; DeepSeek and OpenRouter keep max_tokens', async () => {
    const calls = [];
    const client = { chat: { completions: { create: async (payload) => {
      calls.push(payload);
      return { choices: [{ message: { content: 'ok' } }] };
    } } } };
    await loop.callModel({ client, model: 'gpt-6-sol', messages: [{ role: 'user', content: 'hola' }], tools: [], maxTokens: 500 });
    await loop.callModel({ client, model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hola' }], tools: [], maxTokens: 500 });
    await loop.callModel({ client, model: 'openai/gpt-6-sol', messages: [{ role: 'user', content: 'hola' }], tools: [], maxTokens: 500 });
    await loop.callModel({ client: { ...client, describe: () => ({ provider: 'OpenAI' }) }, model: 'openai/gpt-6-sol', messages: [{ role: 'user', content: 'hola' }], tools: [], maxTokens: 500 });
    assert.equal(calls[0].max_completion_tokens, 500);
    assert.equal('max_tokens' in calls[0], false);
    assert.equal('temperature' in calls[0], false, 'AgentRunner must not add the unsupported sampling field');
    assert.equal(calls[1].max_tokens, 500);
    assert.equal('max_completion_tokens' in calls[1], false);
    assert.equal(calls[2].max_tokens, 500);
    assert.equal('max_completion_tokens' in calls[2], false);
    assert.equal(calls[3].max_completion_tokens, 500, 'the actual first-party transport overrides the model slug');
    assert.equal('max_tokens' in calls[3], false);
  });
});
