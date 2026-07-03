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

test('defaultLlmTurn: tier eco genuino va a Cerebras DIRECTO (no al ladder que cobra Claude)', async () => {
  // Prod repro: ANTHROPIC_API_KEY seteada, pero tier eco NO es elegible para
  // Anthropic (CODEX_ANTHROPIC_TIERS default standard,power). Sin createClient
  // inyectado, el turno DEBE usar el cliente Cerebras real por defecto — nunca
  // el ladder llm-provider (que prioriza Anthropic → cobraría Claude).
  const env = {
    ANTHROPIC_API_KEY: 'sk-should-not-be-used',
    CEREBRAS_API_KEY: 'csk-eco',
    FREE_IA_MODEL_ID: 'gpt-oss-120b',
    NODE_ENV: 'test',
  };
  const cerebras = require('../src/services/ai/cerebras-client');
  const llmProvider = require('../src/services/codex/llm-provider');

  // Fail the ladder loudly so a regression (eco → ladder) is unmistakable.
  const origChatComplete = llmProvider.chatComplete;
  const origCreate = cerebras.createCerebrasClient;
  let ladderCalled = false;
  let cerebrasModelUsed = null;
  llmProvider.chatComplete = async () => { ladderCalled = true; throw new Error('LADDER MUST NOT BE CALLED FOR ECO'); };
  cerebras.createCerebrasClient = ({ env: e } = {}) => ({
    chat: {
      completions: {
        create: async (req) => {
          cerebrasModelUsed = req.model;
          return { id: 'gen_eco', choices: [{ message: { content: 'desde cerebras eco' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } };
        },
      },
    },
  });
  try {
    const turn = await defaultLlmTurn({
      messages: [{ role: 'user', content: 'construye algo' }],
      tools: [],
      env,
      tier: 'eco',
    });
    assert.equal(ladderCalled, false, 'eco NO debe tocar el ladder');
    assert.equal(turn.text, 'desde cerebras eco');
    assert.equal(turn.usage.provider, 'Cerebras');
    assert.equal(turn.usage.model, 'gpt-oss-120b', 'usa el modelo de getCerebrasConfig (FREE_IA_MODEL_ID), no llama');
    assert.equal(cerebrasModelUsed, 'gpt-oss-120b');
  } finally {
    llmProvider.chatComplete = origChatComplete;
    cerebras.createCerebrasClient = origCreate;
  }
});

test('defaultLlmTurn: tier de pago cuyo anthropicTurn falla SÍ usa el ladder (failover legítimo)', async () => {
  // Con tier power, engine es 'anthropic'; si anthropicTurn revienta y NO hay
  // createClient inyectado, la degradación correcta es el ladder llm-provider
  // (failover a openrouter/cerebras) — NO Cerebras directo.
  const env = { ANTHROPIC_API_KEY: 'sk-test', CEREBRAS_API_KEY: 'csk', NODE_ENV: 'test' };
  const llmProvider = require('../src/services/codex/llm-provider');
  const origChatComplete = llmProvider.chatComplete;
  let ladderCalled = false;
  llmProvider.chatComplete = async () => {
    ladderCalled = true;
    return { content: 'desde ladder', reasoning: '', usage: { provider: 'OpenRouter', model: 'x', tokensIn: 1, tokensOut: 1 } };
  };
  try {
    const turn = await defaultLlmTurn({
      messages: [{ role: 'user', content: 'hola' }],
      tools: [],
      env,
      tier: 'power',
      // anthropicTurn real correrá con esta key falsa y lanzará (SDK no mockeado);
      // forzamos el fallo con un createAnthropicClient que revienta.
      createAnthropicClient: () => ({ messages: { create: async () => { throw new Error('boom anthropic'); } } }),
    });
    assert.equal(ladderCalled, true, 'la degradación de un tier de pago DEBE usar el ladder');
    assert.equal(turn.text, 'desde ladder');
    assert.equal(turn.usage.provider, 'OpenRouter');
  } finally {
    llmProvider.chatComplete = origChatComplete;
  }
});

test('extractUsage prefers a canonical 0 over the alternate field (no falsy-0)', () => {
  // prompt_tokens=0 (e.g. cached) must win over input_tokens; the old `||`
  // skipped the 0 and reported the alternate field.
  const u = extractUsage({ usage: { prompt_tokens: 0, input_tokens: 50, completion_tokens: 0, output_tokens: 99 } }, 'm');
  assert.equal(u.tokensIn, 0);
  assert.equal(u.tokensOut, 0);
});
