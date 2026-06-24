'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { defaultLlmTurn, stripResidualFences, extractUsage } = require('../src/services/codex/llm-turn');

const ENV = { CEREBRAS_API_KEY: 'k', FREE_IA_MODEL_ID: 'test-model' };

/** Fake OpenAI-shaped client whose completion returns scripted message/usage. */
function fakeClient(message, usage) {
  return {
    chat: {
      completions: {
        create: async () => ({ id: 'gen_1', choices: [{ message }], usage }),
      },
    },
  };
}

const REGISTRY = [
  { name: 'run_command', description: 'run', parameters: { type: 'object', properties: { cmd: { type: 'array' } }, required: ['cmd'] } },
  { name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];

test('stripResidualFences removes leaked tool_call/json fences but keeps code fences', () => {
  const leak = 'Listo.\n```tool_call\n{"tool":"finalize","args":{"answer":"x"}}\n```';
  assert.equal(stripResidualFences(leak), 'Listo.');
  assert.equal(stripResidualFences('Solo texto'), 'Solo texto');
  // A legit code fence (not tool_call/json) is preserved for the narrative.
  const code = 'Corre:\n```bash\nls -la\n```';
  assert.equal(stripResidualFences(code), code);
});

test('defaultLlmTurn throws cleanly when no provider is configured', async () => {
  await assert.rejects(
    () => defaultLlmTurn({ messages: [{ role: 'user', content: 'hi' }], env: {} }),
    /no LLM provider configured/,
  );
});

test('defaultLlmTurn parses prompted tool calls into {id,name,args} and extracts usage', async () => {
  const content = 'Voy a leer el archivo.\n```tool_call\n{"tool":"read_file","args":{"path":"a.js"}}\n```';
  const client = fakeClient({ content }, { prompt_tokens: 11, completion_tokens: 5 });
  const turn = await defaultLlmTurn({ messages: [{ role: 'user', content: 'x' }], tools: REGISTRY, env: ENV, createClient: () => client });

  assert.equal(turn.text, 'Voy a leer el archivo.');
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.toolCalls[0].name, 'read_file');
  assert.deepEqual(turn.toolCalls[0].args, { path: 'a.js' });
  assert.ok(turn.toolCalls[0].id);
  assert.equal(turn.usage.tokensIn, 11);
  assert.equal(turn.usage.tokensOut, 5);
  assert.equal(turn.usage.provider, 'Cerebras');
});

test('defaultLlmTurn strips a leaked finalize block from the narrative (codex has no finalize tool)', async () => {
  const content = 'El proyecto quedó construido.\n```tool_call\n{"tool":"finalize","args":{"answer":"hecho"}}\n```';
  const client = fakeClient({ content }, {});
  const turn = await defaultLlmTurn({ messages: [{ role: 'user', content: 'x' }], tools: REGISTRY, env: ENV, createClient: () => client });
  // finalize is not in the registry → no tool call, and the fence must NOT leak.
  assert.deepEqual(turn.toolCalls, []);
  assert.equal(turn.text, 'El proyecto quedó construido.');
  assert.ok(!turn.text.includes('tool_call'));
});

test('defaultLlmTurn with no tools never parses tool calls (plan-mode safety)', async () => {
  // Even if the model emits a tool_call block, with tools:[] it must be inert text.
  const content = 'texto\n```tool_call\n{"tool":"write_file","args":{}}\n```';
  const client = fakeClient({ content }, {});
  const turn = await defaultLlmTurn({ messages: [{ role: 'user', content: 'x' }], tools: [], env: ENV, createClient: () => client });
  assert.deepEqual(turn.toolCalls, []);
  assert.equal(turn.text, content); // untouched — no prompted parsing path
});

test('defaultLlmTurn surfaces native reasoning when present', async () => {
  const client = fakeClient({ content: 'ok', reasoning: 'pensando en el plan' }, {});
  const turn = await defaultLlmTurn({ messages: [{ role: 'user', content: 'x' }], tools: REGISTRY, env: ENV, createClient: () => client });
  assert.ok(turn.reasoning);
  assert.equal(turn.reasoning.text, 'pensando en el plan');
});

test('extractUsage tolerates missing usage and alt token field names', () => {
  assert.deepEqual(extractUsage({}, 'm').tokensIn, 0);
  const u = extractUsage({ usage: { input_tokens: 3, output_tokens: 9 }, id: 'g' }, 'm');
  assert.equal(u.tokensIn, 3);
  assert.equal(u.tokensOut, 9);
  assert.equal(u.generationId, 'g');
});
