'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const reactAgent = require('../src/services/react-agent');

function makeTool(name, executeFn) {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    execute: executeFn,
  };
}

function call(id, name) {
  return { id, function: { name, arguments: '{}' } };
}

describe('isParallelSafeTool', () => {
  test('read-only / idempotent tools are parallel-safe', () => {
    for (const n of ['web_search', 'rag_retrieve', 'read_url', 'scientific_search', 'github_search', 'search_docs', 'read_file', 'deep_analyze', 'session_search']) {
      assert.equal(reactAgent.isParallelSafeTool(n), true, `${n} should be safe`);
    }
  });
  test('mutating / stateful / finalize tools are NOT parallel-safe', () => {
    for (const n of ['finalize', 'host_bash', 'host_file', 'python_exec', 'propose_patch', 'create_document', 'generate_image', 'browser_click', 'session_spawn', 'clone_project', 'run_tests']) {
      assert.equal(reactAgent.isParallelSafeTool(n), false, `${n} should NOT be safe`);
    }
  });
});

describe('prefetchParallelDispatch', () => {
  test('dispatches >=2 read-only calls CONCURRENTLY, skips mutating ones', async () => {
    let active = 0;
    let maxActive = 0;
    const slow = (val) => async () => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 25));
      active -= 1;
      return { ok: true, val };
    };
    const registry = [makeTool('web_search', slow('a')), makeTool('rag_retrieve', slow('b')), makeTool('host_bash', slow('c'))];
    const calls = [call('1', 'web_search'), call('2', 'rag_retrieve'), call('3', 'host_bash')];

    const map = await reactAgent.prefetchParallelDispatch(registry, calls, {}, new Set());
    assert.ok(map.has('1') && map.has('2'), 'read-only calls prefetched');
    assert.ok(!map.has('3'), 'mutating call NOT prefetched (runs sequentially in the loop)');
    assert.ok(maxActive >= 2, `expected concurrency >=2, saw ${maxActive}`);
    assert.deepEqual(map.get('1').result, { ok: true, val: 'a' });
  });

  test('fewer than 2 safe calls → no parallelism (empty map)', async () => {
    const registry = [makeTool('web_search', async () => ({ ok: true })), makeTool('host_bash', async () => ({ ok: true }))];
    const map = await reactAgent.prefetchParallelDispatch(registry, [call('1', 'web_search'), call('2', 'host_bash')], {}, new Set());
    assert.equal(map.size, 0);
  });

  test('exhausted tools are excluded from prefetch', async () => {
    const registry = [makeTool('web_search', async () => ({ ok: true })), makeTool('rag_retrieve', async () => ({ ok: true }))];
    // web_search exhausted → only 1 safe left → no parallelism
    const map = await reactAgent.prefetchParallelDispatch(registry, [call('1', 'web_search'), call('2', 'rag_retrieve')], {}, new Set(['web_search']));
    assert.equal(map.size, 0);
  });

  test('a thrown tool error is captured as {error}, peers still resolve', async () => {
    const registry = [
      makeTool('web_search', async () => { throw new Error('boom'); }),
      makeTool('rag_retrieve', async () => ({ ok: true })),
    ];
    const map = await reactAgent.prefetchParallelDispatch(registry, [call('1', 'web_search'), call('2', 'rag_retrieve')], {}, new Set());
    assert.ok(map.get('1').error, 'failed tool → error observation');
    assert.deepEqual(map.get('2').result, { ok: true });
  });

  test('respects the concurrency cap (chunks)', async () => {
    let active = 0;
    let maxActive = 0;
    const slow = () => async () => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
      return { ok: true };
    };
    // 6 safe calls; cap is TOOL_PARALLEL_MAX (default 4)
    const names = ['web_search', 'rag_retrieve', 'read_url', 'search_docs', 'scientific_search', 'github_search'];
    const registry = names.map((n) => makeTool(n, slow()));
    const calls = names.map((n, i) => call(String(i), n));
    await reactAgent.prefetchParallelDispatch(registry, calls, {}, new Set());
    assert.ok(maxActive <= reactAgent.TOOL_PARALLEL_MAX, `concurrency ${maxActive} exceeded cap ${reactAgent.TOOL_PARALLEL_MAX}`);
  });

  test('garbage input never throws', async () => {
    await assert.doesNotReject(reactAgent.prefetchParallelDispatch([], null, {}, new Set()));
  });
});

