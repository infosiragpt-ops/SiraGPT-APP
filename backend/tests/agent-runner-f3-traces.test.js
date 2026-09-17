'use strict';

/**
 * F3 — SSE traces + cancel end-to-end.
 *
 * (a) the mocked loop emits stage events in order (Spanish labels + tool);
 * (b) an abort mid-loop stops further LLM/tool calls and traces "Cancelado";
 * (c) the sandbox exec respects the AbortSignal (and the timeout) and a
 *     cancelled run leaves NO leaked process;
 * (d) the BullMQ path propagates the cancel to the worker job.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { toStageEvent, STAGE_LABELS } = require('../src/services/agent-runner/trace');
const { runAgentLoop } = require('../src/services/agent-runner/loop');
const { TOOL_DEFINITIONS, makeToolExecutors } = require('../src/services/agent-runner/tools');
const { runAgentRunner } = require('../src/services/agent-runner');
const { createSandbox } = require('../src/services/doc-agent/sandbox');
const {
  cancelChannel,
  eventChannel,
  requestAgentRunnerJobCancel,
  startAgentRunnerWorker,
  waitForAgentRunnerJob,
} = require('../src/services/agent-runner/queue');

const pexec = promisify(execFile);

function scriptedClient(script, { onCall } = {}) {
  let i = 0;
  const client = {
    calls: 0,
    chat: {
      completions: {
        create: async () => {
          client.calls += 1;
          if (typeof onCall === 'function') onCall(client.calls);
          if (i >= script.length) throw new Error('scripted client exhausted');
          const turn = script[i++];
          if (turn.toolCalls) {
            return {
              choices: [{
                message: {
                  content: turn.content || null,
                  tool_calls: turn.toolCalls.map((c, idx) => ({
                    id: `call_${i}_${idx}`,
                    type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.args) },
                  })),
                },
              }],
            };
          }
          return { choices: [{ message: { content: turn.content } }] };
        },
      },
    },
  };
  return client;
}

/* ── toStageEvent: one canonical stage shape ─────────────────────────────── */

test('toStageEvent maps every loop event to the stage contract (Spanish label + tool)', () => {
  const call = toStageEvent({ type: 'tool_call', tool: 'execute_python', iteration: 2, preview: 'print(1)' });
  assert.deepEqual(call, {
    type: 'stage',
    step: 'tool_call',
    tool: 'execute_python',
    iteration: 2,
    preview: 'print(1)',
    label: 'Ejecutando código',
  });

  assert.equal(toStageEvent({ type: 'tool_call', tool: 'render_preview' }).label, 'Verificando resultado');
  assert.equal(toStageEvent({ type: 'tool_result', tool: 'execute_bash', ok: true }).label, 'Verificando resultado');
  assert.equal(toStageEvent({ type: 'tool_result', tool: 'execute_bash', ok: false }).label, 'Reintentando');
  assert.equal(toStageEvent({ type: 'retry', attempt: 2 }).label, 'Reintentando');
  assert.equal(toStageEvent({ type: 'final' }).label, 'Listo');
  assert.equal(toStageEvent({ type: 'outputs' }).label, 'Listo');
  assert.equal(toStageEvent({ type: 'iteration_start', iteration: 1 }).label, 'Pensando');
  assert.equal(toStageEvent({ type: 'thought', preview: 'voy a pintar' }).label, 'Pensando');
  assert.equal(toStageEvent({ type: 'sandbox_ready', driver: 'local' }).label, 'Preparando entorno');
  assert.equal(toStageEvent({ type: 'cancelled' }).label, 'Cancelado');
  assert.equal(toStageEvent({ type: 'job_cancelled' }).label, 'Cancelado');
  assert.equal(toStageEvent({ type: 'error', message: 'boom' }).preview, 'boom');

  // Existing explicit labels always win over the defaults.
  assert.equal(toStageEvent({ type: 'retry', label: 'Verificando resultado' }).label, 'Verificando resultado');

  // Non-stage events never render as a stage.
  assert.equal(toStageEvent({ type: 'file_artifact', artifact: {} }), null);
  assert.equal(toStageEvent({ type: 'job_done', result: {} }), null);
  assert.equal(toStageEvent({ type: 'output_invalid', name: 'x' }), null);
  assert.equal(toStageEvent({ type: 'mystery_event' }), null);
  assert.equal(toStageEvent(null), null);

  // A default tool name is always present for the UI.
  assert.equal(toStageEvent({ type: 'retry' }).tool, 'agent_runner');
  assert.ok(STAGE_LABELS.executing === 'Ejecutando código');
});

