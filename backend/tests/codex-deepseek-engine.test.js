'use strict';

/**
 * Motor DeepSeek V4 nativo para el loop de codex (deepseek-turn) + despacho
 * en llm-turn + peldaño en el ladder de llm-provider. Todo offline: clientes
 * inyectados, cero red.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  deepseekTurn,
  getDeepSeekTurnConfig,
  normalizeDeepSeekModel,
  resolveThinking,
  toOpenAITools,
  toDeepSeekMessages,
  normalizeToolCalls,
  DEFAULT_MODEL_FLASH,
  DEFAULT_MODEL_PRO,
} = require('../src/services/codex/deepseek-turn');
const { defaultLlmTurn, resolveTurnEngine } = require('../src/services/codex/llm-turn');
const provider = require('../src/services/codex/llm-provider');

const ENV = { DEEPSEEK_API_KEY: 'sk-ds-test', NODE_ENV: 'test' };

const REGISTRY = [
  { name: 'write_file', description: 'escribe', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'read_file', description: 'lee', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];

/** Cliente OpenAI-shaped que devuelve un mensaje/usage guionizado y captura la request. */
function fakeClient(message, { usage = { prompt_tokens: 10, completion_tokens: 4 }, finishReason = 'stop' } = {}) {
  const captured = [];
  return {
    captured,
    chat: {
      completions: {
        create: async (req) => {
          captured.push(req);
          return { id: 'gen_ds_1', choices: [{ message, finish_reason: finishReason }], usage };
        },
      },
    },
  };
}

/** Cliente que streamea chunks OpenAI-shaped (async iterable) cuando stream:true. */
function fakeStreamClient(chunks) {
  const captured = [];
  return {
    captured,
    chat: {
      completions: {
        create: async (req) => {
          captured.push(req);
          return {
            async* [Symbol.asyncIterator]() {
              for (const c of chunks) yield c;
            },
          };
        },
      },
    },
  };
}

test.beforeEach(() => provider.resetQuarantine());

// ---------------------------------------------------------------------------
// Configuración + normalización de modelo

test('getDeepSeekTurnConfig: sin key → disabled; tier decide el modelo; todos los tiers elegibles por defecto', () => {
  assert.equal(getDeepSeekTurnConfig({ env: {}, tier: 'power' }).enabled, false);

  const power = getDeepSeekTurnConfig({ env: ENV, tier: 'power' });
  assert.equal(power.enabled, true);
  assert.equal(power.tierEligible, true);
  assert.equal(power.model, DEFAULT_MODEL_PRO);

  const eco = getDeepSeekTurnConfig({ env: ENV, tier: 'eco' });
  assert.equal(eco.tierEligible, true, 'eco también va a DeepSeek (política: solo DeepSeek)');
  assert.equal(eco.model, DEFAULT_MODEL_FLASH);

  const none = getDeepSeekTurnConfig({ env: ENV, tier: null });
  assert.equal(none.tierEligible, true, 'sin tier = eco');

  const off = getDeepSeekTurnConfig({ env: { ...ENV, CODEX_DEEPSEEK_DISABLED: '1' }, tier: 'power' });
  assert.equal(off.enabled, false);

  const carved = getDeepSeekTurnConfig({ env: { ...ENV, CODEX_DEEPSEEK_TIERS: 'power' }, tier: 'standard' });
  assert.equal(carved.tierEligible, false, 'CODEX_DEEPSEEK_TIERS recorta tiers');
});

