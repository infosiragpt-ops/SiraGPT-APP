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
const { runAgentLoop, compactMessages, verifyWorkspace, verifyDevServer } = require('../src/services/codex/agent-loop');

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

// ---------------------------------------------------------------------------
// Runtime dev-server verification (flag-gated CODEX_VERIFY_DEV_SERVER, off by default)

// A fake runner whose dev-server methods are tracked so a test can assert they
// were (or were NOT) invoked. `devStatusSeq` scripts successive devStatus() answers.
function devRunner({ devStatusSeq = [], startDevImpl, files = new Map([['tsconfig.json', JSON.stringify({ compilerOptions: {} })]]) } = {}) {
  const calls = { startDev: 0, stopDev: 0, devStatus: 0 };
  const seq = devStatusSeq.slice();
  let last = { running: false };
  return {
    calls,
    readFile: async (_p, path) => { if (!files.has(path)) throw new Error(`no existe ${path}`); return { content: files.get(path) }; },
    writeFiles: async (_p, w) => { for (const f of w) files.set(f.path, f.content); return { ok: true }; },
    exec: async (_p, cmd) => {
      if (cmd[0] === 'bunx' && cmd[1] === 'tsc') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd[0] === 'bun' && cmd[1] === 'install') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd[0] === 'git' && cmd[1] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    devStatus: async () => { calls.devStatus += 1; if (seq.length) last = seq.shift(); return last; },
    startDev: async (p) => { calls.startDev += 1; if (startDevImpl) return startDevImpl(p); return { port: 5173 }; },
    stopDev: async () => { calls.stopDev += 1; return { ok: true }; },
  };
}

const RT_BASE = { run: { id: 'r' }, prisma: null, actionId: 'a1', groupId: 'g1', projectId: 'p1' };

test('verifyDevServer: flag off (unset) → no-op, no arranca dev server', async () => {
  const runner = devRunner();
  const noop = { appendEvent: async () => {} };
  const out = await verifyDevServer({ ...RT_BASE, runner, eventStore: noop, clock: () => new Date(0), env: {} });
  assert.deepEqual({ ran: out.ran, ok: out.ok }, { ran: false, ok: true });
  assert.equal(runner.calls.startDev, 0, 'no toca el dev server con el flag apagado');
  assert.equal(runner.calls.devStatus, 0);
});

test('verifyDevServer: flag on + dev server ready → verificación OK', async () => {
  const runner = devRunner({ devStatusSeq: [{ running: false }, { running: true, ready: true, project: 'p1', tail: ['VITE ready in 300ms'] }] });
  const events = [];
  const out = await verifyDevServer({
    ...RT_BASE, runner, eventStore: { appendEvent: async (_r, t, d) => { events.push({ t, d }); } }, clock: () => new Date(0), env: { CODEX_VERIFY_DEV_SERVER: '1', CODEX_VERIFY_DEV_TIMEOUT_MS: '4000' },
  });
  assert.equal(out.ran, true);
  assert.equal(out.ok, true);
  assert.equal(runner.calls.startDev, 1, 'arrancó el dev server para verificar');
  assert.ok(events.some((e) => e.t === 'action_start' && /verificación runtime: dev server/.test(e.d.command || '')));
  assert.ok(events.some((e) => e.t === 'action_end' && e.d.status === 'done'));
});

test('verifyDevServer: flag on + dev server error → ok:false con errores realimentados', async () => {
  const runner = devRunner({ devStatusSeq: [{ running: false }, { running: true, ready: false, project: 'p1', error: 'Failed to resolve import "./missing"', tail: ['[vite] Internal server error', 'Cannot find module ./missing'] }] });
  const events = [];
  const out = await verifyDevServer({
    ...RT_BASE, runner, eventStore: { appendEvent: async (_r, t, d) => { events.push({ t, d }); } }, clock: () => new Date(0), env: { CODEX_VERIFY_DEV_SERVER: '1', CODEX_VERIFY_DEV_TIMEOUT_MS: '4000' },
  });
  assert.equal(out.ran, true);
  assert.equal(out.ok, false, 'un error real de runtime falla la verificación');
  assert.match(out.errors, /Failed to resolve import|Cannot find module/);
  assert.ok(events.some((e) => e.t === 'action_end' && e.d.status === 'error'));
});

test('verifyDevServer: flag on + runner que lanza (infra caída) → degrada a no verificado sin error', async () => {
  const runner = devRunner();
  runner.startDev = async () => { runner.calls.startDev += 1; throw new Error('runner unreachable'); };
  const out = await verifyDevServer({
    ...RT_BASE, runner, eventStore: { appendEvent: async () => {} }, clock: () => new Date(0), env: { CODEX_VERIFY_DEV_SERVER: '1' },
  });
  assert.deepEqual({ ran: out.ran, ok: out.ok }, { ran: false, ok: true }, 'infra caída NO convierte un build bueno en error');
  assert.equal(runner.calls.stopDev, 0, 'no había servidor propio que parar (start falló)');
});

