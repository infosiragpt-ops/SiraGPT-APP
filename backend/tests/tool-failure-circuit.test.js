'use strict';

/**
 * Session/tool budget circuit breaker — 25+ node:test cases with fake timers.
 * Native rewrite coverage. No OpenClaw runtime or vendor strings.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const circuitMod = require('../src/services/agents/tool-failure-circuit');
const {
  createToolFailureCircuit,
  attachToolFailureCircuit,
  presentCircuitDenial,
  circuitSessionKeyOf,
  CIRCUIT_CODE,
  CIRCUIT_LABELS,
  DEFAULT_TOOL_THRESHOLD,
  DEFAULT_SESSION_THRESHOLD,
  DEFAULT_COOLDOWN_MS,
} = circuitMod;

const reactAgent = require('../src/services/react-agent');
const { presentTaskError } = require('../src/utils/task-error-classifier');

const VENDOR_LEAK = /openclaw|openrouter|deepseek|sk-|Bearer|AKIA|BEGIN /i;

function failTimes(circuit, session, tool, n, extra = {}) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(circuit.record(session, tool, { ok: false, ...extra }));
  return out;
}

function makeScriptedOpenAI(script) {
  let i = 0;
  let callId = 0;
  return {
    chat: {
      completions: {
        create: async (params) => {
          const forcedFinalize =
            params.tool_choice
            && typeof params.tool_choice === 'object'
            && params.tool_choice.function?.name === 'finalize';
          const entry = forcedFinalize
            ? { finalize: 'Forced final answer.' }
            : (script[i] || { finalize: 'Default final answer.' });
          i += 1;
          callId += 1;
          const toolCall = entry.finalize != null
            ? {
                id: `call_${callId}`,
                type: 'function',
                function: { name: 'finalize', arguments: JSON.stringify({ answer: entry.finalize }) },
              }
            : {
                id: `call_${callId}`,
                type: 'function',
                function: { name: entry.tool, arguments: JSON.stringify(entry.args || {}) },
              };
          return {
            choices: [{ message: { role: 'assistant', content: entry.thought || 'thinking', tool_calls: [toolCall] } }],
          };
        },
      },
    },
  };
}

test('defaults stay fail-closed and expose Spanish labels', () => {
  const c = createToolFailureCircuit();
  assert.equal(c.toolThreshold, DEFAULT_TOOL_THRESHOLD);
  assert.equal(c.sessionThreshold, DEFAULT_SESSION_THRESHOLD);
  assert.equal(c.cooldownMs, DEFAULT_COOLDOWN_MS);
  for (const label of Object.values(CIRCUIT_LABELS)) {
    assert.match(label, /[áéíóúñ¿]|circuito|presupuesto|fallos|herramienta|sesión|sesion|prueba|enfríe|enfri/i);
    assert.equal(VENDOR_LEAK.test(label), false);
  }
  assert.equal(CIRCUIT_CODE, 'E_TIMEOUT');
});

test('missing session key fails closed with Spanish label', () => {
  const c = createToolFailureCircuit();
  const gate = c.authorize('', 'web_search');
  assert.equal(gate.allowed, false);
  assert.equal(gate.code, CIRCUIT_CODE);
  assert.match(gate.label, /sesión|sesion|presupuesto/i);
});

test('empty tool name fails closed as E_PARAMS Spanish', () => {
  const c = createToolFailureCircuit();
  const gate = c.authorize('s1', '  ');
  assert.equal(gate.allowed, false);
  assert.match(gate.label, /Faltan datos/);
});

test('finalize is always allowed even when the session is open', () => {
  const c = createToolFailureCircuit({ sessionThreshold: 2 });
  failTimes(c, 's1', 'web_search', 2);
  assert.equal(c.authorize('s1', 'web_search').allowed, false);
  assert.equal(c.authorize('s1', 'finalize').allowed, true);
});

test('first failure stays closed', () => {
  const c = createToolFailureCircuit({ toolThreshold: 5 });
  const rec = c.record('s1', 'web_search', { ok: false });
  assert.equal(rec.opened, false);
  assert.equal(rec.state, 'closed');
  assert.equal(c.authorize('s1', 'web_search').allowed, true);
});

test('warning band at half the tool threshold', () => {
  const c = createToolFailureCircuit({ toolThreshold: 4, sessionThreshold: 20 });
  const rec = failTimes(c, 's1', 'web_search', 2).at(-1);
  assert.equal(rec.opened, false);
  assert.equal(rec.state, 'warning');
  assert.match(rec.label, /fallando|consecutivos/i);
  assert.equal(c.authorize('s1', 'web_search').allowed, true);
});

test('critical band near the tool threshold', () => {
  const c = createToolFailureCircuit({ toolThreshold: 4, sessionThreshold: 20 });
  failTimes(c, 's1', 'web_search', 3);
  const snap = c.snapshot('s1');
  assert.equal(snap.tools.web_search.state, 'critical');
});

test('tool circuit opens at the tool threshold and denies later calls', () => {
  const c = createToolFailureCircuit({ toolThreshold: 3, sessionThreshold: 20 });
  const last = failTimes(c, 's1', 'web_search', 3).at(-1);
  assert.equal(last.opened, true);
  assert.equal(last.scope, 'tool');
  assert.equal(last.code, CIRCUIT_CODE);
  assert.match(last.label, /circuito/i);
  const gate = c.authorize('s1', 'web_search');
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, 'tool_circuit_open');
  assert.equal(c.authorize('s1', 'read_file').allowed, true);
});

test('session circuit opens at the session threshold and blocks every tool', () => {
  const c = createToolFailureCircuit({ toolThreshold: 20, sessionThreshold: 3 });
  failTimes(c, 's1', 'web_search', 1);
  failTimes(c, 's1', 'read_file', 1);
  const last = c.record('s1', 'browse', { ok: false });
  assert.equal(last.opened, true);
  assert.equal(last.scope, 'session');
  assert.match(last.label, /presupuesto de fallos/i);
  assert.equal(c.authorize('s1', 'web_search').allowed, false);
  assert.equal(c.authorize('s1', 'read_file').allowed, false);
  assert.equal(c.authorize('s1', 'browse').allowed, false);
});

test('a success resets consecutive failures', () => {
  const c = createToolFailureCircuit({ toolThreshold: 3, sessionThreshold: 3 });
  failTimes(c, 's1', 'web_search', 2);
  const rec = c.record('s1', 'web_search', { ok: true });
  assert.equal(rec.state, 'closed');
  assert.equal(c.snapshot('s1').consecutive, 0);
  failTimes(c, 's1', 'web_search', 2);
  assert.equal(c.authorize('s1', 'web_search').allowed, true);
});

test('transient failures weigh a fraction of a terminal failure', () => {
  const c = createToolFailureCircuit({
    toolThreshold: 2,
    sessionThreshold: 20,
    transientWeight: 0.34,
  });
  c.record('s1', 'web_search', { ok: false, transient: true });
  c.record('s1', 'web_search', { ok: false, transient: true });
  assert.equal(c.authorize('s1', 'web_search').allowed, true);
  c.record('s1', 'web_search', { ok: false, transient: false });
  c.record('s1', 'web_search', { ok: false, transient: false });
  assert.equal(c.authorize('s1', 'web_search').allowed, false);
});

test('cooldown keeps the circuit open until the clock advances', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const c = createToolFailureCircuit({
    toolThreshold: 2,
    sessionThreshold: 20,
    cooldownMs: 30_000,
    now: () => Date.now(),
  });
  failTimes(c, 's1', 'web_search', 2);
  assert.equal(c.authorize('s1', 'web_search').allowed, false);
  t.mock.timers.tick(10_000);
  assert.equal(c.authorize('s1', 'web_search').allowed, false);
  assert.match(c.authorize('s1', 'web_search').label, /enfríe|abierto|circuito/i);
});

test('after cooldown the circuit is half-open and allows one probe', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const c = createToolFailureCircuit({
    toolThreshold: 2,
    sessionThreshold: 20,
    cooldownMs: 30_000,
    now: () => Date.now(),
  });
  failTimes(c, 's1', 'web_search', 2);
  t.mock.timers.tick(30_000);
  const probe = c.authorize('s1', 'web_search');
  assert.equal(probe.allowed, true);
  assert.equal(probe.state, 'half_open');
  assert.match(probe.label, /prueba/i);
  const second = c.authorize('s1', 'web_search');
  assert.equal(second.allowed, false);
});

test('half-open success closes the tool circuit', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const c = createToolFailureCircuit({
    toolThreshold: 2,
    sessionThreshold: 20,
    cooldownMs: 15_000,
    now: () => Date.now(),
  });
  failTimes(c, 's1', 'web_search', 2);
  t.mock.timers.tick(15_000);
  c.authorize('s1', 'web_search');
  const rec = c.record('s1', 'web_search', { ok: true });
  assert.equal(rec.state, 'closed');
  assert.equal(c.authorize('s1', 'web_search').allowed, true);
  assert.equal(c.authorize('s1', 'web_search').state, 'closed');
});

test('half-open failure reopens and stays closed until the next cooldown', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const c = createToolFailureCircuit({
    toolThreshold: 2,
    sessionThreshold: 20,
    cooldownMs: 20_000,
    now: () => Date.now(),
  });
  failTimes(c, 's1', 'web_search', 2);
  t.mock.timers.tick(20_000);
  c.authorize('s1', 'web_search');
  const rec = c.record('s1', 'web_search', { ok: false });
  assert.equal(rec.opened, true);
  assert.equal(c.authorize('s1', 'web_search').allowed, false);
  t.mock.timers.tick(10_000);
  assert.equal(c.authorize('s1', 'web_search').allowed, false);
  t.mock.timers.tick(10_000);
  assert.equal(c.authorize('s1', 'web_search').state, 'half_open');
});

test('session TTL expires stale entries after the clock advances', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const c = createToolFailureCircuit({
    toolThreshold: 2,
    sessionThreshold: 2,
    ttlMs: 60_000,
    now: () => Date.now(),
  });
  failTimes(c, 's1', 'web_search', 2);
  assert.equal(c.authorize('s1', 'web_search').allowed, false);
  t.mock.timers.tick(60_001);
  const snap = c.snapshot('s1');
  assert.equal(snap.missing, true);
  assert.equal(c.authorize('s1', 'web_search').allowed, true);
});

test('sweep removes stale sessions using the fake clock', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const c = createToolFailureCircuit({
    ttlMs: 5_000,
    now: () => Date.now(),
  });
  c.record('keep', 'web_search', { ok: false });
  c.record('stale', 'web_search', { ok: false });
  t.mock.timers.tick(5_001);
  c.record('keep', 'read_file', { ok: true });
  const swept = c.sweep();
  assert.equal(swept.removed, 1);
  assert.equal(c.snapshot('stale').missing, true);
  assert.equal(c.snapshot('keep').missing, false);
});

test('snapshot shape has no vendor leak', () => {
  const c = createToolFailureCircuit({ toolThreshold: 2, sessionThreshold: 20 });
  failTimes(c, 's1', 'web_search', 2);
  const snap = c.snapshot('s1');
  assert.equal(snap.sessionKey, 's1');
  assert.equal(snap.tools.web_search.state, 'open');
  assert.ok(snap.tools.web_search);
  assert.equal(VENDOR_LEAK.test(JSON.stringify(snap)), false);
});

test('reset clears a session so tools run again', () => {
  const c = createToolFailureCircuit({ sessionThreshold: 2, toolThreshold: 20 });
  failTimes(c, 's1', 'web_search', 2);
  assert.equal(c.reset('s1').ok, true);
  assert.equal(c.authorize('s1', 'web_search').allowed, true);
  assert.equal(c.snapshot('s1').consecutive, 0);
});

test('generic_repeat detector opens the session circuit', () => {
  const c = createToolFailureCircuit({
    toolThreshold: 20,
    sessionThreshold: 20,
    repeatOpen: 4,
  });
  const last = failTimes(c, 's1', 'web_search', 4, { argsKey: '{"q":"x"}' }).at(-1);
  assert.equal(last.opened, true);
  assert.equal(last.detector, 'generic_repeat');
  assert.match(last.label, /mismos argumentos|bucle/i);
  assert.equal(c.authorize('s1', 'read_file').allowed, false);
});

test('ping_pong detector opens on alternating failures', () => {
  const c = createToolFailureCircuit({
    toolThreshold: 20,
    sessionThreshold: 20,
    pingPongOpen: 4,
  });
  c.record('s1', 'alpha', { ok: false });
  c.record('s1', 'beta', { ok: false });
  c.record('s1', 'alpha', { ok: false });
  const last = c.record('s1', 'beta', { ok: false });
  assert.equal(last.opened, true);
  assert.equal(last.detector, 'ping_pong');
  assert.match(last.label, /vaivén|vaiven/i);
});

test('unknown_tool streak opens the session circuit', () => {
  const c = createToolFailureCircuit({
    toolThreshold: 20,
    sessionThreshold: 20,
    unknownOpen: 3,
  });
  const last = failTimes(c, 's1', 'no_such_tool', 3, { unknownTool: true }).at(-1);
  assert.equal(last.opened, true);
  assert.equal(last.detector, 'unknown_tool');
  assert.match(last.label, /inexistente/i);
});

test('sessions are isolated from each other', () => {
  const c = createToolFailureCircuit({ sessionThreshold: 2, toolThreshold: 20 });
  failTimes(c, 'alice', 'web_search', 2);
  assert.equal(c.authorize('alice', 'web_search').allowed, false);
  assert.equal(c.authorize('bob', 'web_search').allowed, true);
});

test('presentCircuitDenial wraps a Spanish E_TIMEOUT payload', () => {
  const gate = denyFixture();
  const denial = presentCircuitDenial(gate);
  assert.equal(denial.code, CIRCUIT_CODE);
  assert.match(denial.message, /circuito|presupuesto/i);
  assert.equal(presentCircuitDenial({ allowed: true }), null);
});

function denyFixture() {
  const c = createToolFailureCircuit({ sessionThreshold: 1, toolThreshold: 20 });
  c.record('s1', 'web_search', { ok: false });
  return c.authorize('s1', 'web_search');
}

test('presentTaskError keeps the circuit Spanish label', () => {
  const presented = presentTaskError(new Error(CIRCUIT_LABELS.open_session));
  assert.equal(presented.code, 'E_TIMEOUT');
  assert.match(presented.label, /presupuesto de fallos/);
});

test('attachToolFailureCircuit reuses an existing circuit and session key', () => {
  const existing = createToolFailureCircuit({ sessionThreshold: 2 });
  const ctx = { taskId: 'task-9', chatId: 'chat-1' };
  attachToolFailureCircuit(ctx, { circuit: existing, sessionKey: 'task-9' });
  assert.equal(ctx.toolFailureCircuit, existing);
  assert.equal(ctx.circuitSessionKey, 'task-9');
  attachToolFailureCircuit(ctx, { sessionKey: 'other' });
  assert.equal(ctx.circuitSessionKey, 'task-9');
  assert.equal(circuitSessionKeyOf(ctx), 'task-9');
});

test('circuitSessionKeyOf prefers the explicit key', () => {
  assert.equal(circuitSessionKeyOf({ circuitSessionKey: 'a', taskId: 'b', chatId: 'c' }), 'a');
  assert.equal(circuitSessionKeyOf({ taskId: 'b', chatId: 'c' }), 'b');
  assert.equal(circuitSessionKeyOf({ chatId: 'c' }), 'c');
  assert.equal(circuitSessionKeyOf(null), '');
});

test('source module does not import upstream OpenClaw', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../src/services/agents/tool-failure-circuit.js'),
    'utf8',
  );
  assert.equal(/src\/upstream\/openclaw|require\([^)]*openclaw\/openclaw/.test(src), false);
  assert.match(src, /Native rewrite/);
  assert.match(src, /fail closed/i);
});

test('react-agent dispatchTool denies an open session circuit without executing', async () => {
  const c = createToolFailureCircuit({ sessionThreshold: 1, toolThreshold: 20 });
  c.record('task-1', 'web_search', { ok: false });
  let executed = 0;
  const result = await reactAgent.dispatchTool(
    [{
      name: 'web_search',
      description: 'search',
      parameters: { type: 'object', properties: {} },
      execute: async () => { executed += 1; return { ok: true }; },
    }],
    'web_search',
    '{}',
    { toolFailureCircuit: c, circuitSessionKey: 'task-1' },
  );
  assert.equal(executed, 0);
  assert.equal(result.circuitDenied, true);
  assert.match(String(result.error), /circuito|presupuesto/i);
});

test('react-agent run fails closed and finalizes after the session circuit opens', async () => {
  const c = createToolFailureCircuit({ sessionThreshold: 2, toolThreshold: 20 });
  const failing = {
    name: 'broken_tool',
    description: 'always fails',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: true },
    execute: async () => { throw new Error('simulated failure'); },
  };
  const script = [
    { tool: 'broken_tool', args: { q: '1' } },
    { tool: 'broken_tool', args: { q: '2' } },
    { tool: 'broken_tool', args: { q: '3' } },
    { finalize: 'Respuesta con lo que ya tengo.' },
  ];
  const result = await reactAgent.run(makeScriptedOpenAI(script), {
    query: 'resolver',
    tools: [failing],
    maxSteps: 8,
    model: 'test-model',
    ctx: { toolFailureCircuit: c, circuitSessionKey: 'run-1' },
  });
  assert.equal(result.stoppedReason, 'tool_circuit_open');
  const circuitObs = result.steps.flatMap((s) => s.actions || [])
    .find((a) => a.observation && a.observation.error === 'tool_circuit_open');
  assert.ok(circuitObs);
  assert.match(String(circuitObs.observation.message), /circuito|presupuesto/i);
  assert.equal(VENDOR_LEAK.test(JSON.stringify(result)), false);
});

test('session half-open cooldown uses fake timers across two ticks', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const c = createToolFailureCircuit({
    toolThreshold: 20,
    sessionThreshold: 2,
    cooldownMs: 8_000,
    now: () => Date.now(),
  });
  failTimes(c, 's1', 'a', 1);
  failTimes(c, 's1', 'b', 1);
  assert.equal(c.snapshot('s1').state, 'open');
  t.mock.timers.tick(4_000);
  assert.equal(c.authorize('s1', 'a').allowed, false);
  t.mock.timers.tick(4_000);
  const probe = c.authorize('s1', 'a');
  assert.equal(probe.state, 'half_open');
  c.record('s1', 'a', { ok: true });
  assert.equal(c.snapshot('s1').state, 'closed');
});

test('invalid numeric options fall back to defaults', () => {
  const c = createToolFailureCircuit({
    toolThreshold: 0,
    sessionThreshold: -3,
    cooldownMs: 'nope',
    transientWeight: 9,
  });
  assert.equal(c.toolThreshold, DEFAULT_TOOL_THRESHOLD);
  assert.equal(c.sessionThreshold, DEFAULT_SESSION_THRESHOLD);
  assert.equal(c.cooldownMs, DEFAULT_COOLDOWN_MS);
});

test('record on a missing session key fails closed', () => {
  const c = createToolFailureCircuit();
  const rec = c.record('   ', 'web_search', { ok: false });
  assert.equal(rec.opened, true);
  assert.match(rec.label, /sesión|sesion|presupuesto/i);
});

test('warning/critical Spanish labels stay on the allow path', () => {
  const c = createToolFailureCircuit({ toolThreshold: 8, sessionThreshold: 8 });
  failTimes(c, 's1', 'web_search', 4);
  const gate = c.authorize('s1', 'web_search');
  assert.equal(gate.allowed, true);
  assert.ok(gate.state === 'warning' || gate.state === 'critical');
  assert.match(String(gate.label), /fallando|consecutivos|límite|limite/i);
});

test('agent-task-runner wires attachToolFailureCircuit next to toolCtx', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../src/services/agents/agent-task-runner.js'),
    'utf8',
  );
  assert.match(src, /attachToolFailureCircuit\(toolCtx/);
  assert.match(src, /require\('\.\/tool-failure-circuit'\)/);
  assert.equal(/src\/upstream\/openclaw/.test(src), false);
});

test('authorize remainingMs shrinks as the fake clock advances', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const c = createToolFailureCircuit({
    toolThreshold: 2,
    sessionThreshold: 20,
    cooldownMs: 12_000,
    now: () => Date.now(),
  });
  failTimes(c, 's1', 'web_search', 2);
  const before = c.authorize('s1', 'web_search');
  assert.ok(before.remainingMs >= 11_000);
  t.mock.timers.tick(4_000);
  const after = c.authorize('s1', 'web_search');
  assert.ok(after.remainingMs <= before.remainingMs - 4_000 + 5);
  assert.equal(after.allowed, false);
});

test('two sessions cool down independently on the same clock', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const c = createToolFailureCircuit({
    toolThreshold: 2,
    sessionThreshold: 20,
    cooldownMs: 10_000,
    now: () => Date.now(),
  });
  failTimes(c, 'early', 'web_search', 2);
  t.mock.timers.tick(5_000);
  failTimes(c, 'late', 'web_search', 2);
  t.mock.timers.tick(5_000);
  assert.equal(c.authorize('early', 'web_search').state, 'half_open');
  assert.equal(c.authorize('late', 'web_search').allowed, false);
});

test('session circuit remainingMs uses the fake clock', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const c = createToolFailureCircuit({
    toolThreshold: 20,
    sessionThreshold: 2,
    cooldownMs: 9_000,
    now: () => Date.now(),
  });
  failTimes(c, 's1', 'a', 1);
  failTimes(c, 's1', 'b', 1);
  const gate = c.authorize('s1', 'c');
  assert.equal(gate.allowed, false);
  assert.ok(gate.remainingMs >= 8_000);
  t.mock.timers.tick(9_000);
  assert.equal(c.authorize('s1', 'c').state, 'half_open');
});

test('TTL does not expire a session that is touched before the deadline', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const c = createToolFailureCircuit({
    ttlMs: 8_000,
    toolThreshold: 20,
    sessionThreshold: 20,
    now: () => Date.now(),
  });
  c.record('s1', 'web_search', { ok: false });
  t.mock.timers.tick(7_000);
  c.record('s1', 'web_search', { ok: true });
  t.mock.timers.tick(7_000);
  assert.equal(c.snapshot('s1').missing, false);
});

test('sweep with an explicit timestamp ignores the live clock', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const c = createToolFailureCircuit({
    ttlMs: 1_000,
    now: () => Date.now(),
  });
  c.record('s1', 'web_search', { ok: false });
  const createdAt = Date.now();
  t.mock.timers.tick(50_000);
  const dry = c.sweep(createdAt);
  assert.equal(dry.removed, 0);
  const wet = c.sweep();
  assert.equal(wet.removed, 1);
});

test('half-open session probe failure reopens with Spanish cooldown', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const c = createToolFailureCircuit({
    toolThreshold: 20,
    sessionThreshold: 2,
    cooldownMs: 6_000,
    now: () => Date.now(),
  });
  failTimes(c, 's1', 'a', 1);
  failTimes(c, 's1', 'b', 1);
  t.mock.timers.tick(6_000);
  c.authorize('s1', 'a');
  const rec = c.record('s1', 'a', { ok: false });
  assert.equal(rec.opened, true);
  assert.match(c.authorize('s1', 'a').label, /enfríe|circuito|presupuesto/i);
});

test('reset during cooldown immediately allows tools', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const c = createToolFailureCircuit({
    toolThreshold: 2,
    cooldownMs: 60_000,
    now: () => Date.now(),
  });
  failTimes(c, 's1', 'web_search', 2);
  t.mock.timers.tick(1_000);
  c.reset('s1');
  assert.equal(c.authorize('s1', 'web_search').allowed, true);
});

test('history is capped and still detects generic_repeat after ticks', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const c = createToolFailureCircuit({
    historySize: 6,
    toolThreshold: 20,
    sessionThreshold: 20,
    repeatOpen: 3,
    now: () => Date.now(),
  });
  for (let i = 0; i < 8; i += 1) {
    c.record('s1', 'other', { ok: true, argsKey: `ok-${i}` });
    t.mock.timers.tick(10);
  }
  failTimes(c, 's1', 'web_search', 3, { argsKey: '{"q":"loop"}' });
  assert.equal(c.authorize('s1', 'read_file').allowed, false);
  assert.ok(c.snapshot('s1').history <= 6);
});

test('Date.now in the circuit matches t.mock.timers.tick increments', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const samples = [];
  const c = createToolFailureCircuit({
    toolThreshold: 2,
    cooldownMs: 3_000,
    now: () => {
      samples.push(Date.now());
      return Date.now();
    },
  });
  const start = Date.now();
  failTimes(c, 's1', 'web_search', 2);
  t.mock.timers.tick(3_000);
  c.authorize('s1', 'web_search');
  assert.ok(samples.some((n) => n >= start + 3_000));
});

test('unknown_tool cooldown uses fake timers before a new session starts', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const c = createToolFailureCircuit({
    unknownOpen: 2,
    toolThreshold: 20,
    sessionThreshold: 20,
    cooldownMs: 4_000,
    ttlMs: 4_000,
    now: () => Date.now(),
  });
  failTimes(c, 's1', 'ghost', 2, { unknownTool: true });
  assert.equal(c.authorize('s1', 'ghost').allowed, false);
  t.mock.timers.tick(4_001);
  assert.equal(c.snapshot('s1').missing, true);
});

test('presentCircuitDenial remainingMs comes from the open gate after a tick', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const c = createToolFailureCircuit({
    sessionThreshold: 1,
    cooldownMs: 11_000,
    now: () => Date.now(),
  });
  c.record('s1', 'web_search', { ok: false });
  t.mock.timers.tick(1_000);
  const denial = presentCircuitDenial(c.authorize('s1', 'web_search'));
  assert.ok(denial.circuit.remainingMs <= 10_000);
  assert.equal(denial.code, CIRCUIT_CODE);
});

