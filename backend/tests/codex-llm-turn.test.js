'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { defaultLlmTurn, stripResidualFences, extractUsage, detectTruncatedToolCall } = require('../src/services/codex/llm-turn');

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

test('detectTruncatedToolCall flags an unclosed tool_call fence and strips the residual markup', () => {
  const cut = 'Escribo el componente.\n```tool_call\n{"tool":"write_file","args":{"path":"src/App.tsx","content":"export default function App() { return <div>hola';
  const r = detectTruncatedToolCall(cut);
  assert.equal(r.truncated, true);
  assert.equal(r.cleaned, 'Escribo el componente.');
  assert.ok(!r.cleaned.includes('tool_call'));
});

test('detectTruncatedToolCall does NOT flag a complete tool_call fence', () => {
  const complete = 'Leo el archivo.\n```tool_call\n{"tool":"read_file","args":{"path":"a.js"}}\n```';
  const r = detectTruncatedToolCall(complete);
  assert.equal(r.truncated, false);
});

test('detectTruncatedToolCall ignores plain prose and code fences', () => {
  assert.equal(detectTruncatedToolCall('solo texto sin fences').truncated, false);
  // A bash code fence is not a tool_call opener.
  assert.equal(detectTruncatedToolCall('Corre:\n```bash\nls -la\n```').truncated, false);
  // An unclosed bash fence is also not a tool_call → not our concern.
  assert.equal(detectTruncatedToolCall('Corre:\n```bash\nls -la').truncated, false);
});

test('defaultLlmTurn surfaces truncated=true when a large write overran (unclosed fence, zero calls)', async () => {
  const cut = 'Escribo el archivo.\n```tool_call\n{"tool":"write_file","args":{"path":"src/App.tsx","content":"muy largo y cortado a la mitad';
  const client = fakeClient({ content: cut }, {});
  const turn = await defaultLlmTurn({ messages: [{ role: 'user', content: 'x' }], tools: REGISTRY, env: ENV, createClient: () => client });
  assert.deepEqual(turn.toolCalls, []);
  assert.equal(turn.truncated, true);
  assert.ok(!turn.text.includes('tool_call')); // no raw protocol leaks into the narrative
  assert.equal(turn.text, 'Escribo el archivo.');
});

test('defaultLlmTurn does NOT mark truncated when a complete call was parsed', async () => {
  const content = 'Leo.\n```tool_call\n{"tool":"read_file","args":{"path":"a.js"}}\n```';
  const client = fakeClient({ content }, {});
  const turn = await defaultLlmTurn({ messages: [{ role: 'user', content: 'x' }], tools: REGISTRY, env: ENV, createClient: () => client });
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.truncated, false);
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

test('extractUsage prefers a canonical 0 over the alternate field (no falsy-0)', () => {
  // prompt_tokens=0 (e.g. cached) must win over input_tokens; the old `||`
  // skipped the 0 and reported the alternate field.
  const u = extractUsage({ usage: { prompt_tokens: 0, input_tokens: 50, completion_tokens: 0, output_tokens: 99 } }, 'm');
  assert.equal(u.tokensIn, 0);
  assert.equal(u.tokensOut, 0);
});
