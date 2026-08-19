'use strict';

// Per-tool timeout + result-size cap (brain-infra roadmap #3): a hung tool
// must fail cleanly within its budget instead of stalling the whole run, and
// an oversized string result must be truncated before it re-enters the loop.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAgentEventStream } = require('../src/services/agent-harness/event-stream');

// Minimal wrapTools-compatible tool (no registry needed: wrapTools tolerates a
// null registry via metaFor guard → permissionTier 'auto').
function makeStream() {
  const frames = [];
  const events = createAgentEventStream({ write: async (f) => frames.push(f) });
  return { events, frames };
}

test('a tool exceeding its timeoutMs fails with a clean tool_timeout observation', async () => {
  const { events } = makeStream();
  const slow = {
    name: 'slow_tool',
    timeoutMs: 60, // 60ms budget
    execute: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 5_000)),
  };
  const [wrapped] = events.wrapTools([slow]);
  const started = Date.now();
  await assert.rejects(() => wrapped.execute({}, {}), /tool_timeout.*slow_tool/);
  assert.ok(Date.now() - started < 1_500, 'must reject near the timeout, not wait 5s');
});

test('a fast tool under its budget returns normally', async () => {
  const { events } = makeStream();
  const fast = { name: 'fast_tool', timeoutMs: 5_000, execute: async () => ({ value: 42 }) };
  const [wrapped] = events.wrapTools([fast]);
  assert.deepEqual(await wrapped.execute({}, {}), { value: 42 });
});

test('oversized string result is truncated (record capped) but the tool still returns', async () => {
  const { events, frames } = makeStream();
  const huge = 'x'.repeat(500_000);
  const big = { name: 'big_tool', execute: async () => ({ blob: huge }) };
  const [wrapped] = events.wrapTools([big]);
  const result = await wrapped.execute({}, {});
  // The RETURNED value (what re-enters the model loop) is capped at
  // TOOL_RESULT_MAX_CHARS with the explicit Spanish marker.
  assert.ok(result.blob.length < 260_000, `returned blob should be capped, was ${result.blob.length}`);
  assert.match(result.blob, /truncado/);
  // The persisted tool_result frame is also bounded (existing truncateForRecord).
  const resultFrame = frames.find((f) => f.type === 'tool_result');
  assert.ok(resultFrame, 'tool_result frame emitted');
  assert.ok(JSON.stringify(resultFrame).length < 260_000, 'recorded frame capped');
});
