/**
 * react-agent — graceful degradation when a tool keeps failing.
 *
 * Regression test for the "single chat thread" bug: a tool that fails 5 times
 * in a row used to hard-abort the whole task with
 *   "No se pudo completar la tarea: la herramienta X falló 5 veces consecutivas."
 * Now the tool is declared unavailable, the model is told to answer without it,
 * the finalize guard waives it, and the user still gets a real answer.
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const reactAgent = require('../src/services/react-agent');

/**
 * Build a fake OpenAI client whose `chat.completions.create` returns a
 * scripted sequence of assistant messages. Each script entry is either:
 *   { tool: 'name', args: {...} }  → one tool call
 *   { finalize: 'answer text' }    → a finalize tool call
 * When the forced tool_choice is `finalize` (last step), we always emit a
 * finalize regardless of the script so the loop can terminate.
 */
function makeScriptedOpenAI(script) {
  let i = 0;
  let callId = 0;
  return {
    _calls: [],
    chat: {
      completions: {
        create: async (params) => {
          const forcedFinalize =
            params.tool_choice
            && typeof params.tool_choice === 'object'
            && params.tool_choice.function?.name === 'finalize';
          const entry = forcedFinalize
            ? { finalize: 'Forced final answer.' }
            : (script[i] || { finalize: 'Default final answer.' });
          i += 1;
          callId += 1;
          const toolCall = entry.finalize != null
            ? {
                id: `call_${callId}`,
                type: 'function',
                function: { name: 'finalize', arguments: JSON.stringify({ answer: entry.finalize }) },
              }
            : {
                id: `call_${callId}`,
                type: 'function',
                function: { name: entry.tool, arguments: JSON.stringify(entry.args || {}) },
              };
          return {
            choices: [{ message: { role: 'assistant', content: entry.thought || 'thinking', tool_calls: [toolCall] } }],
          };
        },
      },
    },
  };
}

const alwaysFailingTool = {
  name: 'docintel_retrieve',
  description: 'Always throws to simulate a broken document-intelligence tool.',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  execute: async () => { throw new Error('simulated docintel failure'); },
};

test('react-agent: a tool that fails 5x is declared unavailable, not a hard dead-end', async () => {
  // Model insists on the failing tool 6 times, then would finalize.
  const script = Array.from({ length: 6 }, () => ({ tool: 'docintel_retrieve', args: { query: 'x' } }));
  script.push({ finalize: 'Here is my best answer without the broken tool.' });
  const openai = makeScriptedOpenAI(script);

  const result = await reactAgent.run(openai, {
    query: 'resolver',
    tools: [alwaysFailingTool],
    maxSteps: 12,
    model: 'test-model',
  });

  // No legacy dead-end message.
  assert.doesNotMatch(String(result.finalAnswer || ''), /veces consecutivas/i);
  // The tool was declared unavailable.
  assert.ok(Array.isArray(result.exhaustedTools));
  assert.ok(result.exhaustedTools.includes('docintel_retrieve'));
  // The user gets a real, non-empty answer.
  assert.ok(String(result.finalAnswer || '').trim().length > 0);
});

test('react-agent: finalize guard receives unavailableTools and can waive the broken tool', async () => {
  // The model keeps calling the failing tool; a guard requires that tool.
  // Once the tool is exhausted, the guard is handed unavailableTools and can
  // approve finalize instead of blocking forever.
  const script = Array.from({ length: 6 }, () => ({ tool: 'docintel_retrieve', args: { query: 'x' } }));
  script.push({ finalize: 'Degraded answer.' });
  const openai = makeScriptedOpenAI(script);

  let guardSawUnavailable = null;
  const result = await reactAgent.run(openai, {
    query: 'resume este documento',
    tools: [alwaysFailingTool],
    maxSteps: 12,
    model: 'test-model',
    finalizeGuard: ({ unavailableTools }) => {
      guardSawUnavailable = unavailableTools;
      // Require docintel_retrieve, but waive it when it's unavailable.
      const stillMissing = ['docintel_retrieve'].filter(
        (t) => !(Array.isArray(unavailableTools) && unavailableTools.includes(t))
      );
      return stillMissing.length === 0
        ? { ok: true }
        : { ok: false, missingTools: stillMissing, message: 'blocked' };
    },
  });

  assert.ok(Array.isArray(guardSawUnavailable));
  assert.ok(guardSawUnavailable.includes('docintel_retrieve'));
  assert.equal(result.stoppedReason, 'finalized');
  assert.doesNotMatch(String(result.finalAnswer || ''), /veces consecutivas/i);
});

