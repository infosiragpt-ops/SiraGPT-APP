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
