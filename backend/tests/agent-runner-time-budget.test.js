'use strict';

// Production 2026-10-07: five document generations, five failures. Three of
// them ran 395–408 s under the 6-min wall: the deck existed, the vision review
// vetoed it, the model started another full regeneration, and the wall cut the
// turn with nothing delivered. The loop never told the model how much time was
// left. Now it does, once, before the wall — and the creation wall itself is
// sized for creation work. The failure copy names the real cause.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_THRESHOLD_MS,
  timeBudgetThresholdMs,
  shouldNudgeTimeBudget,
  timeBudgetNudge,
} = require('../src/services/agent-runner/time-budget');
const { runAgentLoop } = require('../src/services/agent-runner/loop');
const runner = require('../src/services/agent-runner');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('threshold: 30 % of the wall, half of it on short walls, never above 90 s', () => {
  assert.equal(MAX_THRESHOLD_MS, 90_000);
  assert.equal(timeBudgetThresholdMs(6 * 60_000), 108_000);
  assert.equal(timeBudgetThresholdMs(8 * 60_000), 144_000);
  assert.equal(timeBudgetThresholdMs(10 * 60_000), 180_000);
  assert.equal(timeBudgetThresholdMs(2_000), 1_000);
  assert.equal(timeBudgetThresholdMs(0), 0);
  assert.equal(timeBudgetThresholdMs('nope'), 0);
});

test('shouldNudgeTimeBudget fires once the remaining time is inside the threshold, never twice', () => {
  const wallMs = 6 * 60_000;
  assert.equal(shouldNudgeTimeBudget({ elapsedMs: 60_000, wallMs }), false);
  assert.equal(shouldNudgeTimeBudget({ elapsedMs: wallMs - 108_000, wallMs }), true);
  assert.equal(shouldNudgeTimeBudget({ elapsedMs: wallMs - 30_000, wallMs }), true);
  assert.equal(shouldNudgeTimeBudget({ elapsedMs: wallMs - 30_000, wallMs, nudged: true }), false);
  assert.equal(shouldNudgeTimeBudget({ elapsedMs: 10, wallMs: 0 }), false, 'no wall, no budget');
  assert.equal(shouldNudgeTimeBudget({ elapsedMs: -1, wallMs }), false);
});

test('the nudge names the seconds left and forbids a new regeneration round', () => {
  const text = timeBudgetNudge(95_400);
  assert.match(text, /^TIME BUDGET: about 95 s remain/);
  assert.match(text, /Do NOT start another full regeneration/);
  assert.match(text, /inspect_document \+ verify_visual/);
  assert.match(text, /never pretend it worked/);
  assert.match(timeBudgetNudge(-5), /about 0 s remain/);
});

// The adapter's own wall-clock cut halts a turn with < 5 s left
// (engine-adapter WALL_CLOCK_CUT_MS), so the fixture wall must leave the nudge
// window ABOVE that floor: 12 s wall → 6 s threshold; a 6.5 s tool leaves ~5.5 s.
function slowToolClient(seenMessages) {
  let n = 0;
  return { chat: { completions: { create: async (payload) => {
    n += 1;
    seenMessages.push(payload.messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })));
    return n === 1
      ? { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } }] } }] }
      : { choices: [{ message: { role: 'assistant', content: 'Listo.' } }] };
  } } } };
}

test('the loop injects ONE time-budget message once the wall is near, and none on a roomy wall', async () => {
  const base = (toolMs) => ({
    model: 'x',
    messages: [{ role: 'user', content: 'lista' }],
    tools: [],
    executors: { async list_files() { await sleep(toolMs); return 'a.docx'; } },
    maxIterations: 4,
  });
  // Wall 12 s → threshold 6 s. The 6.5 s tool leaves ~5.5 s: the second LLM
  // call must see the nudge as the last user message.
  const seen = [];
  const events = [];
  const cut = await runAgentLoop({ ...base(6_500), client: slowToolClient(seen), turnWallMs: 12_000, onEvent: (ev) => events.push(ev) });
  assert.equal(cut.stoppedReason, 'final');
  assert.equal(seen.length, 2);
  const nudges = seen[1].filter((m) => m.role === 'user' && /^TIME BUDGET:/.test(m.content));
  assert.equal(nudges.length, 1, 'exactly one nudge in the transcript');
  assert.equal(seen[1][seen[1].length - 1].content.startsWith('TIME BUDGET:'), true, 'the nudge is the latest user turn');
  const budgetEvents = events.filter((ev) => ev && ev.type === 'time_budget');
  assert.equal(budgetEvents.length, 1);
  assert.equal(budgetEvents[0].label, 'Queda poco tiempo: cerrando el turno');
  assert.ok(budgetEvents[0].remainingMs >= 0 && budgetEvents[0].remainingMs <= 6_000);

  const roomy = [];
  const ok = await runAgentLoop({ ...base(50), client: slowToolClient(roomy), turnWallMs: 60_000 });
  assert.equal(ok.stoppedReason, 'final');
  assert.equal(roomy[1].some((m) => /^TIME BUDGET:/.test(m.content)), false, 'no nudge while time is plentiful');

  const chat = [];
  await runAgentLoop({ ...base(50), client: slowToolClient(chat) });
  assert.equal(chat[1].some((m) => /^TIME BUDGET:/.test(m.content)), false, 'chat turns without a wall are never nudged');
});

test('the failure copy names the wall and the no-progress cut instead of a bare code', () => {
  assert.match(runner.buildAgentRunnerFailureMessage('turn_wall'), /agotó el tiempo máximo del turno antes de terminar y verificar el archivo/);
  assert.match(runner.buildAgentRunnerFailureMessage('wall_clock'), /agotó el tiempo máximo del turno/);
  assert.match(runner.buildAgentRunnerFailureMessage('subtask_no_progress'), /tres pasos fallidos seguidos/);
  assert.doesNotMatch(runner.buildAgentRunnerFailureMessage('turn_wall'), /\(turn_wall\)/);
});