test('verifyDevServer: dev server que nunca responde (sin error) → no verificado + para el que arrancó', async () => {
  // Primer devStatus: no corriendo (lo arrancamos); luego siempre "no ready y
  // sin error/tail" → timeout → infra symptom, y paramos el que arrancamos.
  const runner = devRunner({ devStatusSeq: [] });
  let n = 0;
  runner.devStatus = async () => { runner.calls.devStatus += 1; n += 1; return n === 1 ? { running: false } : { running: false, ready: false, project: 'p1' }; };
  const out = await verifyDevServer({
    ...RT_BASE, runner, eventStore: { appendEvent: async () => {} }, clock: () => new Date(0), env: { CODEX_VERIFY_DEV_SERVER: '1', CODEX_VERIFY_DEV_TIMEOUT_MS: '3000' },
  });
  assert.deepEqual({ ran: out.ran, ok: out.ok }, { ran: false, ok: true }, 'timeout sin error → no verificado, no fallo');
  assert.equal(runner.calls.stopDev, 1, 'para el dev server que arrancó para verificar');
});

test('build loop: flag on + dev server error → inyecta [VERIFICACIÓN RUNTIME] y repara, luego done', async () => {
  // tsc limpio siempre; dev server: primer arranque falla, segundo (tras el fix) ok.
  let devStarts = 0;
  const files = new Map([['tsconfig.json', JSON.stringify({ compilerOptions: {} })], ['package.json', '{}']]);
  const events = [];
  const runner = {
    readFile: async (_p, path) => { if (!files.has(path)) throw new Error(`no existe ${path}`); return { content: files.get(path) }; },
    writeFiles: async (_p, w) => { for (const f of w) files.set(f.path, f.content); return { ok: true }; },
    exec: async (_p, cmd) => {
      if (cmd[0] === 'bunx' && cmd[1] === 'tsc') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd[0] === 'bun' && cmd[1] === 'install') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd[0] === 'git' && cmd[1] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    devStatus: async () => (devStarts === 0
      ? { running: false }
      : (devStarts === 1
        ? { running: true, ready: false, project: 'p1', error: 'Failed to resolve import "./x"', tail: ['[vite] error'] }
        : { running: true, ready: true, project: 'p1', tail: ['VITE ready'] })),
    startDev: async () => { devStarts += 1; return { port: 5173 }; },
    stopDev: async () => ({ ok: true }),
  };
  let sawRuntimePrompt = false;
  const llmTurn = async ({ messages }) => {
    const last = messages[messages.length - 1];
    if (typeof last?.content === 'string' && last.content.startsWith('[VERIFICACIÓN RUNTIME]')) {
      sawRuntimePrompt = true;
      assert.match(last.content, /Failed to resolve import|dev server/i);
      // "Fix": advance devStatus so the next dev check is ready, then stop calling tools.
      devStarts += 1;
      return { text: 'Corrijo el import.', toolCalls: [{ name: 'edit_file', args: { path: 'package.json', find: '{}', replace: '{}' } }] };
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
      env: { NODE_ENV: 'test', CODEX_AUTO_VERIFY: '0', CODEX_VERIFY_DEV_SERVER: '1', CODEX_VERIFY_DEV_TIMEOUT_MS: '3000' },
    },
  });
  assert.equal(res.status, 'done');
  assert.equal(sawRuntimePrompt, true, 'el error de runtime vuelve al modelo como [VERIFICACIÓN RUNTIME]');
  const rtActions = events.filter((e) => e.type === 'action_start' && /verificación runtime: dev server/.test(e.data.command || ''));
  assert.ok(rtActions.length >= 1, 'la verificación runtime aparece en la timeline');
});

