'use strict';

/**
 * OT-1 — Anthropic prompt caching in the codex engine (CODEX_PROMPT_CACHE).
 *
 * Verifies, with a fully mocked client (no SDK, no network), the EXACT payload
 * shape sent to the Anthropic API by both Anthropic call paths:
 *   - anthropic-turn.anthropicTurn (native tool-use engine)
 *   - llm-provider.callAnthropic / chatComplete (prompted-protocol ladder)
 *
 * Flag ON (default): cache_control {type:'ephemeral'} lands on the system
 * block, on the last completed turn of the stable transcript prefix, and (for
 * anthropic-turn) on the LAST tool. Flag OFF (CODEX_PROMPT_CACHE=0): the
 * payload carries no cache_control anywhere and system stays a plain string.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  anthropicTurn,
  cacheEnabled,
} = require('../src/services/codex/anthropic-turn');
const provider = require('../src/services/codex/llm-provider');

const EPHEMERAL = { type: 'ephemeral' };

// System prompt large enough to clear llm-provider's minimum-size gate
// (Anthropic ignores breakpoints on tiny prefixes; codex prompts are huge).
const BIG_SYSTEM = `Eres el agente codex de SiraGPT. ${'Reglas estables del loop. '.repeat(64)}`;

const MESSAGES = [
  { role: 'system', content: BIG_SYSTEM },
  { role: 'user', content: 'Construye la app.' },
  { role: 'assistant', content: 'Voy a listar los archivos.' },
  { role: 'user', content: '[TOOL_RESULT list_files] src/App.tsx' },
];

const TOOLS = [
  { name: 'list_files', description: 'Lista archivos', parameters: { type: 'object', properties: {} } },
  { name: 'read_file', description: 'Lee un archivo', parameters: { type: 'object', properties: {} } },
];

const FAKE_RESPONSE = {
  id: 'msg_test',
  content: [{ type: 'text', text: 'listo' }],
  usage: { input_tokens: 10, output_tokens: 2 },
};

/** Walk the whole payload and collect every cache_control with its JSON path. */
function collectCacheControls(value, path = '$', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectCacheControls(item, `${path}[${i}]`, found));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'cache_control') found.push({ path: `${path}.cache_control`, value: child });
      else collectCacheControls(child, `${path}.${key}`, found);
    }
  }
  return found;
}

function captureClient(captured) {
  return () => ({
    messages: {
      create: async (req) => {
        captured.push(req);
        return FAKE_RESPONSE;
      },
    },
  });
}

function fakeAnthropicCtor(captured) {
  return class FakeAnthropic {
    constructor(opts) {
      this.opts = opts;
      this.messages = {
        create: async (req) => {
          captured.push(req);
          return FAKE_RESPONSE;
        },
      };
    }
  };
}

test.beforeEach(() => provider.resetQuarantine());

// ---------------------------------------------------------------------------
// cacheEnabled flag semantics
// ---------------------------------------------------------------------------

test('cacheEnabled: CODEX_PROMPT_CACHE default ON, =0 off, legacy flag still honoured', () => {
  assert.equal(cacheEnabled({}), true, 'default es ON');
  assert.equal(cacheEnabled({ CODEX_PROMPT_CACHE: '1' }), true);
  assert.equal(cacheEnabled({ CODEX_PROMPT_CACHE: '0' }), false);
  assert.equal(cacheEnabled({ CODEX_ANTHROPIC_CACHE: '0' }), false, 'flag legacy sigue apagando');
  assert.equal(cacheEnabled({ CODEX_PROMPT_CACHE: '1', CODEX_ANTHROPIC_CACHE: '0' }), false);
  assert.equal(cacheEnabled({ CODEX_PROMPT_CACHE: '0', CODEX_ANTHROPIC_CACHE: '1' }), false);
});

// ---------------------------------------------------------------------------
// anthropic-turn (native tool-use path)
// ---------------------------------------------------------------------------

test('anthropicTurn ON: breakpoints exactos en system, prefijo estable y último tool', async () => {
  const captured = [];
  await anthropicTurn({
    messages: MESSAGES,
    tools: TOOLS,
    env: { ANTHROPIC_API_KEY: 'sk-test' },
    tier: 'power',
    createClient: captureClient(captured),
    maxTokens: 128,
  });

  assert.equal(captured.length, 1);
  const req = captured[0];

  // system viaja como array de bloques; el bloque lleva el breakpoint.
  assert.deepEqual(req.system, [
    { type: 'text', text: BIG_SYSTEM, cache_control: EPHEMERAL },
  ]);

  // Transcript: el turno ANTERIOR al tail (prefijo estable) lleva el
  // breakpoint; el primer turno y el tail vivo quedan sin marcar.
  assert.equal(req.messages.length, 3);
  assert.equal(req.messages[0].content, 'Construye la app.');
  assert.deepEqual(req.messages[1], {
    role: 'assistant',
    content: [{ type: 'text', text: 'Voy a listar los archivos.', cache_control: EPHEMERAL }],
  });
  assert.equal(req.messages[2].content, '[TOOL_RESULT list_files] src/App.tsx');

  // Tools: SOLO el último lleva cache_control (cachea todo el bloque de tools).
  assert.equal(req.tools[0].cache_control, undefined);
  assert.deepEqual(req.tools[1].cache_control, EPHEMERAL);

  // Exactamente 3 breakpoints en todo el payload (system + prefijo + tools).
  const marks = collectCacheControls(req);
  assert.equal(marks.length, 3, JSON.stringify(marks));
  for (const mark of marks) assert.deepEqual(mark.value, EPHEMERAL);
});