test('getDeepSeekTurnConfig: overrides por env y por modelo pedido (alias Sira Pro / Sira Rápido)', () => {
  const env = { ...ENV, CODEX_DEEPSEEK_MODEL_POWER: 'deepseek-v4-pro', CODEX_DEEPSEEK_MODEL_STANDARD: 'deepseek-v4-flash', CODEX_DEEPSEEK_MAX_TOKENS: '4096', CODEX_DEEPSEEK_TEMPERATURE: '0' };
  const cfg = getDeepSeekTurnConfig({ env, tier: 'standard' });
  assert.equal(cfg.maxTokens, 4096);
  assert.equal(cfg.temperature, 0);
  assert.equal(getDeepSeekTurnConfig({ env: ENV, tier: 'eco', modelOverride: 'Sira Pro' }).model, DEFAULT_MODEL_PRO);
  assert.equal(getDeepSeekTurnConfig({ env: ENV, tier: 'power', modelOverride: 'sira-rapido' }).model, DEFAULT_MODEL_FLASH);
  // Un modelo que no es DeepSeek no se envía a DeepSeek: cae al default del tier.
  assert.equal(getDeepSeekTurnConfig({ env: ENV, tier: 'power', modelOverride: 'claude-sonnet-4-6' }).model, DEFAULT_MODEL_PRO);
  assert.equal(getDeepSeekTurnConfig({ env: ENV, tier: 'eco', modelOverride: 'deepseek/deepseek-v4-pro' }).model, DEFAULT_MODEL_PRO);
});

test('normalizeDeepSeekModel: ids, alias y slugs', () => {
  assert.equal(normalizeDeepSeekModel('deepseek-v4-flash'), DEFAULT_MODEL_FLASH);
  assert.equal(normalizeDeepSeekModel('DeepSeek-V4-Pro'), DEFAULT_MODEL_PRO);
  assert.equal(normalizeDeepSeekModel('Sira Rápido'), DEFAULT_MODEL_FLASH);
  assert.equal(normalizeDeepSeekModel('deepseek-chat'), 'deepseek-chat');
  assert.equal(normalizeDeepSeekModel('gpt-4o'), null);
  assert.equal(normalizeDeepSeekModel(''), null);
  assert.equal(normalizeDeepSeekModel(null), null);
});