test('build loop: flag OFF → NO arranca el dev server (startDev nunca se llama)', async () => {
  let startDevCalled = 0;
  const files = new Map([['tsconfig.json', JSON.stringify({ compilerOptions: {} })]]);
  const events = [];
  const runner = {
    readFile: async (_p, path) => { if (!files.has(path)) throw new Error(`no existe ${path}`); return { content: files.get(path) }; },
    writeFiles: async (_p, w) => { for (const f of w) files.set(f.path, f.content); return { ok: true }; },
    exec: async (_p, cmd) => {
      if (cmd[0] === 'bunx' && cmd[1] === 'tsc') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd[0] === 'bun' && cmd[1] === 'install') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd[0] === 'git' && cmd[1] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    devStatus: async () => ({ running: false }),
    startDev: async () => { startDevCalled += 1; return { port: 5173 }; },
    stopDev: async () => ({ ok: true }),
  };
  const res = await runAgentLoop({
    run: { id: 'r1', mode: 'build', prompt: 'haz una app', tier: 'eco' },
    project: { id: 'p1', name: 'X' },
    deps: {
      llmTurn: async () => ({ text: 'Listo.', toolCalls: [] }),
      runner,
      fileTree: '',
      plan: null,
      eventStore: { appendEvent: async (_r, type, data) => { events.push({ type, data }); }, listEvents: async () => [] },
      actionStore: { recordAction: async () => {} },
      clock: (() => { let t = 0; return () => new Date(1_000_000 + (t += 10)); })(),
      // CODEX_VERIFY_DEV_SERVER unset → runtime check must not fire.
      env: { NODE_ENV: 'test', CODEX_AUTO_VERIFY: '0' },
    },
  });
  assert.equal(res.status, 'done');
  assert.equal(startDevCalled, 0, 'con el flag apagado el dev server NO se arranca en la verificación');
  assert.ok(!events.some((e) => e.type === 'action_start' && /verificación runtime/.test(e.data.command || '')), 'sin acción de verificación runtime en la timeline');
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

test('build loop: reescribir el mismo archivo N veces inyecta el aviso anti-bucle', async () => {
  let turnCount = 0;
  let lastTranscript = [];
  const llmTurn = async ({ messages }) => {
    turnCount += 1;
    lastTranscript = messages.map((m) => String(m.content || ''));
    // 3 escrituras consecutivas al mismo path (una por turno) → al 3er result
    // debe aparecer el aviso [LOOP]; luego termina.
    if (turnCount <= 3) {
      return { text: `escribo (${turnCount})`, toolCalls: [{ name: 'write_file', args: { path: 'src/index.css', content: `body{}\n/* ${turnCount} */` } }] };
    }
    return { text: 'listo', toolCalls: [] };
  };
  const nudges = [];
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
    env: { CODEX_MAX_SAME_FILE_WRITES: '3', NODE_ENV: 'test' },
  };
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build', prompt: 'x', tier: 'eco' }, project: { id: 'p1' }, deps: f });
  assert.equal(res.status, 'done');
  const nudge = lastTranscript.find((c) => c.includes('[LOOP]') && c.includes('src/index.css'));
  assert.ok(nudge, 'tras 3 escrituras al mismo archivo, el modelo recibe el aviso anti-bucle');
  assert.match(nudge, /3 veces seguidas/);
});

test('build loop: reescrituras INTERCALADAS del mismo archivo también disparan el aviso', async () => {
  // El smoke en prod mostró cliente.ts escrito 7× intercalado con otros writes,
  // que el contador consecutivo nunca cazaba. El total por archivo sí.
  let turnCount = 0;
  const allMsgs = [];
  const llmTurn = async ({ messages }) => {
    turnCount += 1;
    allMsgs.push(...messages.map((m) => String(m.content || '')));
    if (turnCount <= 11) {
      // Alterna A/B para que NUNCA haya 2 seguidas del mismo path; A (turnos
      // impares) llega a 6 escrituras totales (= 2×umbral) sin ser consecutivas.
      const path = turnCount % 2 === 1 ? 'src/A.tsx' : 'src/B.tsx';
      return { text: `w${turnCount}`, toolCalls: [{ name: 'write_file', args: { path, content: `x${turnCount}` } }] };
    }
    return { text: 'listo', toolCalls: [] };
  };
  const f = {
    llmTurn,
    runner: { readFile: async () => { throw new Error('no'); }, writeFiles: async () => ({ ok: true }), exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    fileTree: '', plan: null,
    eventStore: { appendEvent: async () => {}, listEvents: async () => [] },
    actionStore: { recordAction: async () => {} },
    clock: () => new Date(0),
    env: { CODEX_MAX_SAME_FILE_WRITES: '3', NODE_ENV: 'test' },
  };
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build', prompt: 'x', tier: 'eco' }, project: { id: 'p1' }, deps: f });
  assert.equal(res.status, 'done');
  const nudge = allMsgs.find((c) => c.includes('[LOOP]') && c.includes('src/A.tsx'));
  assert.ok(nudge, 'un archivo reescrito 6× intercalado (2× umbral) recibe el aviso');
  assert.match(nudge, /veces en esta corrida/);
  // Solo una vez por archivo: no debe haber un segundo [LOOP] para A.tsx.
  const nudgesForA = allMsgs.filter((c) => c.includes('[LOOP]') && c.includes('src/A.tsx'));
  assert.equal(nudgesForA.length, 1, 'el aviso se emite una sola vez por archivo');
});

test('run_subagent propaga el tier del run al llmTurn del especialista', async () => {
  const sdk = require('../src/services/codex/agent-sdk');
  const captured = [];
  const llmTurn = async ({ tier }) => {
    captured.push(tier);
    // El especialista no llama herramientas → termina en un paso.
    return { text: 'informe del subagente', toolCalls: [], usage: { tokensIn: 1, tokensOut: 1 } };
  };
  const out = await sdk.runSubagent({
    name: 'frontend_builder',
    task: 'construye la UI',
    deps: {
      llmTurn,
      tier: 'power',
      runner: { readFile: async () => ({ content: '' }), exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
      project: 'p1',
      env: { NODE_ENV: 'test' },
    },
  });
  assert.equal(out.ok, true);
  assert.ok(captured.length >= 1, 'el subagente llamó al llmTurn');
  assert.equal(captured[0], 'power', 'el tier del run llega al especialista (Claude para tiers de pago)');
});
