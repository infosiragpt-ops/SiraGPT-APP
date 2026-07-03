'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sdk = require('../src/services/codex/agent-sdk');
const { TOOLS } = require('../src/services/codex/build-tools');

function fakeRunner(overrides = {}) {
  return {
    exec: async () => ({ exitCode: 0, stdout: 'src/App.tsx\npackage.json', stderr: '' }),
    readFile: async () => ({ content: 'export default function App() { return null }' }),
    writeFiles: async () => ({ ok: true }),
    devStatus: async () => ({ running: true, ready: true, tail: [] }),
    startDev: async () => ({ ok: true }),
    ...overrides,
  };
}

/** llmTurn scripted per step. */
function scriptedLlm(steps) {
  let i = 0;
  const seen = [];
  const fn = async ({ messages, tools }) => {
    seen.push({ messages, tools });
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return { text: step.text || '', toolCalls: step.toolCalls || [], usage: step.usage || null, reasoning: null };
  };
  fn.seen = seen;
  return fn;
}

test('registry lists the seven specialists with tools and budgets', () => {
  const agents = sdk.listSubagents();
  assert.deepEqual(
    agents.map((a) => a.name).sort(),
    ['backend_engineer', 'db_architect', 'debugger', 'enterprise_analyst', 'frontend_builder', 'planner', 'qa_reviewer'],
  );
  for (const a of agents) {
    assert.ok(a.description.length > 20);
    assert.ok(a.tools.length > 0);
    assert.ok(a.maxSteps > 0);
  }
});

test('subagents never expose run_subagent (no recursive delegation)', () => {
  for (const a of sdk.listSubagents()) assert.ok(!a.tools.includes('run_subagent'), a.name);
});

test('unknown agent and empty task fail without throwing', async () => {
  const bad = await sdk.runSubagent({ name: 'nope', task: 'x', deps: {} });
  assert.equal(bad.ok, false);
  assert.match(bad.result, /desconocido/i);
  const empty = await sdk.runSubagent({ name: 'planner', task: '  ', deps: {} });
  assert.equal(empty.ok, false);
});

test('runSubagent: tool loop until the model stops calling tools', async () => {
  const llmTurn = scriptedLlm([
    { toolCalls: [{ id: 't1', name: 'list_files', args: {} }] },
    { text: 'Plan: crear src/pages con 3 vistas.' },
  ]);
  const out = await sdk.runSubagent({
    name: 'planner',
    task: 'Planea un CRM',
    deps: { llmTurn, runner: fakeRunner(), project: 'p1', env: { NODE_ENV: 'test' } },
  });
  assert.equal(out.ok, true);
  assert.equal(out.result, 'Plan: crear src/pages con 3 vistas.');
  assert.equal(out.toolCallsCount, 1);
  assert.equal(out.actions[0].tool, 'list_files');
  // The specialist saw ONLY its own restricted tool registry.
  const toolNames = llmTurn.seen[0].tools.map((t) => t.name).sort();
  assert.deepEqual(toolNames, ['list_files', 'read_file', 'web_search']);
});

test('runSubagent: a tool outside the specialist set is rejected but fed back', async () => {
  const llmTurn = scriptedLlm([
    { toolCalls: [{ id: 't1', name: 'write_file', args: { path: 'x', content: 'y' } }] },
    { text: 'listo' },
  ]);
  const out = await sdk.runSubagent({
    name: 'planner', // planner has no write_file
    task: 'Planea algo',
    deps: { llmTurn, runner: fakeRunner(), project: 'p1', env: { NODE_ENV: 'test' } },
  });
  assert.equal(out.ok, true);
  assert.equal(out.toolCallsCount, 0);
  const fedBack = llmTurn.seen[1].messages.find((m) => /herramienta no disponible/.test(m.content || ''));
  assert.ok(fedBack);
});

test('runSubagent: budget exhaustion still returns honestly', async () => {
  const llmTurn = scriptedLlm([{ toolCalls: [{ id: 't', name: 'list_files', args: {} }] }]);
  const out = await sdk.runSubagent({
    name: 'planner',
    task: 'loop forever',
    deps: { llmTurn, runner: fakeRunner(), project: 'p1', env: { NODE_ENV: 'test', CODEX_SUBAGENT_MAX_STEPS: '2' } },
  });
  assert.equal(out.ok, true);
  assert.equal(out.steps, 2);
  assert.match(out.result, /presupuesto|acciones/i);
});

test('runSubagent: an llmTurn transport error fails the delegation cleanly', async () => {
  const out = await sdk.runSubagent({
    name: 'qa_reviewer',
    task: 'revisa',
    deps: { llmTurn: async () => { throw new Error('provider down'); }, runner: fakeRunner(), project: 'p1', env: { NODE_ENV: 'test' } },
  });
  assert.equal(out.ok, false);
  assert.match(out.result, /provider down/);
});