test('resolveThinking: solo modelos V4; Pro piensa por defecto, Flash solo con effort high; env fuerza', () => {
  assert.equal(resolveThinking({ model: 'deepseek-chat', effort: 'high', env: {} }), null);
  assert.deepEqual(resolveThinking({ model: DEFAULT_MODEL_FLASH, effort: 'medium', env: {} }), { thinking: { type: 'disabled' } });
  assert.deepEqual(resolveThinking({ model: DEFAULT_MODEL_FLASH, effort: 'high', env: {} }), { thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  assert.deepEqual(resolveThinking({ model: DEFAULT_MODEL_PRO, effort: null, env: {} }), { thinking: { type: 'enabled' }, reasoning_effort: 'medium' });
  assert.deepEqual(resolveThinking({ model: DEFAULT_MODEL_PRO, effort: 'low', env: { CODEX_DEEPSEEK_THINKING: '0' } }), { thinking: { type: 'disabled' } });
  assert.deepEqual(resolveThinking({ model: DEFAULT_MODEL_FLASH, effort: 'low', env: { CODEX_DEEPSEEK_THINKING: '1' } }), { thinking: { type: 'enabled' }, reasoning_effort: 'low' });
});

// ---------------------------------------------------------------------------
// Proyección de tools y transcript

test('toOpenAITools: registry → {type:function, function:{name,description,parameters}} con fallback', () => {
  const out = toOpenAITools([{ name: 't', description: 'd' }, REGISTRY[0]]);
  assert.equal(out[0].type, 'function');
  assert.deepEqual(out[0].function.parameters, { type: 'object', properties: {} });
  assert.equal(out[1].function.name, 'write_file');
  assert.equal(out[1].function.parameters.required[0], 'path');
});

test('toDeepSeekMessages: system al frente, users consecutivos fusionados, user inicial garantizado, adjuntos no textuales anunciados', () => {
  const out = toDeepSeekMessages([
    { role: 'system', content: 'Eres un agente.' },
    { role: 'system', content: 'Segunda regla.' },
    { role: 'user', content: 'construye una app' },
    { role: 'assistant', content: 'voy' },
    { role: 'user', content: '[TOOL_RESULT write_file] OK' },
    { role: 'user', content: [{ type: 'text', text: '[TOOL_RESULT read_file] x' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
  ]);
  assert.equal(out[0].role, 'system');
  assert.match(out[0].content, /Eres un agente\.\n\nSegunda regla\./);
  assert.deepEqual(out.slice(1).map((m) => m.role), ['user', 'assistant', 'user']);
  assert.match(out[3].content, /write_file[\s\S]*read_file[\s\S]*Adjunto no textual omitido/);

  const empty = toDeepSeekMessages([{ role: 'system', content: 'x' }, { role: 'assistant', content: 'A' }]);
  assert.equal(empty[1].role, 'user', 'siempre hay un user inicial tras el system');
});

test('normalizeToolCalls: parsea argumentos JSON, marca JSON roto y tools desconocidas, genera ids', () => {
  const names = new Set(['read_file']);
  const calls = normalizeToolCalls([
    { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } },
    { type: 'function', function: { name: 'read_file', arguments: '{"path": broken' } },
    { id: 'call_c', type: 'function', function: { name: 'rm_rf', arguments: '{}' } },
    { id: 'call_d', type: 'function', function: { name: '', arguments: '{}' } },
  ], names);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], { id: 'call_a', name: 'read_file', args: { path: 'a.js' } });
  assert.equal(calls[1].id, 'call_2');
  assert.deepEqual(calls[1].args, {});
  assert.equal(calls[1].argsParseError, true);
  assert.equal(calls[2].unknownTool, true);
});

// ---------------------------------------------------------------------------
// deepseekTurn: request nativa + parseo de respuesta

test('deepseekTurn: tool_calls nativos → toolCalls; request lleva tools, tool_choice auto y thinking; usage con provider DeepSeek', async () => {
  const client = fakeClient({
    content: 'Creo el archivo.',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"src/App.tsx","content":"x"}' } }],
  }, { usage: { prompt_tokens: 100, completion_tokens: 25, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 } });
  const out = await deepseekTurn({
    messages: [{ role: 'system', content: 'agente' }, { role: 'user', content: 'haz una app' }],
    tools: REGISTRY,
    env: ENV,
    tier: 'power',
    effort: 'high',
    createClient: () => client,
  });
  assert.equal(out.text, 'Creo el archivo.');
  assert.equal(out.toolCalls.length, 1);
  assert.deepEqual(out.toolCalls[0], { id: 'call_1', name: 'write_file', args: { path: 'src/App.tsx', content: 'x' } });
  assert.equal(out.truncated, false);
  assert.equal(out.usage.provider, 'DeepSeek');
  assert.equal(out.usage.model, DEFAULT_MODEL_PRO);
  assert.equal(out.usage.tokensIn, 100);
  assert.equal(out.usage.tokensOut, 25);
  assert.equal(out.usage.cacheReadTokens, 60);
  assert.equal(out.usage.cacheHit, true);
  assert.equal(out.usage.generationId, 'gen_ds_1');

  const req = client.captured[0];
  assert.equal(req.model, DEFAULT_MODEL_PRO);
  assert.equal(req.tools.length, 2);
  assert.equal(req.tools[0].type, 'function');
  assert.equal(req.tool_choice, 'auto');
  assert.deepEqual(req.thinking, { type: 'enabled' });
  assert.equal(req.reasoning_effort, 'high');
  assert.equal(req.messages[0].role, 'system');
  assert.equal(req.stream, undefined, 'sin callbacks no se streamea');
  assert.ok(req.max_tokens >= 4096);
});

test('deepseekTurn: sin tools no envía tools ni tool_choice; sin key lanza; cliente inválido lanza', async () => {
  const client = fakeClient({ content: 'ok' });
  const out = await deepseekTurn({ messages: [{ role: 'user', content: 'x' }], tools: [], env: ENV, tier: 'eco', createClient: () => client });
  assert.equal(out.text, 'ok');
  assert.deepEqual(out.toolCalls, []);
  assert.equal(client.captured[0].tools, undefined);
  assert.equal(client.captured[0].tool_choice, undefined);
  assert.deepEqual(client.captured[0].thinking, { type: 'disabled' }, 'flash sin effort alto no piensa');

  await assert.rejects(() => deepseekTurn({ messages: [], env: {}, createClient: () => client }), /DEEPSEEK_API_KEY/);
  await assert.rejects(() => deepseekTurn({ messages: [], env: ENV, createClient: () => ({}) }), /cliente inválido/);
});

test('deepseekTurn: reasoning_content se expone como reasoning; finish_reason length sin calls → truncated', async () => {
  const withReasoning = fakeClient({ content: 'listo', reasoning_content: 'pensando el plan' });
  const a = await deepseekTurn({ messages: [{ role: 'user', content: 'x' }], tools: REGISTRY, env: ENV, createClient: () => withReasoning });
  assert.equal(a.reasoning.text, 'pensando el plan');

  const cut = fakeClient({ content: 'Escribo el archivo grande…' }, { finishReason: 'length' });
  const b = await deepseekTurn({ messages: [{ role: 'user', content: 'x' }], tools: REGISTRY, env: ENV, createClient: () => cut });
  assert.deepEqual(b.toolCalls, []);
  assert.equal(b.truncated, true);

  // length CON una call completa no es truncamiento (el loop ejecuta la call).
  const cutWithCall = fakeClient({
    content: '',
    tool_calls: [{ id: 'c', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }],
  }, { finishReason: 'length' });
  const c = await deepseekTurn({ messages: [{ role: 'user', content: 'x' }], tools: REGISTRY, env: ENV, createClient: () => cutWithCall });
  assert.equal(c.toolCalls.length, 1);
  assert.equal(c.truncated, false);
});

test('deepseekTurn: rescata un bloque ```tool_call por costumbre cuando no hubo tool_calls nativos', async () => {
  const habit = fakeClient({ content: 'Leo.\n```tool_call\n{"tool":"read_file","args":{"path":"a.js"}}\n```' });
  const out = await deepseekTurn({ messages: [{ role: 'user', content: 'x' }], tools: REGISTRY, env: ENV, createClient: () => habit });
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0].name, 'read_file');
  assert.deepEqual(out.toolCalls[0].args, { path: 'a.js' });
  assert.equal(out.text, 'Leo.');
  assert.ok(!out.text.includes('tool_call'));

  // Una tool que NO está en el registry no se rescata (queda texto inerte).
  const rogue = fakeClient({ content: 'x\n```tool_call\n{"tool":"finalize","args":{}}\n```' });
  const inert = await deepseekTurn({ messages: [{ role: 'user', content: 'x' }], tools: REGISTRY, env: ENV, createClient: () => rogue });
  assert.deepEqual(inert.toolCalls, []);
});

