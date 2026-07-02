'use strict';

/**
 * Tests del motor Claude (anthropic-turn + despacho por tier en llm-turn) y de
 * las mejoras Claude Code-parity del loop: herramientas list_files/grep_search,
 * read_file con offset/limit, edit_file replaceAll, verificación post-build con
 * autocorrección y compactación de contexto. Todo offline (clientes inyectados).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  anthropicTurn,
  getAnthropicTurnConfig,
  toAnthropicMessages,
  toAnthropicTools,
  DEFAULT_MODEL_POWER,
  DEFAULT_MODEL_STANDARD,
} = require('../src/services/codex/anthropic-turn');
const { defaultLlmTurn, resolveTurnEngine } = require('../src/services/codex/llm-turn');
const buildTools = require('../src/services/codex/build-tools');
const { runAgentLoop, compactMessages, verifyWorkspace } = require('../src/services/codex/agent-loop');

// ---------------------------------------------------------------------------
// anthropic-turn config + message conversion

test('getAnthropicTurnConfig: sin key → disabled; tier controla modelo y elegibilidad', () => {
  assert.equal(getAnthropicTurnConfig({ env: {}, tier: 'power' }).enabled, false);

  const env = { ANTHROPIC_API_KEY: 'sk-test' };
  const power = getAnthropicTurnConfig({ env, tier: 'power' });
  assert.equal(power.enabled, true);
  assert.equal(power.tierEligible, true);
  assert.equal(power.model, DEFAULT_MODEL_POWER);

  const standard = getAnthropicTurnConfig({ env, tier: 'standard' });
  assert.equal(standard.tierEligible, true);
  assert.equal(standard.model, DEFAULT_MODEL_STANDARD);

  const eco = getAnthropicTurnConfig({ env, tier: 'eco' });
  assert.equal(eco.tierEligible, false, 'eco nunca va a Claude por defecto');

  const off = getAnthropicTurnConfig({ env: { ...env, CODEX_ANTHROPIC_DISABLED: '1' }, tier: 'power' });
  assert.equal(off.enabled, false);

  const custom = getAnthropicTurnConfig({ env: { ...env, CODEX_ANTHROPIC_TIERS: 'power' }, tier: 'standard' });
  assert.equal(custom.tierEligible, false, 'CODEX_ANTHROPIC_TIERS restringe los tiers elegibles');
});

test('toAnthropicMessages: extrae system, fusiona users consecutivos y garantiza user inicial', () => {
  const { system, turns } = toAnthropicMessages([
    { role: 'system', content: 'Eres un agente.' },
    { role: 'user', content: 'construye una app' },
    { role: 'assistant', content: 'voy' },
    { role: 'user', content: '[TOOL_RESULT write_file] OK' },
    { role: 'user', content: '[TOOL_RESULT run_command] exit 0' },
  ]);
  assert.equal(system, 'Eres un agente.');
  assert.equal(turns.length, 3);
  assert.equal(turns[0].role, 'user');
  assert.equal(turns[1].role, 'assistant');
  assert.equal(turns[2].role, 'user');
  assert.match(turns[2].content, /write_file[\s\S]*run_command/, 'users consecutivos fusionados');

  const empty = toAnthropicMessages([{ role: 'system', content: 'x' }]);
  assert.equal(empty.turns[0].role, 'user', 'siempre hay un user inicial');
});

test('anthropicTurn: tool_use nativo → toolCalls; usage con provider Anthropic', async () => {
  let captured = null;
  const createClient = () => ({
    messages: {
      create: async (req) => {
        captured = req;
        return {
          id: 'msg_1',
          content: [
            { type: 'text', text: 'Creo el archivo.' },
            { type: 'tool_use', id: 'tu_1', name: 'write_file', input: { path: 'src/App.tsx', content: 'x' } },
          ],
          usage: { input_tokens: 100, output_tokens: 25 },
        };
      },
    },
  });
  const out = await anthropicTurn({
    messages: [
      { role: 'system', content: 'agente' },
      { role: 'user', content: 'haz una app' },
    ],
    tools: [{ name: 'write_file', description: 'escribe', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    env: { ANTHROPIC_API_KEY: 'sk-test' },
    tier: 'power',
    createClient,
  });
  assert.equal(out.text, 'Creo el archivo.');
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0].name, 'write_file');
  assert.deepEqual(out.toolCalls[0].args, { path: 'src/App.tsx', content: 'x' });
  assert.equal(out.usage.provider, 'Anthropic');
  assert.equal(out.usage.tokensIn, 100);
  assert.equal(out.usage.model, DEFAULT_MODEL_POWER);
  // Proyección de tools al formato nativo.
  assert.equal(captured.tools[0].name, 'write_file');
  assert.ok(captured.tools[0].input_schema);
  assert.equal(captured.model, DEFAULT_MODEL_POWER);
  assert.equal(captured.system, 'agente');
});

test('toAnthropicTools: parameters → input_schema con fallback', () => {
  const out = toAnthropicTools([{ name: 't', description: 'd' }]);
  assert.deepEqual(out[0].input_schema, { type: 'object', properties: {} });
});

// ---------------------------------------------------------------------------
// llm-turn: despacho por tier + fallback

test('resolveTurnEngine: anthropic solo con key + tier elegible', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-test' };
  assert.equal(resolveTurnEngine({ tier: 'power', env }), 'anthropic');
  assert.equal(resolveTurnEngine({ tier: 'standard', env }), 'anthropic');
  assert.equal(resolveTurnEngine({ tier: 'eco', env }), 'cerebras');
  assert.equal(resolveTurnEngine({ tier: null, env }), 'cerebras');
  assert.equal(resolveTurnEngine({ tier: 'power', env: {} }), 'cerebras');
});

test('defaultLlmTurn: tier power usa Claude; si Claude falla degrada a Cerebras', async () => {
  const env = { ANTHROPIC_API_KEY: 'sk-test', CEREBRAS_API_KEY: 'csk-test', NODE_ENV: 'test' };
  // 1) Camino feliz por Claude.
  const viaClaude = await defaultLlmTurn({
    messages: [{ role: 'user', content: 'hola' }],
    tools: [],
    env,
    tier: 'power',
    createAnthropicClient: () => ({
      messages: { create: async () => ({ id: 'm', content: [{ type: 'text', text: 'desde claude' }], usage: { input_tokens: 1, output_tokens: 1 } }) },
    }),
  });
  assert.equal(viaClaude.text, 'desde claude');
  assert.equal(viaClaude.usage.provider, 'Anthropic');

  // 2) Claude revienta → cae al cliente Cerebras inyectado.
  const viaFallback = await defaultLlmTurn({
    messages: [{ role: 'user', content: 'hola' }],
    tools: [],
    env,
    tier: 'power',
    createAnthropicClient: () => ({ messages: { create: async () => { throw new Error('boom anthropic'); } } }),
    createClient: () => ({
      chat: { completions: { create: async () => ({ choices: [{ message: { content: 'desde cerebras' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) } },
    }),
  });
  assert.equal(viaFallback.text, 'desde cerebras');
  assert.equal(viaFallback.usage.provider, 'Cerebras');
});

// ---------------------------------------------------------------------------
// build-tools: herramientas nuevas + read offset + edit replaceAll

function toolCtx({ files = new Map(), execImpl } = {}) {
  return {
    project: 'p1',
    runner: {
      readFile: async (_p, path) => {
        if (!files.has(path)) throw new Error(`no existe ${path}`);
        return { content: files.get(path) };
      },
      writeFiles: async (_p, writes) => { for (const w of writes) files.set(w.path, w.content); return { ok: true }; },
      exec: execImpl || (async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    },
  };
}

test('list_files: lista vía git ls-files y filtra por patrón', async () => {
  const ctx = toolCtx({
    execImpl: async (_p, cmd) => {
      assert.deepEqual(cmd.slice(0, 2), ['git', 'ls-files']);
      return { exitCode: 0, stdout: 'src/App.tsx\nsrc/main.tsx\nindex.html\n', stderr: '' };
    },
  });
  const all = await buildTools.getTool('list_files').execute({}, ctx);
  assert.equal(all.isError, false);
  assert.match(all.observation, /src\/App\.tsx/);

  const filtered = await buildTools.getTool('list_files').execute({ pattern: '*.tsx' }, ctx);
  assert.match(filtered.observation, /App\.tsx/);
  assert.ok(!filtered.observation.includes('index.html'));
});

test('grep_search: git grep con exit 1 = sin coincidencias (no error)', async () => {
  const hits = toolCtx({
    execImpl: async (_p, cmd) => {
      assert.deepEqual(cmd.slice(0, 2), ['git', 'grep']);
      assert.ok(cmd.includes('--untracked'));
      return { exitCode: 0, stdout: 'src/App.tsx:4:const accent = 1', stderr: '' };
    },
  });
  const found = await buildTools.getTool('grep_search').execute({ pattern: 'accent' }, hits);
  assert.equal(found.isError, false);
  assert.match(found.observation, /App\.tsx:4/);

  const none = toolCtx({ execImpl: async () => ({ exitCode: 1, stdout: '', stderr: '' }) });
  const miss = await buildTools.getTool('grep_search').execute({ pattern: 'nada' }, none);
  assert.equal(miss.isError, false);
  assert.match(miss.observation, /Sin coincidencias/);
});

test('read_file: offset/limit devuelve la ventana pedida con encabezado', async () => {
  const files = new Map([['a.txt', 'l1\nl2\nl3\nl4\nl5']]);
  const out = await buildTools.getTool('read_file').execute({ path: 'a.txt', offset: 2, limit: 2 }, toolCtx({ files }));
  assert.equal(out.isError, false);
  assert.equal(out.linesRead, 2);
  assert.match(out.observation, /\[líneas 2-3 de 5\]/);
  assert.match(out.observation, /l2\nl3/);
});

test('edit_file: ambiguo sin replaceAll falla con guía; replaceAll reemplaza todas', async () => {
  const files = new Map([['a.txt', 'x foo y foo z']]);
  const tool = buildTools.getTool('edit_file');

  const ambiguous = await tool.execute({ path: 'a.txt', find: 'foo', replace: 'bar' }, toolCtx({ files }));
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.observation, /2 veces/);
  assert.equal(files.get('a.txt'), 'x foo y foo z', 'no muta en ambigüedad');

  const all = await tool.execute({ path: 'a.txt', find: 'foo', replace: 'bar', replaceAll: true }, toolCtx({ files }));
  assert.equal(all.isError, false);
  assert.equal(files.get('a.txt'), 'x bar y bar z');
});

// ---------------------------------------------------------------------------
// agent-loop: compactación + verificación con autocorrección

test('compactMessages: recorta TOOL_RESULT antiguos y respeta system/prompt/cola', () => {
  const big = 'X'.repeat(5_000);
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'construye' },
  ];
  for (let i = 0; i < 20; i += 1) messages.push({ role: 'user', content: `[TOOL_RESULT read_file] ${big}` });
  const compacted = compactMessages(messages, { maxChars: 10_000 });
  assert.ok(compacted > 0);
  assert.equal(messages[0].content, 'sys');
  assert.equal(messages[1].content, 'construye');
  assert.ok(messages[2].content.length < 500, 'los antiguos quedan recortados');
  assert.ok(messages[messages.length - 1].content.length > 4_000, 'la cola queda intacta');

  const small = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  assert.equal(compactMessages(small, { maxChars: 10_000 }), 0, 'bajo presupuesto no toca nada');
});

test('verifyWorkspace: tsconfig inválido o ausente → no-op determinista', async () => {
  const noopEvents = { appendEvent: async () => {} };
  const clock = () => new Date(0);
  const base = { run: { id: 'r' }, eventStore: noopEvents, prisma: null, clock, env: {}, actionId: 'a1', groupId: 'g1', projectId: 'p1' };

  const missing = await verifyWorkspace({ ...base, runner: { readFile: async () => { throw new Error('nope'); }, exec: async () => ({ exitCode: 0 }) } });
  assert.deepEqual({ ran: missing.ran, ok: missing.ok }, { ran: false, ok: true });

  const garbage = await verifyWorkspace({ ...base, runner: { readFile: async () => ({ content: 'a\nb\nc' }), exec: async () => ({ exitCode: 0 }) } });
  assert.equal(garbage.ran, false, 'tsconfig no-JSON no dispara verificación');
});

test('build loop: verificación falla → ronda de reparación → done', async () => {
  const tsconfig = JSON.stringify({ compilerOptions: { strict: true } });
  const files = new Map([['tsconfig.json', tsconfig]]);
  let tscRuns = 0;
  const events = [];
  const runner = {
    readFile: async (_p, path) => {
      if (!files.has(path)) throw new Error(`no existe ${path}`);
      return { content: files.get(path) };
    },
    writeFiles: async (_p, writes) => { for (const w of writes) files.set(w.path, w.content); return { ok: true }; },
    exec: async (_p, cmd) => {
      if (cmd[0] === 'bun' && cmd[1] === 'install') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd[0] === 'bunx' && cmd[1] === 'tsc') {
        tscRuns += 1;
        // Primera verificación falla; tras la reparación pasa.
        return tscRuns === 1
          ? { exitCode: 2, stdout: "src/App.tsx(3,1): error TS2304: Cannot find name 'foo'.", stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd[0] === 'git' && cmd[1] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
  let sawRepairPrompt = false;
  const llmTurn = async ({ messages }) => {
    const last = messages[messages.length - 1];
    if (typeof last?.content === 'string' && last.content.startsWith('[VERIFICACIÓN]')) {
      sawRepairPrompt = true;
      assert.match(last.content, /TS2304/);
      return { text: 'Corrijo el error.', toolCalls: [{ name: 'edit_file', args: { path: 'tsconfig.json', find: '"strict":true', replace: '"strict":true' } }] };
    }
    return { text: 'Listo.', toolCalls: [] };
  };
  const res = await runAgentLoop({
    run: { id: 'r1', mode: 'build', prompt: 'haz una app', tier: 'eco' },
    project: { id: 'p1', name: 'X' },
    deps: {
      llmTurn,
      runner,
      fileTree: '',
      plan: null,
      eventStore: { appendEvent: async (_r, type, data) => { events.push({ type, data }); }, listEvents: async () => [] },
      actionStore: { recordAction: async () => {} },
      clock: (() => { let t = 0; return () => new Date(1_000_000 + (t += 10)); })(),
    },
  });
  assert.equal(res.status, 'done');
  assert.equal(sawRepairPrompt, true, 'los errores de tsc vuelven al modelo');
  assert.equal(tscRuns, 2, 'reverifica tras la reparación');
  const verifyActions = events.filter((e) => e.type === 'action_start' && /verificación/.test(e.data.command || ''));
  assert.equal(verifyActions.length, 2, 'la verificación aparece en la timeline');
});

test('build loop: tool calls por encima del budget se reportan al modelo', async () => {
  let turnCount = 0;
  let transcript = [];
  const llmTurn = async ({ messages }) => {
    turnCount += 1;
    transcript = messages.map((m) => String(m.content || ''));
    if (turnCount === 1) {
      return {
        text: 'muchas herramientas',
        toolCalls: Array.from({ length: 6 }, (_, i) => ({ name: 'write_file', args: { path: `f${i}.txt`, content: 'x' } })),
      };
    }
    return { text: 'fin', toolCalls: [] };
  };
  const f = {
    llmTurn,
    runner: {
      readFile: async () => { throw new Error('no'); },
      writeFiles: async () => ({ ok: true }),
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    },
    fileTree: '',
    plan: null,
    eventStore: { appendEvent: async () => {}, listEvents: async () => [] },
    actionStore: { recordAction: async () => {} },
    clock: () => new Date(0),
  };
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build', prompt: 'x' }, project: { id: 'p1' }, deps: f });
  assert.equal(res.status, 'done');
  const budgetMsg = transcript.find((c) => c.startsWith('[BUDGET]'));
  assert.ok(budgetMsg, 'el modelo recibe el aviso de tool calls omitidas');
  assert.match(budgetMsg, /2 tool calls/);
});
