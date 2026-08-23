'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LOOP_PATH = path.join(__dirname, '..', 'src', 'services', 'agent-runner', 'loop.js');
const AI_PATH = path.join(__dirname, '..', 'src', 'routes', 'ai.js');
const {
  runAgentLoop,
  classifyLoopError,
  compactMessagesInPlace,
  MAX_CONSECUTIVE_REPAIR_FAILS,
} = require('../src/services/agent-runner/loop');
const ad = require('../src/services/agent-runner/engine-adapter');

function scriptedClient(script) {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async ({ messages } = {}) => {
          if (i >= script.length) throw new Error('scripted client exhausted');
          const turn = script[i++];
          if (typeof turn.onCreate === 'function') turn.onCreate({ messages });
          if (turn.rawCalls) {
            return {
              choices: [{
                message: {
                  content: turn.content || null,
                  tool_calls: turn.rawCalls.map((c, idx) => ({
                    id: c.id || `call_${i}_${idx}`,
                    type: 'function',
                    function: { name: c.name, arguments: c.arguments },
                  })),
                },
              }],
            };
          }
          if (turn.toolCalls) {
            return {
              choices: [{
                message: {
                  content: turn.content || null,
                  tool_calls: turn.toolCalls.map((c, idx) => ({
                    id: `call_${i}_${idx}`,
                    type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
                  })),
                },
              }],
            };
          }
          return { choices: [{ message: { content: turn.content || 'ok' } }] };
        },
      },
    },
  };
}

test('hot-path source wires live #388 helper names (3H60 overlay may coexist)', () => {
  const loopSrc = fs.readFileSync(LOOP_PATH, 'utf8');
  const aiSrc = fs.readFileSync(AI_PATH, 'utf8');
  assert.match(loopSrc, /retryToolWithBackoff/);
  assert.match(loopSrc, /isRetryableToolFailure/);
  assert.match(loopSrc, /compactUntilTokenBudget/);
  assert.match(loopSrc, /anchorCriticalFacts/);
  assert.match(loopSrc, /compactPreserveFactAnchors/);
  assert.match(loopSrc, /repairTruncatedJson/);
  assert.match(aiSrc, /startCommentHeartbeat/);
  assert.match(aiSrc, /honorLastEventId/);
  assert.match(aiSrc, /inclusiveReplayStartFromRing/);
  assert.match(aiSrc, /stopGenerateSseHeartbeat/);
});

test('honorLastEventId default stays exclusive (3H32-S-002)', () => {
  const out = ad.honorLastEventId('3', [{ seq: 2 }, { seq: 3 }, { seq: 4 }, { seq: 5 }]);
  assert.equal(out.last, 3);
  assert.equal(out.replay.length, 2);
  assert.equal(out.replay[0].seq, 4);
  assert.equal(out.inclusive, false);
});

test('honorLastEventId inclusive replay includes the Last-Event-ID seq', () => {
  const ring = [{ seq: 2 }, { seq: 3 }, { seq: 4 }, { seq: 5 }];
  const out = ad.honorLastEventId('3', ring, { inclusive: true });
  assert.equal(out.last, 3);
  assert.equal(out.inclusive, true);
  assert.equal(out.replay.length, 3);
  assert.equal(out.replay[0].seq, 3);
  assert.equal(out.replay[2].seq, 5);
});

test('runAgentLoop retries ECONNRESET via retryToolWithBackoff then succeeds', async () => {
  let attempts = 0;
  const client = scriptedClient([
    { toolCalls: [{ name: 'list_files', args: { path: '.' } }] },
    { content: 'Listo tras retry.' },
  ]);
  const result = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'lista' }],
    tools: [],
    executors: {
      async list_files() {
        attempts += 1;
        if (attempts === 1) {
          const err = new Error('socket hang up');
          err.code = 'ECONNRESET';
          throw err;
        }
        return '(ok)';
      },
    },
    maxIterations: 5,
  });
  assert.equal(result.stoppedReason, 'final');
  assert.equal(attempts, 2);
  assert.equal(result.steps[0].ok, true);
  assert.match(result.finalText, /Listo/);
});