test('deepseekTurn streaming: acumula content, reasoning y tool_calls por index; usage vía include_usage', async () => {
  const chunks = [
    { id: 'gen_s', choices: [{ delta: { reasoning_content: 'pienso ' } }] },
    { id: 'gen_s', choices: [{ delta: { reasoning_content: 'un poco' } }] },
    { id: 'gen_s', choices: [{ delta: { content: 'Creo ' } }] },
    { id: 'gen_s', choices: [{ delta: { content: 'el archivo.' } }] },
    { id: 'gen_s', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.' } }] } }] },
    { id: 'gen_s', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ts","content":"1"}' } }] } }] },
    { id: 'gen_s', choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_y', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.ts"}' } }] } }] },
    { id: 'gen_s', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { id: 'gen_s', choices: [], usage: { prompt_tokens: 50, completion_tokens: 20 } },
  ];
  const client = fakeStreamClient(chunks);
  const text = [];
  const reasoning = [];
  const out = await deepseekTurn({
    messages: [{ role: 'user', content: 'x' }],
    tools: REGISTRY,
    env: ENV,
    tier: 'standard',
    createClient: () => client,
    onTextDelta: (d) => text.push(d),
    onReasoningDelta: (d) => reasoning.push(d),
  });
  assert.equal(client.captured[0].stream, true);
  assert.deepEqual(client.captured[0].stream_options, { include_usage: true });
  assert.deepEqual(text, ['Creo ', 'el archivo.']);
  assert.deepEqual(reasoning, ['pienso ', 'un poco']);
  assert.equal(out.text, 'Creo el archivo.');
  assert.equal(out.reasoning.text, 'pienso un poco');
  assert.equal(out.toolCalls.length, 2);
  assert.deepEqual(out.toolCalls[0], { id: 'call_x', name: 'write_file', args: { path: 'a.ts', content: '1' } });
  assert.deepEqual(out.toolCalls[1], { id: 'call_y', name: 'read_file', args: { path: 'b.ts' } });
  assert.equal(out.usage.tokensIn, 50);
  assert.equal(out.usage.tokensOut, 20);
  assert.equal(out.usage.generationId, 'gen_s');
});

