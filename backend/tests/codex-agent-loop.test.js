'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runAgentLoop } = require('../src/services/codex/agent-loop');

// Scripted llmTurn: shift the next response off a queue.
function scriptedLlm(turns) {
  const q = turns.slice();
  return async () => (q.length ? q.shift() : { text: 'fin', toolCalls: [] });
}

function fakeDeps(overrides = {}) {
  const events = [];
  const actions = [];
  const writes = [];
  const runner = {
    exec: async (_p, cmd) => ({ exitCode: 0, stdout: `ran ${cmd.join(' ')}`, stderr: '' }),
    readFile: async () => ({ content: 'a\nb\nc' }),
    writeFiles: async (_p, files) => { writes.push(...files); return { ok: true }; },
  };
  let t = 0;
  const clock = () => new Date(1_000_000 + (t += 10));
  const eventStore = { appendEvent: async (runId, type, data) => { events.push({ type, data }); }, listEvents: async () => [] };
  const actionStore = { recordAction: async (a) => { actions.push(a); } };
  return { events, actions, writes, deps: { eventStore, actionStore, runner, clock, fileTree: '', plan: { architecture: 'x', pages: [], components: [], tasks: [] }, ...overrides } };
}

test('plan mode delegates and ends waiting_approval with plan_proposed', async () => {
  const f = fakeDeps({ llmTurn: scriptedLlm([{ text: JSON.stringify({ architecture: 'Vite', pages: ['/'], components: ['Nav'], tasks: [{ id: 't1', title: 'x' }] }) }]) });
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'plan', prompt: 'landing' }, project: { id: 'p1', name: 'X' }, deps: f.deps });
  assert.equal(res.status, 'waiting_approval');
  assert.equal(f.events[0].type, 'plan_proposed');
  assert.equal(f.writes.length, 0); // plan mode never mutates
});

test('build loop runs grouped tool calls with one groupId, narrative, then done', async () => {
  const f = fakeDeps({
    llmTurn: scriptedLlm([
      { text: 'Voy a crear el index y revisar git.', toolCalls: [
        { name: 'write_file', args: { path: 'index.html', content: '<h1>hi</h1>' } },
        { name: 'run_command', args: { cmd: ['git', 'status'] } },
      ] },
      { text: 'Listo, el proyecto quedó construido.', toolCalls: [] },
    ]),
  });
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build', prompt: 'haz algo' }, project: { id: 'p1', name: 'X' }, deps: f.deps });
  assert.equal(res.status, 'done');
  assert.deepEqual(f.writes, [{ path: 'index.html', content: '<h1>hi</h1>' }]);

  const starts = f.events.filter((e) => e.type === 'action_start');
  assert.equal(starts.length, 2);
  assert.equal(starts[0].data.groupId, starts[1].data.groupId); // same burst → one group
  assert.equal(starts[0].data.kind, 'file_write');
  assert.equal(starts[1].data.kind, 'terminal');
  assert.equal(f.events.filter((e) => e.type === 'action_end').length, 2);
  assert.ok(f.events.some((e) => e.type === 'narrative_delta'));
  assert.equal(f.actions.length, 2); // both persisted as CodexAction
});

test('a tool error does NOT abort the loop; the error is fed back to the model', async () => {
  const f = fakeDeps({
    runner: {
      exec: async () => ({ exitCode: 1, stdout: '', stderr: 'fatal: not a git repo' }),
      readFile: async () => ({ content: '' }),
      writeFiles: async () => ({}),
    },
    llmTurn: scriptedLlm([
      { text: 'Reviso el estado.', toolCalls: [{ name: 'run_command', args: { cmd: ['git', 'status'] } }] },
      { text: 'Entiendo, continúo.', toolCalls: [] },
    ]),
  });
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build' }, project: { id: 'p1' }, deps: f.deps });
  assert.equal(res.status, 'done');
  const end = f.events.find((e) => e.type === 'action_end');
  assert.equal(end.data.status, 'error'); // recorded as error, loop kept going
});

test('cancellation between steps returns cancelled', async () => {
  const f = fakeDeps({ llmTurn: scriptedLlm([{ text: 'paso 1', toolCalls: [{ name: 'run_command', args: { cmd: ['ls'] } }] }]) });
  let calls = 0;
  const isCancelled = async () => (++calls >= 2); // cancelled before the 2nd step
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build' }, project: { id: 'p1' }, isCancelled, deps: f.deps });
  assert.equal(res.status, 'cancelled');
});

test('step budget exhaustion closes as done with an honest closing narrative', async () => {
  // Always returns a tool call → never naturally stops → hits CODEX_MAX_STEPS.
  const f = fakeDeps({
    llmTurn: async () => ({ text: 'sigo', toolCalls: [{ name: 'run_command', args: { cmd: ['ls'] } }] }),
    env: { CODEX_MAX_STEPS: '3' },
  });
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build' }, project: { id: 'p1' }, deps: f.deps });
  assert.equal(res.status, 'done');
  const lastNarr = f.events.filter((e) => e.type === 'narrative_delta').at(-1);
  assert.match(lastNarr.data.text, /límite de pasos/i);
});

test('LLM transport error in build → run error', async () => {
  const f = fakeDeps({ llmTurn: async () => { throw new Error('402 Insufficient credits'); } });
  const res = await runAgentLoop({ run: { id: 'r1', mode: 'build' }, project: { id: 'p1' }, deps: f.deps });
  assert.equal(res.status, 'error');
  assert.match(res.error, /402/);
});

test('metrics hooks receive usage, actions and lines read', async () => {
  const rec = { usage: [], actions: [], lines: 0 };
  const metrics = {
    recordLlmUsage: (u) => rec.usage.push(u),
    recordAction: (k) => rec.actions.push(k),
    recordLinesRead: (n) => { rec.lines += n; },
  };
  const f = fakeDeps({
    metrics,
    llmTurn: scriptedLlm([
      { text: 'leo', toolCalls: [{ name: 'read_file', args: { path: 'a.js' } }], usage: { tokensIn: 5, tokensOut: 7, provider: 'Cerebras', model: 'm' } },
      { text: 'fin', toolCalls: [] },
    ]),
  });
  await runAgentLoop({ run: { id: 'r1', mode: 'build' }, project: { id: 'p1' }, deps: f.deps });
  assert.equal(rec.usage.length, 1);
  assert.deepEqual(rec.actions, ['file_read']);
  assert.equal(rec.lines, 3);
});
