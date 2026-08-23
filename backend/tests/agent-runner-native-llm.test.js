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

  test('runAgentLoop cuts a same-tool+args repeat loop with loop_cut (PPTX incident)', async () => {
    const loopingClient = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: `call_${Math.random().toString(36).slice(2, 8)}`,
                  type: 'function',
                  function: { name: 'execute_python', arguments: JSON.stringify({ code: 'print(1)' }) },
                }],
              },
            }],
          }),
        },
      },
    };
    let executions = 0;
    const events = [];
    const result = await loop.runAgentLoop({
      client: loopingClient,
      model: FLASH,
      messages: [{ role: 'user', content: 'haz la lámina' }],
      tools: [],
      executors: { execute_python: async () => { executions += 1; return 'ok'; } },
      maxIterations: 25,
      onEvent: (e) => events.push(e),
    });
    assert.equal(result.stoppedReason, 'loop_cut');
    assert.equal(result.errorCode, 'loop_cut');
    // Cut at the adapter's IDENTICAL_CONSECUTIVE=2 — far below the 25 budget.
    assert.ok(executions <= 3);
    assert.ok(events.some((e) => e.code === 'loop_cut' && /repitió el mismo paso/.test(e.message)));
    // The loop must NOT close with an honest-looking final.
    assert.ok(!events.some((e) => e.type === 'final'));
  });

  test('runAgentLoop exhausted budget without deliverable emits error, not a fake final', async () => {
    // Distinct args every turn → no repeat-cut; loop runs to exhaustion.
    let n = 0;
    const variedClient = {
      chat: {
        completions: {
          create: async () => {
            n += 1;
            return {
              choices: [{
                message: {
                  content: null,
                  tool_calls: [{
                    id: `call_${n}`,
                    type: 'function',
                    function: { name: 'execute_bash', arguments: JSON.stringify({ command: `echo step-${n}` }) },
                  }],
                },
              }],
            };
          },
        },
      },
    };
    const events = [];
    const result = await loop.runAgentLoop({
      client: variedClient,
      model: FLASH,
      messages: [{ role: 'user', content: 'trabajo largo' }],
      tools: [],
      executors: { execute_bash: async () => 'ok' },
      maxIterations: 4,
      onEvent: (e) => events.push(e),
    });
    assert.equal(result.stoppedReason, 'max_iterations');
    assert.equal(result.errorCode, 'budget_exceeded');
    assert.ok(!events.some((e) => e.type === 'final'));
    assert.ok(events.some((e) => e.code === 'budget_exceeded'));
  });

  test('runAgentLoop still finishes honestly when the model delivers text after tool work', async () => {
    let n = 0;
    const finishingClient = {
      chat: {
        completions: {
          create: async () => {
            n += 1;
            if (n === 1) {
              return {
                choices: [{
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: 'c1',
                        type: 'function',
                        function: { name: 'execute_bash', arguments: JSON.stringify({ command: 'ls' }) },
                      },
                      {
                        id: 'c2',
                        type: 'function',
                        function: { name: 'render_preview', arguments: JSON.stringify({ path: 'outputs/a.pptx' }) },
                      },
                    ],
                  },
                }],
              };
            }
            return { choices: [{ message: { content: 'Deck terminado y verificado.' } }] };
          },
        },
      },
    };
    const events = [];
    const result = await loop.runAgentLoop({
      client: finishingClient,
      model: FLASH,
      messages: [{ role: 'user', content: 'x' }],
      tools: [],
      executors: { execute_bash: async () => 'done', render_preview: async () => ({ ok: true }) },
      maxIterations: 5,
      onEvent: (e) => events.push(e),
    });
    assert.equal(result.stoppedReason, 'final');
    assert.equal(result.finalText, 'Deck terminado y verificado.');
    assert.ok(events.some((e) => e.type === 'final' && e.verified === true));
  });
});