test('deepseekTurn streaming: un corte tras emitir deltas marca partialResponse (fail closed)', async () => {
  const client = {
    chat: {
      completions: {
        create: async () => ({
          async* [Symbol.asyncIterator]() {
            yield { choices: [{ delta: { content: 'hola' } }] };
            throw new Error('socket hang up');
          },
        }),
      },
    },
  };
  await assert.rejects(
    () => deepseekTurn({ messages: [{ role: 'user', content: 'x' }], env: ENV, createClient: () => client, onTextDelta: () => {} }),
    (err) => err.partialResponse === true && /socket hang up/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// llm-turn: despacho + degradación

test('resolveTurnEngine: DeepSeek gana en todos los tiers cuando hay key; sin key se conserva la lógica previa', () => {
  const both = { DEEPSEEK_API_KEY: 'ds', ANTHROPIC_API_KEY: 'sk' };
  assert.equal(resolveTurnEngine({ tier: 'power', env: both }), 'deepseek');
  assert.equal(resolveTurnEngine({ tier: 'standard', env: both }), 'deepseek');
  assert.equal(resolveTurnEngine({ tier: 'eco', env: both }), 'deepseek');
  assert.equal(resolveTurnEngine({ tier: null, env: both }), 'deepseek');
  // Tier recortado → cae al motor previo para ese tier.
  assert.equal(resolveTurnEngine({ tier: 'eco', env: { ...both, CODEX_DEEPSEEK_TIERS: 'standard,power' } }), 'cerebras');
  assert.equal(resolveTurnEngine({ tier: 'power', env: { ...both, CODEX_DEEPSEEK_TIERS: 'standard' } }), 'anthropic');
  assert.equal(resolveTurnEngine({ tier: 'power', env: { ...both, CODEX_DEEPSEEK_DISABLED: '1' } }), 'anthropic');
  assert.equal(resolveTurnEngine({ tier: 'power', env: { ANTHROPIC_API_KEY: 'sk' } }), 'anthropic');
  assert.equal(resolveTurnEngine({ tier: 'eco', env: { ANTHROPIC_API_KEY: 'sk' } }), 'cerebras');
});

test('defaultLlmTurn: con DEEPSEEK_API_KEY usa el motor nativo DeepSeek (sin bloque prompted en el system)', async () => {
  const client = fakeClient({
    content: 'Leo.',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }],
  });
  const turn = await defaultLlmTurn({
    messages: [{ role: 'system', content: 'agente' }, { role: 'user', content: 'x' }],
    tools: REGISTRY,
    env: { ...ENV, ANTHROPIC_API_KEY: 'sk', CEREBRAS_API_KEY: 'csk' },
    tier: 'power',
    createDeepSeekClient: () => client,
    createAnthropicClient: () => { throw new Error('no debería tocar Anthropic'); },
    createClient: () => { throw new Error('no debería tocar Cerebras'); },
  });
  assert.equal(turn.text, 'Leo.');
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.usage.provider, 'DeepSeek');
  assert.equal(turn.usage.model, DEFAULT_MODEL_PRO);
  assert.ok(!client.captured[0].messages[0].content.includes('tool_call'), 'nativo: el catálogo prompted no viaja en el system');
});