/* ── (a) mocked loop → stage events in order ─────────────────────────────── */

test('F3(a): mocked loop emits stage events in order — Pensando → Ejecutando código → Verificando resultado → Listo', async () => {
  const events = [];
  const client = scriptedClient([
    { toolCalls: [{ name: 'execute_python', args: { code: 'print(1)' } }] },
    { toolCalls: [{ name: 'render_preview', args: { path: 'outputs/a.pptx' } }] },
    { content: 'Listo, verificado.' },
  ]);
  const result = await runAgentLoop({
    client,
    model: 'test/model',
    messages: [{ role: 'user', content: 'hazlo' }],
    tools: TOOL_DEFINITIONS,
    executors: {
      async execute_python() { return '1\n[exit 0]'; },
      async render_preview() { return '{"ok":true,"frames":[{"mean_brightness":240}]}'; },
    },
    maxIterations: 6,
    onEvent: (ev) => events.push(ev),
  });
  assert.equal(result.stoppedReason, 'final');

  const stages = events.map(toStageEvent).filter(Boolean);
  // EVERY tool/stage loop event renders as a stage. Advisory 3H65
  // budget_hint leftovers stay off the stage rail (not a tool trace).
  const toolTraceEvents = events.filter((e) => e && e.type !== 'budget_hint');
  assert.equal(stages.length, toolTraceEvents.length);
  for (const s of stages) {
    assert.equal(s.type, 'stage');
    assert.ok(s.label, 'stage always has a Spanish label');
    assert.ok(s.tool, 'stage always carries a tool name');
  }
  assert.deepEqual(
    stages.map((s) => `${s.step}:${s.label}`),
    [
      'iteration_start:Pensando',
      'tool_call:Ejecutando código',
      'tool_result:Verificando resultado',
      'iteration_start:Pensando',
      'tool_call:Verificando resultado', // render_preview is a verification step
      'tool_result:Verificando resultado',
      'iteration_start:Pensando',
      'final:Listo',
    ],
  );
  assert.equal(stages[1].tool, 'execute_python');
  assert.equal(stages[4].tool, 'render_preview');
});

test('F3(a): a failed tool result traces "Reintentando"', async () => {
  const events = [];
  const client = scriptedClient([
    { toolCalls: [{ name: 'execute_python', args: { code: 'boom' } }] },
    { content: 'No pude.' },
  ]);
  await runAgentLoop({
    client,
    model: 'x',
    messages: [],
    tools: TOOL_DEFINITIONS,
    executors: { async execute_python() { return 'ERROR: python failed'; } },
    maxIterations: 4,
    onEvent: (ev) => events.push(ev),
  });
  const failed = events.map(toStageEvent).filter(Boolean).find((s) => s.step === 'tool_result');
  assert.equal(failed.label, 'Reintentando');
  assert.equal(failed.ok, false);
});

/* ── (b) abort mid-loop ──────────────────────────────────────────────────── */

test('F3(b): abort DURING a tool call stops the loop — no further LLM/tool calls, "Cancelado" traced once', async () => {
  const controller = new AbortController();
  const events = [];
  let toolRuns = 0;
  const client = scriptedClient([
    { toolCalls: [{ name: 'execute_python', args: { code: 'sleep' } }] },
    { toolCalls: [{ name: 'execute_python', args: { code: 'never' } }] },
    { content: 'never' },
  ]);
  await assert.rejects(
    runAgentLoop({
      client,
      model: 'x',
      messages: [],
      tools: TOOL_DEFINITIONS,
      executors: {
        async execute_python() {
          toolRuns += 1;
          controller.abort(); // Stop button pressed mid-command
          return 'partial output';
        },
      },
      maxIterations: 6,
      signal: controller.signal,
      onEvent: (ev) => events.push(ev),
    }),
    (err) => /abort/i.test(String(err?.name)) || /abort/i.test(String(err?.message)),
  );
  assert.equal(client.calls, 1, 'no LLM call after the abort');
  assert.equal(toolRuns, 1, 'no tool call after the abort');
  const cancelled = events.filter((e) => e.type === 'cancelled');
  assert.equal(cancelled.length, 1, 'exactly one cancelled trace');
  assert.equal(toStageEvent(cancelled[0]).label, 'Cancelado');
});