test('runAgentLoop stops fail-closed after transient retries exhaust', async () => {
  let attempts = 0;
  const client = scriptedClient([
    { toolCalls: [{ name: 'list_files', args: { path: '.' } }] },
    { content: 'should-not-run' },
  ]);
  const result = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'lista' }],
    tools: [],
    executors: {
      async list_files() {
        attempts += 1;
        const err = new Error('timeout');
        err.code = 'ETIMEDOUT';
        throw err;
      },
    },
    maxIterations: 5,
  });
  assert.equal(result.stoppedReason, 'tool_retry_exhausted');
  assert.equal(result.errorCode, 'tool_retry_exhausted');
  assert.equal(attempts, 3);
  assert.equal(classifyLoopError({ code: 'tool_retry_exhausted' }).retryable, false);
});

test('runAgentLoop re-invokes executor after repairTruncatedJson', async () => {
  const seen = [];
  const client = scriptedClient([
    { rawCalls: [{ name: 'list_files', arguments: '{"path":"."' }] },
    { content: 'Reparé args.' },
  ]);
  const result = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'lista' }],
    tools: [],
    executors: {
      async list_files(args) {
        seen.push(args);
        return JSON.stringify(args);
      },
    },
    maxIterations: 5,
  });
  assert.equal(result.stoppedReason, 'final');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, '.');
});

test('runAgentLoop stops after max consecutive unrepairable tool args', async () => {
  assert.equal(MAX_CONSECUTIVE_REPAIR_FAILS, 3);
  let executed = 0;
  const client = scriptedClient([
    { rawCalls: [{ name: 'list_files', arguments: '%%%not-json' }] },
    { rawCalls: [{ name: 'list_files', arguments: '%%%still-bad' }] },
    { rawCalls: [{ name: 'list_files', arguments: '%%%again' }] },
    { content: 'should-not-finalise' },
  ]);
  const result = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'lista' }],
    tools: [],
    executors: {
      async list_files() {
        executed += 1;
        return 'should-not-run';
      },
    },
    maxIterations: 8,
  });
  assert.equal(result.stoppedReason, 'tool_repair_exhausted');
  assert.equal(result.errorCode, 'tool_repair_exhausted');
  assert.equal(executed, 0);
});

test('compactUntilTokenBudget runs before callModel and keeps system + pins', async () => {
  const messages = [
    { role: 'system', content: 'SYSTEM_PIN_KEEP' },
    { role: 'user', content: 'MUST: keep-this-anchor-xyz' },
  ];
  for (let i = 0; i < 40; i += 1) {
    messages.push({ role: 'user', content: `blob-${i}- ${'x'.repeat(400)}` });
  }
  const before = messages.length;
  let seenAtModel = 0;
  const client = scriptedClient([
    {
      content: 'Compacté.',
      onCreate({ messages: atModel }) {
        seenAtModel = Array.isArray(atModel) ? atModel.length : 0;
        assert.ok(atModel.some((m) => String(m.content).includes('SYSTEM_PIN_KEEP')));
        assert.ok(atModel.some((m) => String(m.content).includes('keep-this-anchor-xyz')));
      },
    },
  ]);
  const result = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages,
    tools: [],
    executors: {},
    maxIterations: 2,
  });
  assert.equal(result.stoppedReason, 'final');
  assert.ok(seenAtModel > 0 && seenAtModel < before);
  assert.ok(messages.some((m) => String(m && m.content).includes('SYSTEM_PIN_KEEP')));
});

test('compactMessagesInPlace no-ops when already under budget', () => {
  const messages = [
    { role: 'system', content: 'short' },
    { role: 'user', content: 'hi' },
  ];
  const changed = compactMessagesInPlace(messages);
  assert.equal(changed, false);
  assert.equal(messages.length, 2);
});