test('react-agent: a healthy tool still works and finalizes normally', async () => {
  const okTool = {
    name: 'web_search',
    description: 'Returns a canned result.',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
    execute: async () => ({ ok: true, results: ['fact'] }),
  };
  const openai = makeScriptedOpenAI([
    { tool: 'web_search', args: { q: 'hello' } },
    { finalize: 'All good.' },
  ]);

  const result = await reactAgent.run(openai, {
    query: 'busca algo',
    tools: [okTool],
    maxSteps: 8,
    model: 'test-model',
  });

  assert.equal(result.stoppedReason, 'finalized');
  assert.equal(result.finalAnswer, 'All good.');
  assert.deepEqual(result.exhaustedTools, []);
});

test('react-agent: strips internal docintel authorization diagnostics from final answers', async () => {
  const answer = [
    'El título de esta investigación es:',
    '',
    '"Una mirada a los nuevos enfoques de la gestión pública"',
    '',
    '**Nota sobre verificación:** Las herramientas de análisis documental profundo (`docintel_analyze`, `docintel_retrieve`) no están disponibles en este momento por un error de autorización del servidor (`missing_scopes`). La respuesta se basa en RAG.',
  ].join('\n');
  const openai = makeScriptedOpenAI([{ finalize: answer }]);

  const result = await reactAgent.run(openai, {
    query: 'cual es el titulo',
    tools: [],
    maxSteps: 2,
    model: 'test-model',
  });

  assert.equal(result.stoppedReason, 'finalized');
  assert.match(result.finalAnswer, /Una mirada a los nuevos enfoques/);
  assert.doesNotMatch(result.finalAnswer, /docintel_|missing_scopes|error de autorizaci[oó]n|Nota sobre verificaci[oó]n/i);
});

test('react-agent: exhausted-tool safety net does not expose internal tool names', async () => {
  const script = Array.from({ length: 5 }, () => ({ tool: 'docintel_retrieve', args: { query: 'x' } }));
  const openai = makeScriptedOpenAI(script);

  const result = await reactAgent.run(openai, {
    query: 'resume el documento',
    tools: [alwaysFailingTool],
    maxSteps: 7,
    model: 'test-model',
    finalizeGuard: () => ({ ok: false, message: 'blocked for safety-net test', missingTools: ['docintel_retrieve'] }),
  });

  assert.ok(String(result.finalAnswer || '').trim().length > 0);
  assert.doesNotMatch(result.finalAnswer, /docintel_|missing_scopes/i);
  assert.ok(result.exhaustedTools.includes('docintel_retrieve'));
});

const okTool = {
  name: 'web_search',
  description: 'Returns a canned result.',
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
  execute: async () => ({ ok: true, results: ['fact'] }),
};

test('react-agent: a model error yields a non-empty, honest degraded answer (never silent-empty)', async () => {
  // The provider throws on every call (e.g. a 5xx that outlived SDK retries).
  // The old behavior returned finalAnswer=null → silent empty "completed"
  // message on the task path. Now the run hands back a real, honest message.
  const throwingOpenAI = {
    chat: { completions: { create: async () => { throw new Error('upstream 503'); } } },
  };

  const result = await reactAgent.run(throwingOpenAI, {
    query: 'haz algo',
    tools: [okTool],
    maxSteps: 4,
    model: 'test-model',
  });

  assert.match(String(result.stoppedReason), /model_error/);
  assert.ok(String(result.finalAnswer || '').trim().length > 0, 'must not be empty');
  assert.match(result.finalAnswer, /modelo/i);
  assert.deepEqual(result.exhaustedTools, []);
});