test('anthropicTurn OFF (CODEX_PROMPT_CACHE=0): payload sin ningún cache_control', async () => {
  const captured = [];
  await anthropicTurn({
    messages: MESSAGES,
    tools: TOOLS,
    env: { ANTHROPIC_API_KEY: 'sk-test', CODEX_PROMPT_CACHE: '0' },
    tier: 'power',
    createClient: captureClient(captured),
    maxTokens: 128,
  });

  const req = captured[0];
  assert.equal(req.system, BIG_SYSTEM, 'system degrada a string plano');
  assert.deepEqual(req.messages, [
    { role: 'user', content: 'Construye la app.' },
    { role: 'assistant', content: 'Voy a listar los archivos.' },
    { role: 'user', content: '[TOOL_RESULT list_files] src/App.tsx' },
  ]);
  assert.deepEqual(collectCacheControls(req), []);
});

// ---------------------------------------------------------------------------
// llm-provider.callAnthropic (prompted ladder path)
// ---------------------------------------------------------------------------

test('callAnthropic ON: breakpoints en system y en el último turno del prefijo estable', async () => {
  const captured = [];
  await provider.callAnthropic({
    messages: MESSAGES,
    temperature: 0.3,
    maxTokens: 256,
    env: { NODE_ENV: 'test', ANTHROPIC_API_KEY: 'sk-test' },
    ctor: fakeAnthropicCtor(captured),
  });

  assert.equal(captured.length, 1);
  const req = captured[0];

  assert.deepEqual(req.system, [
    { type: 'text', text: BIG_SYSTEM, cache_control: EPHEMERAL },
  ]);
  assert.equal(req.messages[0].content, 'Construye la app.');
  assert.deepEqual(req.messages[1], {
    role: 'assistant',
    content: [{ type: 'text', text: 'Voy a listar los archivos.', cache_control: EPHEMERAL }],
  });
  assert.equal(req.messages[2].content, '[TOOL_RESULT list_files] src/App.tsx');

  // Sin tools en este camino: exactamente 2 breakpoints (system + prefijo).
  const marks = collectCacheControls(req);
  assert.equal(marks.length, 2, JSON.stringify(marks));
});

test('callAnthropic OFF (CODEX_PROMPT_CACHE=0): request idéntico al shape legacy', async () => {
  const captured = [];
  await provider.callAnthropic({
    messages: MESSAGES,
    temperature: 0.3,
    maxTokens: 256,
    env: { NODE_ENV: 'test', ANTHROPIC_API_KEY: 'sk-test', CODEX_PROMPT_CACHE: '0' },
    ctor: fakeAnthropicCtor(captured),
  });

  const req = captured[0];
  assert.equal(req.system, BIG_SYSTEM);
  assert.deepEqual(req.messages, [
    { role: 'user', content: 'Construye la app.' },
    { role: 'assistant', content: 'Voy a listar los archivos.' },
    { role: 'user', content: '[TOOL_RESULT list_files] src/App.tsx' },
  ]);
  assert.deepEqual(collectCacheControls(req), []);
});

test('callAnthropic OFF (legacy CODEX_ANTHROPIC_CACHE=0): también degrada sin cache_control', async () => {
  const captured = [];
  await provider.callAnthropic({
    messages: MESSAGES,
    temperature: 0.3,
    maxTokens: 256,
    env: { NODE_ENV: 'test', ANTHROPIC_API_KEY: 'sk-test', CODEX_ANTHROPIC_CACHE: '0' },
    ctor: fakeAnthropicCtor(captured),
  });
  assert.deepEqual(collectCacheControls(captured[0]), []);
});

test('callAnthropic: system pequeño no gasta breakpoint (queda string), transcript sí cachea', async () => {
  const captured = [];
  await provider.callAnthropic({
    messages: [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'uno' },
      { role: 'assistant', content: 'dos' },
      { role: 'user', content: 'tres' },
    ],
    temperature: 0.3,
    maxTokens: 64,
    env: { NODE_ENV: 'test', ANTHROPIC_API_KEY: 'sk-test' },
    ctor: fakeAnthropicCtor(captured),
  });

  const req = captured[0];
  assert.equal(req.system, 'S', 'por debajo del mínimo cacheable sigue siendo string');
  const marks = collectCacheControls(req);
  assert.equal(marks.length, 1, 'solo el breakpoint del prefijo del transcript');
  assert.deepEqual(req.messages[1].content, [
    { type: 'text', text: 'dos', cache_control: EPHEMERAL },
  ]);
  assert.equal(req.messages[2].content, 'tres');
});

test('chatComplete (entrada pública) enruta por anthropic con los breakpoints puestos', async () => {
  const captured = [];
  const out = await provider.chatComplete({
    messages: MESSAGES,
    env: { NODE_ENV: 'test', ANTHROPIC_API_KEY: 'sk-test' },
    clients: { anthropicCtor: fakeAnthropicCtor(captured) },
  });

  assert.equal(out.content, 'listo');
  assert.equal(out.usage.provider, 'Anthropic');
  const req = captured[0];
  assert.deepEqual(req.system[0].cache_control, EPHEMERAL);
  assert.equal(collectCacheControls(req).length, 2);
});

test('chatComplete con CODEX_PROMPT_CACHE=0: la entrada pública tampoco emite cache_control', async () => {
  const captured = [];
  await provider.chatComplete({
    messages: MESSAGES,
    env: { NODE_ENV: 'test', ANTHROPIC_API_KEY: 'sk-test', CODEX_PROMPT_CACHE: '0' },
    clients: { anthropicCtor: fakeAnthropicCtor(captured) },
  });
  assert.equal(captured[0].system, BIG_SYSTEM);
  assert.deepEqual(collectCacheControls(captured[0]), []);
});