test('F3(b): abort BETWEEN iterations stops before the next LLM call', async () => {
  const controller = new AbortController();
  const events = [];
  const client = scriptedClient([
    { toolCalls: [{ name: 'list_files', args: { path: '.' } }] },
    { content: 'never reached' },
  ]);
  await assert.rejects(
    runAgentLoop({
      client,
      model: 'x',
      messages: [],
      tools: TOOL_DEFINITIONS,
      executors: { async list_files() { return '(no files)'; } },
      maxIterations: 6,
      signal: controller.signal,
      onEvent: (ev) => {
        events.push(ev);
        // Stop arrives right after the first tool result is streamed.
        if (ev.type === 'tool_result') controller.abort();
      },
    }),
    (err) => /abort/i.test(String(err?.name)) || /abort/i.test(String(err?.message)),
  );
  assert.equal(client.calls, 1, 'second LLM call never happens');
  assert.equal(events.filter((e) => e.type === 'cancelled').length, 1);
});

/* ── (c) sandbox exec respects signal + timeout; cancel leaves it clean ──── */

test('F3(c): local sandbox exec is killed by the AbortSignal (not the timeout)', async () => {
  const sandbox = await createSandbox({ driver: 'local' });
  try {
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 100);
    const r = await sandbox.exec('sleep 5', { timeoutMs: 10_000, signal: controller.signal });
    assert.equal(r.aborted, true);
    assert.equal(r.timedOut, false);
    assert.equal(r.exitCode, 130);
    assert.ok(Date.now() - startedAt < 2_500, 'killed by abort, not by timeout');
  } finally {
    await sandbox.destroy();
  }
});

test('F3(c): local sandbox exec still respects the timeout', async () => {
  const sandbox = await createSandbox({ driver: 'local' });
  try {
    const r = await sandbox.exec('sleep 5', { timeoutMs: 1_000 });
    assert.equal(r.timedOut, true);
    assert.equal(r.aborted, false);
  } finally {
    await sandbox.destroy();
  }
});

test('F3(c): execute_bash forwards the per-call signal and reports the abort honestly', async () => {
  const sandbox = await createSandbox({ driver: 'local' });
  try {
    const executors = makeToolExecutors(sandbox);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const out = await executors.execute_bash({ command: 'sleep 5' }, { signal: controller.signal });
    assert.ok(String(out).startsWith('ERROR: sandbox command aborted'), out);
  } finally {
    await sandbox.destroy();
  }
});

test('F3(c): cancelling runAgentRunner mid-command leaves NO leaked sandbox process', async () => {
  // A unique sleep DURATION acts as the marker: `sleep <marker>` shows up in
  // the args of the leaf process itself (a bash comment would only tag the
  // wrapper, not the child that could leak).
  const marker = `${3000 + (process.pid % 900)}.${Date.now() % 97}`;
  const controller = new AbortController();
  const events = [];
  const client = scriptedClient([
    { toolCalls: [{ name: 'execute_bash', args: { command: `sleep ${marker}` } }] },
    { content: 'never' },
  ]);
  const startedAt = Date.now();
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(
    runAgentRunner({
      files: [],
      instruction: 'edita el archivo y espera', // claimed work turn
      client,
      model: 'test',
      driver: 'local',
      maxIterations: 4,
      signal: controller.signal,
      onEvent: (ev) => events.push(ev),
    }),
    (err) => /abort/i.test(String(err?.name)) || /abort/i.test(String(err?.message)),
  );
  assert.ok(Date.now() - startedAt < 5_000, 'cancel unwinds quickly');
  assert.equal(events.filter((e) => e.type === 'cancelled').length, 1, 'one Cancelado trace');

  // The sleep process (and its whole process group) must be gone: no leaks.
  const { stdout } = await pexec('ps', ['-eo', 'args']).catch(() => ({ stdout: '' }));
  const leaked = String(stdout)
    .split('\n')
    .filter((l) => l.includes(`sleep ${marker}`) && !l.includes('ps -eo'));
  assert.deepEqual(leaked, [], `sandbox process leaked after cancel: ${leaked.join(' | ')}`);
});

/* ── (d) BullMQ cancel propagation ───────────────────────────────────────── */