test('onUsage bubbles usage to the caller (metrics)', async () => {
  const usages = [];
  const llmTurn = scriptedLlm([
    { toolCalls: [{ id: 't', name: 'list_files', args: {} }], usage: { tokensIn: 5, tokensOut: 2 } },
    { text: 'fin', usage: { tokensIn: 3, tokensOut: 1 } },
  ]);
  await sdk.runSubagent({
    name: 'planner',
    task: 'plan',
    deps: { llmTurn, runner: fakeRunner(), project: 'p1', env: { NODE_ENV: 'test' }, onUsage: (u) => usages.push(u) },
  });
  assert.equal(usages.length, 2);
});

test('formatSubagentReport is compact and model-facing', () => {
  const report = sdk.formatSubagentReport({ ok: true, agent: 'planner', result: 'Plan listo', steps: 2, toolCallsCount: 1, actions: [{ tool: 'list_files', ok: true, summary: 'src listado' }] });
  assert.match(report, /\[SUBAGENTE planner\] completado/);
  assert.match(report, /✓ list_files/);
  assert.match(report, /Plan listo/);
});

test('run_subagent build-tool delegates through the SDK end-to-end', async () => {
  const llmTurn = scriptedLlm([{ text: 'Especificación enterprise: módulos A, B.' }]);
  const r = await TOOLS.run_subagent.execute(
    { agent: 'enterprise_analyst', task: 'CRM para distribuidora' },
    { runner: fakeRunner(), project: 'p1', env: { NODE_ENV: 'test' }, llmTurn },
  );
  assert.equal(r.isError, false);
  assert.match(r.observation, /\[SUBAGENTE enterprise_analyst\] completado/);
  assert.match(r.observation, /Especificación enterprise/);
});

test('run_subagent surfaces an unknown specialist as a tool error', async () => {
  const r = await TOOLS.run_subagent.execute(
    { agent: 'ghost', task: 'x' },
    { runner: fakeRunner(), project: 'p1', env: { NODE_ENV: 'test' }, llmTurn: scriptedLlm([{ text: 'n/a' }]) },
  );
  assert.equal(r.isError, true);
  assert.match(r.observation, /desconocido/i);
});

test('enterprise_analyst prompt covers the enterprise spec dimensions', () => {
  const def = sdk.getSubagent('enterprise_analyst');
  for (const needle of ['módulos', 'entidades', 'roles', 'flujos', 'KPI']) {
    assert.match(def.systemPrompt, new RegExp(needle, 'i'));
  }
});

// --- v2: contexto automático, visibilidad, agentes custom, métricas ---------

test('the specialist gets a fresh file tree without spending a step', async () => {
  const llmTurn = scriptedLlm([{ text: 'listo' }]);
  const runner = fakeRunner({ exec: async (_p, cmd) => {
    assert.deepEqual(cmd, ['git', 'ls-files', '--cached', '--others', '--exclude-standard']);
    return { exitCode: 0, stdout: 'src/App.tsx\nsrc/lib/store.ts', stderr: '' };
  } });
  await sdk.runSubagent({ name: 'planner', task: 'planea', deps: { llmTurn, runner, project: 'p1', env: { NODE_ENV: 'test' } } });
  assert.match(llmTurn.seen[0].messages[1].content, /Archivos actuales del workspace:[\s\S]*src\/lib\/store\.ts/);
});

test('emitAction surfaces every specialist tool call live (start + end)', async () => {
  const emitted = [];
  const emitAction = async (meta) => {
    emitted.push({ phase: 'start', ...meta });
    return { end: async (endMeta) => { emitted.push({ phase: 'end', ...endMeta }); } };
  };
  const llmTurn = scriptedLlm([
    { toolCalls: [{ id: 't1', name: 'list_files', args: {} }] },
    { text: 'fin' },
  ]);
  await sdk.runSubagent({
    name: 'planner',
    task: 'plan',
    deps: { llmTurn, runner: fakeRunner(), project: 'p1', env: { NODE_ENV: 'test' }, emitAction },
  });
  assert.equal(emitted.length, 2);
  assert.equal(emitted[0].phase, 'start');
  assert.match(emitted[0].command, /↳ planner · /);
  assert.equal(emitted[1].phase, 'end');
  assert.equal(emitted[1].status, 'done');
});

test('a crashing emitAction never breaks the delegation', async () => {
  const llmTurn = scriptedLlm([
    { toolCalls: [{ id: 't1', name: 'list_files', args: {} }] },
    { text: 'fin' },
  ]);
  const out = await sdk.runSubagent({
    name: 'planner',
    task: 'plan',
    deps: { llmTurn, runner: fakeRunner(), project: 'p1', env: { NODE_ENV: 'test' }, emitAction: async () => { throw new Error('ui down'); } },
  });
  assert.equal(out.ok, true);
  assert.equal(out.toolCallsCount, 1);
});

