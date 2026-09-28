'use strict';

/**
 * Item 5 (prod req cccc319b, 2026-09-28): `[agent-runner] tool transcript
 * repaired (N fixes) before the LLM call` was logged at WARN on every
 * iteration of the same task (10+ times). Now: WARN once per turn with the
 * fix kinds, then debug.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeToolTranscript } = require('../src/services/agent-runner/tool-transcript');
const { callModel, runAgentLoop } = require('../src/services/agent-runner/loop');

function captureConsole() {
  const out = { warn: [], debug: [] };
  const orig = { warn: console.warn, debug: console.debug };
  console.warn = (...a) => out.warn.push(a.join(' '));
  console.debug = (...a) => out.debug.push(a.join(' '));
  return { out, restore: () => { console.warn = orig.warn; console.debug = orig.debug; } };
}

const BROKEN = [
  { role: 'system', content: 's' },
  { role: 'user', content: 'hola' },
  { role: 'tool', tool_call_id: 'orphan-1', content: 'result without a call' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
];

test('normalizeToolTranscript reports the fix kinds', () => {
  const out = normalizeToolTranscript(BROKEN);
  assert.equal(out.repaired, 2);
  assert.deepEqual(out.kinds, { orphan_result: 1, missing_result: 1 });
  assert.deepEqual(normalizeToolTranscript([{ role: 'user', content: 'x' }]).kinds, {});
});

test('callModel: WARN with kinds on the first repair of a turn, debug afterwards', async () => {
  const cap = captureConsole();
  try {
    const client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) } } };
    const repairLog = { warned: false, count: 0 };
    for (let i = 0; i < 4; i += 1) {
      await callModel({ client, model: 'deepseek-v4-flash', messages: BROKEN, tools: [], repairLog });
    }
    const warns = cap.out.warn.filter((l) => l.includes('tool transcript repaired'));
    const debugs = cap.out.debug.filter((l) => l.includes('tool transcript repaired'));
    assert.equal(warns.length, 1, 'exactly one WARN per turn');
    assert.match(warns[0], /\(2 fixes: orphan_result×1, missing_result×1\) before the LLM call/);
    assert.equal(debugs.length, 3);
    assert.match(debugs[2], /\(repeat 4\)/);
    assert.equal(repairLog.count, 4);

    // Without a shared log object (legacy callers) every call still warns.
    await callModel({ client, model: 'deepseek-v4-flash', messages: BROKEN, tools: [] });
    assert.equal(cap.out.warn.filter((l) => l.includes('tool transcript repaired')).length, 2);
  } finally {
    cap.restore();
  }
});

test('runAgentLoop shares one repair log across its iterations', async () => {
  const cap = captureConsole();
  try {
    let n = 0;
    const client = {
      chat: {
        completions: {
          create: async () => {
            n += 1;
            if (n < 3) {
              return { choices: [{ message: { content: '', tool_calls: [{ id: `t${n}`, type: 'function', function: { name: 'noop', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] };
            }
            return { choices: [{ message: { content: 'listo' }, finish_reason: 'stop' }] };
          },
        },
      },
    };
    const tools = [{ type: 'function', function: { name: 'noop', description: 'nothing', parameters: { type: 'object', properties: {} } } }];
    const executors = { noop: async () => ({ ok: true }) };
    const result = await runAgentLoop({ client, model: 'deepseek-v4-flash', messages: BROKEN.slice(), tools, executors, maxIterations: 5 });
    assert.equal(result.finalText, 'listo');
    assert.ok(n >= 3, `model called ${n} times`);
    const warns = cap.out.warn.filter((l) => l.includes('tool transcript repaired'));
    assert.equal(warns.length, 1, 'one WARN for the whole turn');
    assert.ok(cap.out.debug.filter((l) => l.includes('tool transcript repaired')).length >= 1, 'later iterations at debug');
  } finally {
    cap.restore();
  }
});