test('defaultLlmTurn: DeepSeek nativo falla → Claude nativo si el tier es elegible', async () => {
  const turn = await defaultLlmTurn({
    messages: [{ role: 'user', content: 'hola' }],
    tools: [],
    env: { ...ENV, ANTHROPIC_API_KEY: 'sk', CEREBRAS_API_KEY: 'csk' },
    tier: 'power',
    createDeepSeekClient: () => ({ chat: { completions: { create: async () => { throw new Error('502 deepseek down'); } } } }),
    createAnthropicClient: () => ({
      messages: { create: async () => ({ id: 'm', content: [{ type: 'text', text: 'desde claude' }], usage: { input_tokens: 1, output_tokens: 1 } }) },
    }),
  });
  assert.equal(turn.text, 'desde claude');
  assert.equal(turn.usage.provider, 'Anthropic');
});

test('defaultLlmTurn: DeepSeek nativo falla en eco → ladder prompted SIN volver a DeepSeek (exclude)', async () => {
  let deepseekCalls = 0;
  const failing = { chat: { completions: { create: async () => { deepseekCalls += 1; throw new Error('deepseek 500'); } } } };
  const cerebras = fakeClient({ content: 'Leo.\n```tool_call\n{"tool":"read_file","args":{"path":"a.js"}}\n```' });
  const turn = await defaultLlmTurn({
    messages: [{ role: 'user', content: 'hola' }],
    tools: REGISTRY,
    env: { ...ENV, CEREBRAS_API_KEY: 'csk', FREE_IA_MODEL_ID: 'test-model' },
    tier: 'eco',
    createDeepSeekClient: () => failing,
    createClient: () => cerebras,
  });
  assert.equal(deepseekCalls, 1, 'el peldaño prompted de DeepSeek no se re-intenta tras fallar en nativo');
  assert.equal(turn.usage.provider, 'Cerebras');
  assert.equal(turn.toolCalls.length, 1);
  assert.ok(cerebras.captured[0].messages[0].content.includes('read_file'), 'prompted: el catálogo va en el system');
});

test('defaultLlmTurn: una respuesta DeepSeek parcial (deltas emitidos) no se re-intenta en otro motor', async () => {
  const client = {
    chat: {
      completions: {
        create: async () => ({
          async* [Symbol.asyncIterator]() {
            yield { choices: [{ delta: { content: 'hola' } }] };
            throw new Error('reset');
          },
        }),
      },
    },
  };
  await assert.rejects(
    () => defaultLlmTurn({
      messages: [{ role: 'user', content: 'x' }],
      env: { ...ENV, CEREBRAS_API_KEY: 'csk' },
      tier: 'eco',
      createDeepSeekClient: () => client,
      createClient: () => { throw new Error('no debería llegar a Cerebras'); },
      onTextDelta: () => {},
    }),
    /reset/,
  );
});

test('defaultLlmTurn: abort durante DeepSeek se propaga sin quemar otro motor', async () => {
  const controller = new AbortController();
  const client = { chat: { completions: { create: async () => { controller.abort(); const e = new Error('aborted'); e.name = 'AbortError'; throw e; } } } };
  await assert.rejects(
    () => defaultLlmTurn({
      messages: [{ role: 'user', content: 'x' }],
      env: { ...ENV, ANTHROPIC_API_KEY: 'sk' },
      tier: 'power',
      signal: controller.signal,
      createDeepSeekClient: () => client,
      createAnthropicClient: () => { throw new Error('no debería llegar a Anthropic'); },
    }),
    /aborted/,
  );
});

// ---------------------------------------------------------------------------
// llm-provider: peldaño DeepSeek en el ladder