// ── A3: one-shot tool fallback ──────────────────────────────────────────────
function makeScriptedOpenAI(script) {
  let i = 0;
  let callId = 0;
  return {
    chat: {
      completions: {
        create: async (params) => {
          const forcedFinalize = params.tool_choice && typeof params.tool_choice === 'object'
            && params.tool_choice.function?.name === 'finalize';
          const entry = forcedFinalize ? { finalize: 'forced' } : (script[i] || { finalize: 'default' });
          i += 1; callId += 1;
          const toolCall = entry.finalize != null
            ? { id: `call_${callId}`, type: 'function', function: { name: 'finalize', arguments: JSON.stringify({ answer: entry.finalize }) } }
            : { id: `call_${callId}`, type: 'function', function: { name: entry.tool, arguments: JSON.stringify(entry.args || {}) } };
          return { choices: [{ message: { role: 'assistant', content: 'thinking', tool_calls: [toolCall] } }] };
        },
      },
    },
  };
}

describe('fallbackToolFor', () => {
  test('maps search/read families to compatible alternatives', () => {
    assert.equal(reactAgent.fallbackToolFor('web_search'), 'deep_search');
    assert.equal(reactAgent.fallbackToolFor('scientific_search'), 'web_search');
    assert.equal(reactAgent.fallbackToolFor('read_url'), 'web_extract');
    assert.equal(reactAgent.fallbackToolFor('rag_retrieve'), 'search_docs');
    assert.equal(reactAgent.fallbackToolFor('unknown_tool'), null);
  });
});

describe('A3 — in-loop tool fallback recovery', () => {
  test('a failing web_search auto-recovers via deep_search and never counts the failure', async () => {
    let deepCalled = 0;
    const webSearch = makeTool('web_search', async () => { throw new Error('web boom'); });
    const deepSearch = makeTool('deep_search', async () => { deepCalled += 1; return { ok: true, hits: ['x'] }; });
    const openai = makeScriptedOpenAI([{ tool: 'web_search', args: { query: 'q' } }, { finalize: 'done' }]);

    const result = await reactAgent.run(openai, { query: 'test', tools: [webSearch, deepSearch], model: 'gpt-4o', maxSteps: 4 });
    assert.ok(deepCalled >= 1, 'fallback deep_search executed');
    const action = result.steps.flatMap((s) => s.actions).find((a) => a.tool === 'web_search');
    assert.ok(action, 'web_search step recorded');
    assert.equal(action.observation._recovered_from, 'web_search');
    assert.equal(action.observation._recovered_via, 'deep_search');
    assert.equal(action.observation.ok, true);
  });

  test('no fallback when the alternative is absent → original error stands', async () => {
    const webSearch = makeTool('web_search', async () => { throw new Error('web boom'); });
    // deep_search NOT in registry → no recovery
    const openai = makeScriptedOpenAI([{ tool: 'web_search', args: { query: 'q' } }, { finalize: 'done' }]);
    const result = await reactAgent.run(openai, { query: 'test', tools: [webSearch], model: 'gpt-4o', maxSteps: 4 });
    const action = result.steps.flatMap((s) => s.actions).find((a) => a.tool === 'web_search');
    assert.ok(action.observation.error, 'original error preserved when no alternative');
  });
});

describe('prefetch straggler cap (partial batch results)', () => {
  test('a hung read-only tool no longer stalls the batch; it is handed back pending', async () => {
    const prev = process.env.SIRAGPT_TOOL_PREFETCH_TIMEOUT_MS;
    process.env.SIRAGPT_TOOL_PREFETCH_TIMEOUT_MS = '50';
    try {
      let release;
      const gate = new Promise((r) => { release = r; });
      const registry = [
        makeTool('web_search', async () => { await gate; return { ok: true, slow: true }; }),
        makeTool('rag_retrieve', async () => ({ ok: true, fast: true })),
      ];
      const calls = [call('1', 'web_search'), call('2', 'rag_retrieve')];
      const t0 = Date.now();
      const map = await reactAgent.prefetchParallelDispatch(registry, calls, {}, new Set());
      assert.ok(Date.now() - t0 < 2000, 'batch returns at the cap, not when the straggler finishes');
      assert.deepEqual(map.get('2').result, { ok: true, fast: true }, 'fast peer resolved normally');
      const slowEntry = map.get('1');
      assert.ok(slowEntry.__pending, 'straggler handed back as {__pending: Promise} — no re-dispatch');
      release();
      const resolved = await slowEntry.__pending;
      assert.deepEqual(resolved.result, { ok: true, slow: true }, 'pending promise resolves to the real result');
    } finally {
      if (prev === undefined) delete process.env.SIRAGPT_TOOL_PREFETCH_TIMEOUT_MS;
      else process.env.SIRAGPT_TOOL_PREFETCH_TIMEOUT_MS = prev;
    }
  });

  test('fast tools are returned directly (no pending wrapper) under the default cap', async () => {
    const registry = [
      makeTool('web_search', async () => ({ ok: 1 })),
      makeTool('rag_retrieve', async () => ({ ok: 2 })),
    ];
    const map = await reactAgent.prefetchParallelDispatch(registry, [call('1', 'web_search'), call('2', 'rag_retrieve')], {}, new Set());
    assert.equal(map.get('1').__pending, undefined);
    assert.deepEqual(map.get('1').result, { ok: 1 });
    assert.deepEqual(map.get('2').result, { ok: 2 });
  });
});