test('react-agent: max_steps without finalize still returns a non-empty answer', async () => {
  // The model keeps calling a healthy tool and a guard blocks every finalize
  // (including the forced last-step one), so the run exhausts its step budget
  // with no answer of its own. The safety net must still produce real text.
  const script = Array.from({ length: 10 }, () => ({ tool: 'web_search', args: { q: 'x' } }));
  const openai = makeScriptedOpenAI(script);

  const result = await reactAgent.run(openai, {
    query: 'investiga a fondo',
    tools: [okTool],
    maxSteps: 4,
    model: 'test-model',
    finalizeGuard: () => ({ ok: false, message: 'blocked', missingTools: ['nope'] }),
  });

  assert.notEqual(result.stoppedReason, 'finalized');
  assert.ok(String(result.finalAnswer || '').trim().length > 0, 'must not be empty');
  assert.equal(result.exhaustedTools.length, 0);
});

test('react-agent: repeated re-polling of an exhausted tool trips the escape and forces finalize', async () => {
  // 5 failures exhaust the tool; the model then stubbornly re-calls it. After
  // EXHAUSTED_REPOLL_LIMIT consecutive re-polls the loop must narrow the tool
  // choice to finalize instead of looping to the step budget.
  const script = Array.from({ length: 20 }, () => ({ tool: 'docintel_retrieve', args: { query: 'x' } }));
  const openai = makeScriptedOpenAI(script);

  const result = await reactAgent.run(openai, {
    query: 'resolver',
    tools: [alwaysFailingTool],
    maxSteps: 20,
    model: 'test-model',
  });

  assert.equal(result.stoppedReason, 'finalized');
  assert.equal(result.finalAnswer, 'Forced final answer.');
  // 5 failing steps + EXHAUSTED_REPOLL_LIMIT re-polls + 1 forced finalize.
  const expectedMax = 5 + reactAgent.EXHAUSTED_REPOLL_LIMIT + 1;
  assert.ok(
    result.steps.length <= expectedMax,
    `escape must fire well before the step budget (${result.steps.length} > ${expectedMax})`
  );
});

test('react-agent: invalid tool args do NOT consume the per-tool call budget', async () => {
  // First call: missing required `query` → rejected by schema validation
  // BEFORE the budget is touched. Second call: valid args → budget consumed.
  const script = [
    { tool: 'docintel_retrieve', args: {} },
    { tool: 'docintel_retrieve', args: { query: 'x' } },
    { finalize: 'done' },
  ];
  const openai = makeScriptedOpenAI(script);
  const budgetChecks = [];
  const ctx = {
    toolUsageMap: {},
    checkToolBudget: (name, usage) => { budgetChecks.push({ name, count: usage[name] || 0 }); return { ok: true }; },
  };

  const result = await reactAgent.run(openai, {
    query: 'resolver',
    tools: [alwaysFailingTool],
    maxSteps: 6,
    model: 'test-model',
    ctx,
  });

  assert.equal(result.stoppedReason, 'finalized');
  const invalidAction = result.steps.flatMap((s) => s.actions).find((a) => String(a.observation?.error || '').includes('invalid_tool_args'));
  assert.ok(invalidAction, 'schema rejection surfaced to the model');
  // Budget consulted exactly once (the valid call), and usage counted once.
  assert.equal(budgetChecks.length, 1);
  assert.equal(ctx.toolUsageMap.docintel_retrieve, 1);
});

// A fake client that ALWAYS calls finalize with the same real answer, even
// when tool_choice is narrowed to finalize. Used to probe the finalize-guard
// interaction on the last step / under the breaker.
function makeAlwaysFinalizeOpenAI(answer) {
  let callId = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          callId += 1;
          return {
            choices: [{
              message: {
                role: 'assistant',
                content: 'thinking',
                tool_calls: [{
                  id: `call_${callId}`,
                  type: 'function',
                  function: { name: 'finalize', arguments: JSON.stringify({ answer }) },
                }],
              },
            }],
          };
        },
      },
    },
  };
}