test('F3(d): cancel channel + requestAgentRunnerJobCancel publish contract', async () => {
  assert.equal(cancelChannel('7'), 'agent-runner:cancel:7');
  assert.equal(eventChannel('7'), 'agent-runner:events:7');
  const published = [];
  const ok = await requestAgentRunnerJobCancel({
    jobId: '7',
    publish: async (ch, payload) => published.push({ ch, payload }),
  });
  assert.equal(ok, true);
  assert.equal(published[0].ch, 'agent-runner:cancel:7');
  assert.equal(JSON.parse(published[0].payload).type, 'cancel');
  assert.equal(await requestAgentRunnerJobCancel({ jobId: null }), false);
  // A dead connection is best-effort, never a throw.
  assert.equal(await requestAgentRunnerJobCancel({
    jobId: '9',
    connection: { publish: async () => { throw new Error('redis down'); } },
  }), false);
});

test('F3(d): worker aborts the running job when the cancel message arrives', async () => {
  const published = [];
  const cancelFns = new Map();
  let processor;
  class FakeWorker {
    constructor(_name, fn) { processor = fn; }
  }
  startAgentRunnerWorker({
    WorkerImpl: FakeWorker,
    connection: {},
    publish: async (ch, ev) => published.push({ ch, ev }),
    subscribeCancel: (jobId, onCancel) => {
      cancelFns.set(jobId, onCancel);
      return () => cancelFns.delete(jobId);
    },
    // The runner honours the signal like the real loop does.
    run: async ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('operation_aborted'), { name: 'AbortError' }));
      }, { once: true });
    }),
  });

  const jobPromise = processor({ id: '42', data: { instruction: 'x' } });
  // Give the worker a tick to install the cancel listener, then cancel.
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(cancelFns.has('42'), 'worker subscribed to the cancel channel');
  cancelFns.get('42')();

  await assert.rejects(jobPromise, (err) => err?.name === 'AbortError');
  assert.ok(published.some((p) => p.ev.type === 'job_cancelled'), 'job_cancelled published');
  assert.ok(!published.some((p) => p.ev.type === 'job_done'), 'no success claim after cancel');
  assert.ok(!published.some((p) => p.ev.type === 'job_error'), 'cancel is not an error');
  assert.equal(cancelFns.has('42'), false, 'cancel subscription cleaned up');
});

test('F3(d): waitForAgentRunnerJob abort propagates the cancel to the worker', async () => {
  const publishes = [];
  const sub = {
    handlers: new Map(),
    subscribe(_ch, cb) { if (cb) cb(null); },
    on(ev, fn) { this.handlers.set(ev, fn); },
    disconnect() {},
  };
  const connection = {
    duplicate: () => sub,
    publish: async (ch, payload) => publishes.push({ ch, payload }),
  };
  const controller = new AbortController();
  const wait = waitForAgentRunnerJob({
    jobId: '55',
    connection,
    signal: controller.signal,
    timeoutMs: 5_000,
  });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(wait, (err) => err?.name === 'AbortError');
  // The Stop must reach the worker, not just drop the local wait.
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(
    publishes.some((p) => p.ch === cancelChannel('55')),
    'cancel published on the job cancel channel',
  );
});

test('F3(d): waitForAgentRunnerJob treats job_cancelled as an abort, not a success', async () => {
  const sub = {
    handlers: new Map(),
    subscribe(_ch, cb) { if (cb) cb(null); },
    on(ev, fn) { this.handlers.set(ev, fn); },
    disconnect() {},
  };
  const connection = { duplicate: () => sub, publish: async () => {} };
  const events = [];
  const wait = waitForAgentRunnerJob({
    jobId: '56',
    connection,
    onEvent: (ev) => events.push(ev),
    timeoutMs: 5_000,
  });
  setTimeout(() => {
    sub.handlers.get('message')(eventChannel('56'), JSON.stringify({ type: 'cancelled', label: 'Cancelado' }));
    sub.handlers.get('message')(eventChannel('56'), JSON.stringify({ type: 'job_cancelled', label: 'Cancelado' }));
  }, 20);
  await assert.rejects(wait, (err) => err?.name === 'AbortError');
  assert.ok(events.some((e) => e.type === 'cancelled'), 'the Cancelado trace reached the UI side');
});

/* ── chat stream keeps the `type: 'stage'` contract via the normalizer ───── */

test('F3: agentic-chat-stream forwards runner events through the trace normalizer', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'agentic-chat-stream.js'),
    'utf8',
  );
  assert.ok(
    src.includes("require('./agent-runner/trace').toStageEvent"),
    'chat stream must normalize runner events with toStageEvent',
  );
});