describe('prefetch respects the duplicate-cache (no double-dispatch, no wasted budget)', () => {
  test('a signature cached in a prior step is NOT re-dispatched by the batch', async () => {
    let called = 0;
    const registry = [
      makeTool('web_search', async () => { called += 1; return { ok: true }; }),
      makeTool('rag_retrieve', async () => ({ ok: true })),
    ];
    const argsA = JSON.stringify({ q: 'x' });
    const calls = [
      { id: '1', function: { name: 'web_search', arguments: argsA } },
      { id: '2', function: { name: 'rag_retrieve', arguments: '{}' } },
    ];
    // Pre-seed the dup cache with web_search(x)'s signature (as a prior step would).
    const dupCache = new Map();
    dupCache.set(reactAgent.toolCallSignature('web_search', argsA), { step: 1, content: 'cached' });

    const map = await reactAgent.prefetchParallelDispatch(registry, calls, {}, new Set(), dupCache);
    assert.ok(!map.has('1'), 'cached signature is skipped by the prefetch');
    assert.equal(called, 0, 'the cached call is never dispatched for real');
  });

  test('two identical signatures in ONE batch dispatch only once', async () => {
    let called = 0;
    const registry = [
      makeTool('web_search', async () => { called += 1; return { ok: true }; }),
      makeTool('rag_retrieve', async () => ({ ok: true })),
    ];
    const argsA = JSON.stringify({ q: 'x' });
    const calls = [
      { id: '1', function: { name: 'web_search', arguments: argsA } },
      { id: '2', function: { name: 'web_search', arguments: argsA } },
      { id: '3', function: { name: 'rag_retrieve', arguments: '{}' } },
    ];
    const map = await reactAgent.prefetchParallelDispatch(registry, calls, {}, new Set(), new Map());
    assert.equal(called, 1, 'the repeated signature is dispatched exactly once within the batch');
    // Only the first occurrence + the distinct peer are prefetched; the repeat
    // (id 2) falls through to the main loop where the dup cache short-circuits it.
    assert.ok(map.has('1'), 'first occurrence prefetched');
    assert.ok(!map.has('2'), 'in-batch repeat NOT prefetched');
    assert.ok(map.has('3'), 'distinct peer prefetched');
  });
});

describe('duplicate-cached parallel call: no re-execution, warning surfaced', () => {
  test('step 2 repeats step 1 A(x): A runs exactly once, repeat carries duplicate_tool_call', async () => {
    let aCount = 0;
    const A = makeTool('web_search', async () => { aCount += 1; return { ok: true, tool: 'A' }; });
    const B = makeTool('rag_retrieve', async () => ({ ok: true, tool: 'B' }));
    const C = makeTool('scientific_search', async () => ({ ok: true, tool: 'C' }));

    // Scripted model: step 1 emits [A(x), B(y)] in one assistant turn; step 2
    // emits [A(x), C(z)]; then finalize.
    let i = 0;
    let callId = 0;
    const next = (toolCalls) => {
      const msgs = toolCalls.map((tc) => {
        callId += 1;
        return { id: `call_${callId}`, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } };
      });
      return { choices: [{ message: { role: 'assistant', content: 'thinking', tool_calls: msgs } }] };
    };
    const openai = {
      chat: { completions: { create: async (params) => {
        const forcedFinalize = params.tool_choice && typeof params.tool_choice === 'object'
          && params.tool_choice.function?.name === 'finalize';
        if (forcedFinalize) {
          callId += 1;
          return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: `call_${callId}`, type: 'function', function: { name: 'finalize', arguments: JSON.stringify({ answer: 'done' }) } }] } }] };
        }
        i += 1;
        if (i === 1) return next([{ name: 'web_search', args: { q: 'x' } }, { name: 'rag_retrieve', args: { q: 'y' } }]);
        if (i === 2) return next([{ name: 'web_search', args: { q: 'x' } }, { name: 'scientific_search', args: { q: 'z' } }]);
        callId += 1;
        return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: `call_${callId}`, type: 'function', function: { name: 'finalize', arguments: JSON.stringify({ answer: 'done' }) } }] } }] };
      } } },
    };

    const result = await reactAgent.run(openai, { query: 'test', tools: [A, B, C], model: 'gpt-4o', maxSteps: 6 });
    assert.equal(aCount, 1, 'A executed exactly once despite being called in two steps');
    // The repeat in step 2 must carry the duplicate warning.
    const allActions = result.steps.flatMap((s) => s.actions);
    const dupAction = allActions.find((a) => a.tool === 'web_search' && a.observation && a.observation.warning === 'duplicate_tool_call');
    assert.ok(dupAction, 'the repeated A(x) call surfaced a duplicate_tool_call warning');
  });
});
