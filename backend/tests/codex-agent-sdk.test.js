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

test('registry lists the six specialists with tools and budgets', () => {
  const agents = sdk.listSubagents();
  assert.deepEqual(
    agents.map((a) => a.name).sort(),
    ['backend_engineer', 'db_architect', 'enterprise_analyst', 'frontend_builder', 'planner', 'qa_reviewer'],
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
