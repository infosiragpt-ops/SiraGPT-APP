/**
 * agent-entry tests — we focus on the guarantees that do not require
 * a real OpenAI client or database:
 *
 *   - depth guard against runaway session_spawn chains
 *   - basic input validation
 *   - MAX_SPAWN_DEPTH is exported so skills can reason about it
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runAgent, MAX_SPAWN_DEPTH } = require('../src/services/agents/agent-entry');

test('MAX_SPAWN_DEPTH is a sane positive integer', () => {
  assert.equal(typeof MAX_SPAWN_DEPTH, 'number');
  assert.ok(MAX_SPAWN_DEPTH >= 2 && MAX_SPAWN_DEPTH <= 10,
    `expected 2..10 to prevent runaway spawns; got ${MAX_SPAWN_DEPTH}`);
});

test('runAgent rejects missing userId', async () => {
  await assert.rejects(() => runAgent({ prompt: 'hi' }), /userId required/);
});

test('runAgent rejects missing prompt', async () => {
  await assert.rejects(() => runAgent({ userId: 'u1' }), /prompt required/);
});

test('runAgent rejects depth over MAX_SPAWN_DEPTH', async () => {
  // Point OPENAI_API_KEY so the earlier check doesn't short-circuit
  // the guard we want to test.
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-fake';
  try {
    await assert.rejects(
      () => runAgent({ userId: 'u1', prompt: 'hi', depth: MAX_SPAWN_DEPTH + 1 }),
      new RegExp(`spawn depth ${MAX_SPAWN_DEPTH + 1} exceeds max`),
    );
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  }
});