test('ladder: deepseek va primero cuando su key existe; exclude lo salta', () => {
  const env = { NODE_ENV: 'test', DEEPSEEK_API_KEY: 'ds', ANTHROPIC_API_KEY: 'k1', OPENROUTER_API_KEY: 'k2', CEREBRAS_API_KEY: 'k3' };
  assert.deepEqual(provider.resolveCandidates({ env }), ['deepseek', 'anthropic', 'openrouter', 'cerebras']);
  assert.deepEqual(provider.resolveCandidates({ env, exclude: ['deepseek'] }), ['anthropic', 'openrouter', 'cerebras']);
  assert.deepEqual(provider.resolveCandidates({ env: { ...env, CODEX_LLM_PROVIDER: 'deepseek' } }), ['deepseek']);
  assert.deepEqual(provider.resolveCandidates({ env: { ...env, CODEX_LLM_PROVIDER: 'deepseek' }, exclude: ['deepseek'] }), []);
  assert.equal(provider.LADDER[0], 'deepseek');
});

test('modelFor(deepseek): alias/override normalizados, default flash, env override; cerebras nunca recibe un id DeepSeek', () => {
  const env = { NODE_ENV: 'test', DEEPSEEK_API_KEY: 'ds', CEREBRAS_API_KEY: 'csk', FREE_IA_MODEL_ID: 'llama-x' };
  assert.equal(provider.modelFor('deepseek', env), DEFAULT_MODEL_FLASH);
  assert.equal(provider.modelFor('deepseek', env, 'Sira Pro'), DEFAULT_MODEL_PRO);
  assert.equal(provider.modelFor('deepseek', { ...env, CODEX_DEEPSEEK_MODEL: 'deepseek-chat' }), 'deepseek-chat');
  assert.equal(provider.modelFor('deepseek', env, 'gpt-4o'), DEFAULT_MODEL_FLASH);
  assert.equal(provider.modelFor('cerebras', env, 'deepseek-v4-flash'), 'llama-x', 'un id DeepSeek no se manda a Cerebras');
  assert.equal(provider.defaultMaxTokensFor('deepseek'), 8192);
});

test('chatComplete: peldaño deepseek (prompted) con cliente inyectado, streaming con include_usage y failover al siguiente', async () => {
  const ds = fakeClient({ content: 'desde deepseek' }, { usage: { prompt_tokens: 3, completion_tokens: 2 } });
  const env = { NODE_ENV: 'test', DEEPSEEK_API_KEY: 'ds', OPENROUTER_API_KEY: 'k2' };
  const out = await provider.chatComplete({ messages: [{ role: 'user', content: 'U' }], env, clients: { deepseek: ds } });
  assert.equal(out.content, 'desde deepseek');
  assert.equal(out.usage.provider, 'DeepSeek');
  assert.equal(out.usage.model, DEFAULT_MODEL_FLASH);
  assert.equal(ds.captured[0].model, DEFAULT_MODEL_FLASH);
  assert.equal(ds.captured[0].thinking, undefined, 'el peldaño prompted no manda controles de thinking');

  const streaming = fakeStreamClient([
    { id: 'g', choices: [{ delta: { content: 'a' } }] },
    { id: 'g', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  ]);
  const deltas = [];
  const s = await provider.chatComplete({ messages: [{ role: 'user', content: 'U' }], env, clients: { deepseek: streaming }, onTextDelta: (d) => deltas.push(d) });
  assert.deepEqual(streaming.captured[0].stream_options, { include_usage: true });
  assert.deepEqual(deltas, ['a']);
  assert.equal(s.usage.tokensIn, 1);

  const boom = { chat: { completions: { create: async () => { throw new Error('deepseek 503'); } } } };
  const or = fakeClient({ content: 'desde openrouter' });
  const f = await provider.chatComplete({ messages: [{ role: 'user', content: 'U' }], env, clients: { deepseek: boom, openrouter: or } });
  assert.equal(f.content, 'desde openrouter');
  assert.deepEqual(provider.resolveCandidates({ env }), ['openrouter', 'deepseek'], 'deepseek queda en cuarentena');
});

test('describeActiveProvider reporta deepseek + modelo cuando su key existe', () => {
  const env = { NODE_ENV: 'test', DEEPSEEK_API_KEY: 'ds', CEREBRAS_API_KEY: 'csk' };
  assert.deepEqual(provider.describeActiveProvider({ env }), { provider: 'deepseek', model: DEFAULT_MODEL_FLASH });
});