// A fake client that ALWAYS answers in prose (no tool_calls) — the weak
// prompted-model failure that keeps ignoring the finalize protocol.
function makePlainTextOpenAI(prose) {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { role: 'assistant', content: prose, tool_calls: [] } }],
        }),
      },
    },
  };
}

test('react-agent: last-step finalize-guard rejection keeps the model answer instead of generic degraded text', async () => {
  // The model produces a real answer on every finalize; the guard always
  // rejects it. With maxSteps=2 (below MAX_CONSEC_FINALIZE_REJECTIONS=3) the
  // breaker never trips, so the run ends on the forced last-step finalize with
  // no terminator firing. The rescue must ship the model's real answer.
  const REAL = 'La respuesta real que el modelo produjo.';
  const openai = makeAlwaysFinalizeOpenAI(REAL);

  const result = await reactAgent.run(openai, {
    query: 'contesta',
    tools: [],
    maxSteps: 2,
    model: 'test-model',
    finalizeGuard: () => ({ ok: false, message: 'blocked by policy' }),
  });

  assert.match(String(result.finalAnswer || ''), /La respuesta real que el modelo produjo/);
  assert.doesNotMatch(String(result.finalAnswer || ''), /No logr[eé] cerrar/i);
  assert.equal(result.stoppedReason, 'finalized_last_step_guard_override');
});

test('react-agent: plain-text finalize-guard rejections trip the breaker and accept the prose answer', async () => {
  // A weak model keeps answering in prose; the guard always rejects. Without
  // the breaker this spins to the full step budget. It must stop after
  // MAX_CONSEC_FINALIZE_REJECTIONS (3) with the model's prose as the answer.
  const PROSE = 'Aquí está mi respuesta en prosa.';
  const openai = makePlainTextOpenAI(PROSE);

  const result = await reactAgent.run(openai, {
    query: 'contesta',
    tools: [],
    maxSteps: 8,
    model: 'test-model',
    finalizeGuard: () => ({ ok: false, message: 'blocked by policy' }),
  });

  assert.equal(result.steps.length, 3, 'breaker stops the run after 3 plain-text rejections');
  assert.match(String(result.stoppedReason), /finalized_guard_breaker/);
  assert.equal(result.finalAnswer, PROSE);
});

test('react-agent: finalize breaker preserves the finalized_guard_breaker stoppedReason (not clobbered to finalized)', async () => {
  // The model calls finalize with a real answer every step; the guard rejects
  // 3 consecutive finalizes → the breaker trips, leaves the observation
  // error-free so the terminator fires, and the reason must survive as
  // finalized_guard_breaker (not overwritten to a clean 'finalized').
  const REAL = 'Respuesta aceptada por el breaker.';
  const openai = makeAlwaysFinalizeOpenAI(REAL);

  const result = await reactAgent.run(openai, {
    query: 'contesta',
    tools: [],
    maxSteps: 8,
    model: 'test-model',
    finalizeGuard: () => ({ ok: false, message: 'blocked by policy' }),
  });

  assert.match(String(result.stoppedReason), /^finalized_guard_breaker:/);
  assert.equal(result.finalAnswer, REAL);
});

test('react-agent: slow provider trend forces finalize before the runtime budget blows mid-step', async () => {
  // Each completion takes ~30ms against a 1.5s budget with a 2s headroom
  // buffer — after the first measured step the loop must conclude there is no
  // room for another exploration step and force finalize.
  const script = Array.from({ length: 10 }, () => ({ tool: 'docintel_retrieve', args: { query: 'x' } }));
  const scripted = makeScriptedOpenAI(script);
  const openai = {
    chat: {
      completions: {
        create: async (...args) => {
          await new Promise((r) => setTimeout(r, 30));
          return scripted.chat.completions.create(...args);
        },
      },
    },
  };

  const result = await reactAgent.run(openai, {
    query: 'investiga',
    tools: [alwaysFailingTool],
    maxSteps: 10,
    maxRuntimeMs: 1500,
    model: 'test-model',
  });

  assert.equal(result.stoppedReason, 'finalized');
  assert.equal(result.finalAnswer, 'Forced final answer.');
  assert.equal(result.steps.length, 2, 'one measured step, then a forced finalize');
});