test('outcome reports duration and accumulated tokens; the report shows them', async () => {
  let t = 1000;
  const llmTurn = scriptedLlm([
    { toolCalls: [{ id: 't', name: 'list_files', args: {} }], usage: { tokensIn: 100, tokensOut: 20 } },
    { text: 'fin', usage: { tokensIn: 50, tokensOut: 10 } },
  ]);
  const out = await sdk.runSubagent({
    name: 'planner',
    task: 'plan',
    deps: { llmTurn, runner: fakeRunner(), project: 'p1', env: { NODE_ENV: 'test' }, now: () => { t += 500; return t; } },
  });
  assert.equal(out.tokensIn, 150);
  assert.equal(out.tokensOut, 30);
  assert.ok(out.durationMs > 0);
  assert.match(sdk.formatSubagentReport(out), /180 tokens/);
});

test('validateCustomAgent: accepts a sane definition and clamps budgets', () => {
  const { def, reason } = sdk.validateCustomAgent({
    name: 'invoice_expert',
    description: 'Experto en facturación peruana',
    prompt: 'Sabes todo de facturación electrónica SUNAT.',
    tools: ['read_file', 'write_file', 'run_subagent', 'no_such_tool'],
    maxSteps: 99,
  });
  assert.equal(reason, null);
  assert.deepEqual(def.tools, ['read_file', 'write_file']); // run_subagent + unknown filtered
  assert.equal(def.maxSteps, 12); // clamped to the cap
  assert.equal(def.custom, true);
  assert.match(def.systemPrompt, /INVOICE_EXPERT/);
  assert.match(def.systemPrompt, /SUNAT/);
});

test('validateCustomAgent: rejects bad names, collisions and empty prompts', () => {
  assert.ok(sdk.validateCustomAgent({ name: 'Bad Name!', prompt: 'x' }).reason);
  assert.ok(sdk.validateCustomAgent({ name: 'planner', prompt: 'x' }).reason);
  assert.ok(sdk.validateCustomAgent({ name: 'ok_name', prompt: '' }).reason);
  assert.ok(sdk.validateCustomAgent(null).reason);
});

test('loadWorkspaceAgents: reads .sira/agents.json, tolerates garbage', async () => {
  const good = JSON.stringify([
    { name: 'invoice_expert', prompt: 'facturación', tools: ['read_file'] },
    { name: 'BAD NAME', prompt: 'x' },
  ]);
  const runner = fakeRunner({ readFile: async (_p, path) => {
    assert.equal(path, sdk.CUSTOM_AGENTS_PATH);
    return { content: good };
  } });
  const agents = await sdk.loadWorkspaceAgents({ runner, project: 'p1' });
  assert.deepEqual(Object.keys(agents), ['invoice_expert']);

  const missing = await sdk.loadWorkspaceAgents({ runner: fakeRunner({ readFile: async () => { throw new Error('nope'); } }), project: 'p1' });
  assert.deepEqual(missing, {});
  const garbage = await sdk.loadWorkspaceAgents({ runner: fakeRunner({ readFile: async () => ({ content: '{not json' }) }), project: 'p1' });
  assert.deepEqual(garbage, {});
});

test('runSubagent resolves a workspace custom agent and restricts it to its tools', async () => {
  const llmTurn = scriptedLlm([
    { toolCalls: [{ id: 't1', name: 'write_file', args: { path: 'x.ts', content: 'y' } }] }, // not in its tools
    { text: 'informe custom' },
  ]);
  const { def } = sdk.validateCustomAgent({ name: 'auditor_fiscal', prompt: 'auditas impuestos', tools: ['read_file'] });
  const out = await sdk.runSubagent({
    name: 'auditor_fiscal',
    task: 'audita',
    deps: { llmTurn, runner: fakeRunner(), project: 'p1', env: { NODE_ENV: 'test' }, customAgents: { auditor_fiscal: def } },
  });
  assert.equal(out.ok, true);
  assert.equal(out.result, 'informe custom');
  assert.equal(out.toolCallsCount, 0); // write_file rejected
  assert.deepEqual(llmTurn.seen[0].tools.map((tl) => tl.name), ['read_file']);
});

test('unknown agent message lists custom agents too', async () => {
  const { def } = sdk.validateCustomAgent({ name: 'custom_x', prompt: 'x' });
  const out = await sdk.runSubagent({ name: 'ghost', task: 'x', deps: { customAgents: { custom_x: def } } });
  assert.equal(out.ok, false);
  assert.match(out.result, /custom_x/);
});

test('debugger specialist has the diagnose-and-fix toolset and method prompt', () => {
  const def = sdk.getSubagent('debugger');
  for (const t of ['grep_search', 'type_check', 'dev_server_check', 'edit_file']) assert.ok(def.tools.includes(t), t);
  assert.match(def.systemPrompt, /causa raíz/i);
  assert.match(def.systemPrompt, /@ts-ignore/);
});
