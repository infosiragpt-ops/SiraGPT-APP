'use strict';

/**
 * End-to-end test of the react-agent loop in PROMPTED tool-call mode: a fake
 * OpenAI client that (a) asserts the request payload is provider-safe (no
 * `tools`/`tool_choice` params, no role:'tool' messages, no assistant
 * tool_calls field), and (b) answers with fenced ```tool_call JSON blocks the
 * way a model without native function calling would.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const reactAgent = require('../src/services/react-agent');

function assistantText(content) {
  return { choices: [{ message: { role: 'assistant', content } }] };
}

function makePromptedFakeOpenAI(scripted, capturedRequests) {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async (params) => {
          capturedRequests.push(params);
          return scripted[Math.min(i++, scripted.length - 1)];
        },
      },
    },
  };
}

const ECHO_TOOL = {
  name: 'web_search',
  description: 'Search the web.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
  execute: async (args) => ({ results: [`hit for ${args.query}`] }),
};

test('prompted mode runs a full search → finalize loop without native tool params', async () => {
  const requests = [];
  const openai = makePromptedFakeOpenAI([
    assistantText('Busco datos primero.\n```tool_call\n{"tool": "web_search", "args": {"query": "harness 2026"}}\n```'),
    assistantText('Ya tengo evidencia.\n```tool_call\n{"tool": "finalize", "args": {"answer": "**Respuesta final** con fuentes."}}\n```'),
  ], requests);

  const result = await reactAgent.run(openai, {
    query: 'investiga harness de agentes',
    tools: [ECHO_TOOL],
    model: 'mistral-large-2',
    maxSteps: 4,
    toolCallMode: 'prompted',
  });

  assert.equal(result.stoppedReason, 'finalized');
  assert.equal(result.finalAnswer, '**Respuesta final** con fuentes.');
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].actions[0].tool, 'web_search');
  assert.deepEqual(result.steps[0].actions[0].observation, { results: ['hit for harness 2026'] });

  assert.ok(requests.length >= 2);
  for (const req of requests) {
    // Provider-safe payload: prompted mode must never send native tool params.
    assert.equal('tools' in req, false, 'tools param must not be sent in prompted mode');
    assert.equal('tool_choice' in req, false, 'tool_choice param must not be sent in prompted mode');
    for (const m of req.messages) {
      assert.notEqual(m.role, 'tool', 'role:"tool" must not be sent in prompted mode');
      assert.equal('tool_calls' in m, false, 'assistant tool_calls field must not be sent in prompted mode');
    }
  }
  // The system prompt carries the tool protocol + registry.
  assert.match(requests[0].messages[0].content, /TOOL-CALL PROTOCOL/);
  assert.match(requests[0].messages[0].content, /- web_search:/);
  assert.match(requests[0].messages[0].content, /- finalize:/);
  // The second request must include the first observation as a labelled
  // user message (the provider-safe replacement for role:'tool').
  const obsMsg = requests[1].messages.find((m) => m.role === 'user' && /\[TOOL_RESULT web_search\]/.test(m.content));
  assert.ok(obsMsg, 'observation must round-trip as a [TOOL_RESULT] user message');
  assert.match(obsMsg.content, /hit for harness 2026/);
});

test('prompted mode emulates forced finalize on the last step via instruction', async () => {
  const requests = [];
  // The model keeps searching; on the LAST step the loop must force finalize
  // via an appended instruction (not tool_choice), and the model complies.
  const openai = {
    chat: {
      completions: {
        create: async (params) => {
          requests.push(params);
          const lastMsg = params.messages[params.messages.length - 1];
          if (typeof lastMsg.content === 'string' && /MUST now respond/.test(lastMsg.content)) {
            return assistantText('```tool_call\n{"tool": "finalize", "args": {"answer": "Cierro con lo encontrado."}}\n```');
          }
          return assistantText('Sigo buscando.\n```tool_call\n{"tool": "web_search", "args": {"query": "más datos"}}\n```');
        },
      },
    },
  };

  const result = await reactAgent.run(openai, {
    query: 'pregunta',
    tools: [ECHO_TOOL],
    model: 'claude-3-opus',
    maxSteps: 2,
    toolCallMode: 'prompted',
  });

  assert.equal(result.stoppedReason, 'finalized');
  assert.equal(result.finalAnswer, 'Cierro con lo encontrado.');
  const lastReq = requests[requests.length - 1];
  const forced = lastReq.messages[lastReq.messages.length - 1];
  assert.match(forced.content, /"finalize"/);
});

test('prompted mode treats plain text with no parseable call as a direct answer', async () => {
  const requests = [];
  const openai = makePromptedFakeOpenAI([
    assistantText('La capital de Francia es París.'),
  ], requests);
  const result = await reactAgent.run(openai, {
    query: '¿capital de Francia?',
    tools: [ECHO_TOOL],
    model: 'mistral-small',
    maxSteps: 3,
    toolCallMode: 'prompted',
  });
  assert.equal(result.stoppedReason, 'plain_text_finalize');
  assert.equal(result.finalAnswer, 'La capital de Francia es París.');
});

test('prompted mode unwraps a structured final-answer envelope returned as plain text', async () => {
  const requests = [];
  const openai = makePromptedFakeOpenAI([
    assistantText(JSON.stringify({ answer: '# Informe listo\n\nDocumento validado.', confidence: 'high' })),
  ], requests);
  const result = await reactAgent.run(openai, {
    query: 'crea un informe',
    tools: [ECHO_TOOL],
    model: 'gpt-oss-120b',
    maxSteps: 3,
    toolCallMode: 'prompted',
  });
  assert.equal(result.stoppedReason, 'plain_text_finalize');
  assert.equal(result.finalAnswer, '# Informe listo\n\nDocumento validado.');
});

test('prompted mode ignores hallucinated tool names and lets the loop continue', async () => {
  const requests = [];
  const openai = makePromptedFakeOpenAI([
    // Names a tool that is not registered → parsed as plain text (no call),
    // which terminates as a direct answer rather than crashing the loop.
    assistantText('Uso otra cosa. {"tool": "made_up_tool", "args": {}}'),
  ], requests);
  const result = await reactAgent.run(openai, {
    query: 'q',
    tools: [ECHO_TOOL],
    model: 'mistral-small',
    maxSteps: 2,
    toolCallMode: 'prompted',
  });
  assert.equal(result.stoppedReason, 'plain_text_finalize');
});

test('native mode is unchanged: tools + tool_choice still sent', async () => {
  const requests = [];
  const openai = {
    chat: {
      completions: {
        create: async (params) => {
          requests.push(params);
          return {
            choices: [{
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'finalize', arguments: JSON.stringify({ answer: 'ok' }) } }],
              },
            }],
          };
        },
      },
    },
  };
  const result = await reactAgent.run(openai, {
    query: 'q',
    tools: [ECHO_TOOL],
    model: 'gpt-4o-mini',
    maxSteps: 2,
  });
  assert.equal(result.finalAnswer, 'ok');
  assert.ok(Array.isArray(requests[0].tools) && requests[0].tools.length >= 2);
  assert.ok(requests[0].tool_choice);
});
