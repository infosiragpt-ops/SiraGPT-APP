'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const swarm = require('../src/services/codex/proactive-swarm');

function fakeRunner() {
  return {
    exec: async () => ({ exitCode: 0, stdout: 'src/App.tsx', stderr: '' }),
    readFile: async () => ({ content: 'export default function App() {}' }),
  };
}

test('selectSpecialists accepts only read-only built-ins and respects the cap', () => {
  const selected = swarm.selectSpecialists({
    swarm: [
      { agent: 'explorer', task: 'Mapea el repo' },
      { agent: 'frontend_builder', task: 'Escribe la UI' },
      { agent: 'market_researcher', task: 'Investiga competidores' },
      { agent: 'qa_reviewer', task: 'Revisa calidad' },
    ],
  }, { CODEX_PROACTIVE_SWARM_MAX: '2' });
  assert.deepEqual(selected.map((item) => item.agent), ['explorer', 'market_researcher']);
});

test('read-only specialists execute concurrently and produce one consolidated report', async () => {
  let active = 0;
  let peak = 0;
  const events = [];
  const llmTurn = async ({ messages }) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return {
      text: `Informe: ${String(messages[1].content).slice(0, 30)}`,
      toolCalls: [],
      usage: { tokensIn: 2, tokensOut: 1 },
    };
  };
  const result = await swarm.runProactiveSwarm({
    meta: {
      swarm: [
        { agent: 'explorer', task: 'Mapea el repositorio' },
        { agent: 'market_researcher', task: 'Investiga el mercado' },
        { agent: 'sales_strategist', task: 'Define el ICP' },
      ],
    },
    task: 'Construye el siguiente incremento.',
    deps: {
      runner: fakeRunner(),
      project: 'p1',
      llmTurn,
      env: { NODE_ENV: 'test', CODEX_PROACTIVE_SWARM_MAX: '3' },
      emitAgent: async ({ agent }) => {
        events.push(`start:${agent}`);
        return { end: async ({ status }) => events.push(`end:${agent}:${status}`) };
      },
    },
  });
  assert.equal(result.requested, 3);
  assert.equal(result.completed, 3);
  assert.ok(peak >= 2, 'specialists should overlap instead of running serially');
  assert.match(result.text, /SWARM DE ESPECIALISTAS/);
  assert.equal(events.filter((value) => value.startsWith('start:')).length, 3);
  assert.equal(events.filter((value) => value.startsWith('end:')).length, 3);
});

test('explicit zero disables the swarm without invoking the model', async () => {
  const result = await swarm.runProactiveSwarm({
    meta: { swarm: [{ agent: 'explorer', task: 'Mapea' }] },
    task: 'x',
    deps: {
      env: { CODEX_PROACTIVE_SWARM_MAX: '0' },
      llmTurn: async () => { throw new Error('must not run'); },
    },
  });
  assert.equal(result.requested, 0);
  assert.equal(result.text, '');
});
