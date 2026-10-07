'use strict';

// Production 2026-10-07: four `POST /api/doc/generate` turns ended in
// `turn_wall` after 395–408 s under the 6-minute document wall, while the
// error event still read «El turno superó el tope de 120 s» (the 3H64 chat
// default). The copy must name the wall that actually fired.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runAgentLoop } = require('../src/services/agent-runner/loop');

function slowClient(delayMs) {
  let n = 0;
  return { chat: { completions: { create: async () => {
    n += 1;
    await new Promise((r) => setTimeout(r, delayMs));
    return n === 1
      ? { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } }] } }] }
      : { choices: [{ message: { role: 'assistant', content: 'Listo.' } }] };
  } } } };
}

test('the turn_wall error names the wall the turn ran under, not the 120 s engine default', async () => {
  const events = [];
  const result = await runAgentLoop({
    model: 'x',
    messages: [{ role: 'user', content: 'lista' }],
    tools: [],
    executors: { async list_files() { return 'a.docx'; } },
    maxIterations: 4,
    client: slowClient(1100),
    turnWallMs: 1000,
    onEvent: (ev) => events.push(ev),
  });
  assert.match(result.stoppedReason, /^(turn_wall|wall_clock)$/);
  const error = events.find((ev) => ev && ev.type === 'error' && ev.code === 'turn_wall');
  if (error) {
    assert.match(error.message, /tope de 1 s/);
    assert.doesNotMatch(error.message, /120 s/);
  } else {
    // The remaining-wall-clock cut (wall_clock) fired first; its own copy has no number.
    assert.ok(events.some((ev) => ev && ev.type === 'error'), 'the cut is reported as an error event');
  }
});
