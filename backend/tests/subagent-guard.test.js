'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const guard = require('../src/services/agents/subagent-guard');

const ENV_KEYS = ['SIRAGPT_LIVE_SUBAGENTS', 'SIRAGPT_LIVE_SPAWN_BUDGET'];
const saved = {};

test.beforeEach(() => { ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }); });
test.afterEach(() => { ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

test('liveSubagentsEnabled is OFF by default and parses truthy flags', () => {
  assert.equal(guard.liveSubagentsEnabled(), false);
  for (const v of ['1', 'true', 'on', 'YES', 'True']) {
    process.env.SIRAGPT_LIVE_SUBAGENTS = v;
    assert.equal(guard.liveSubagentsEnabled(), true, `${v} should enable`);
  }
  for (const v of ['0', 'false', 'off', '', 'nope']) {
    process.env.SIRAGPT_LIVE_SUBAGENTS = v;
    assert.equal(guard.liveSubagentsEnabled(), false, `${v} should stay disabled`);
  }
});

test('spawnBudget defaults to 2 and honours a valid env override', () => {
  assert.equal(guard.spawnBudget(), guard.DEFAULT_SPAWN_BUDGET);
  process.env.SIRAGPT_LIVE_SPAWN_BUDGET = '5';
  assert.equal(guard.spawnBudget(), 5);
  process.env.SIRAGPT_LIVE_SPAWN_BUDGET = 'not-a-number';
  assert.equal(guard.spawnBudget(), guard.DEFAULT_SPAWN_BUDGET, 'invalid falls back to default');
  process.env.SIRAGPT_LIVE_SPAWN_BUDGET = '0';
  assert.equal(guard.spawnBudget(), 0, 'zero budget is allowed (blocks all)');
});

test('reserveSpawn allows within budget and increments the per-turn counter', () => {
  process.env.SIRAGPT_LIVE_SPAWN_BUDGET = '2';
  const ctx = { userId: 'u1', depth: 0 };

  const a = guard.reserveSpawn(ctx);
  assert.equal(a.allowed, true);
  assert.equal(ctx._liveSpawnCount, 1);

  const b = guard.reserveSpawn(ctx);
  assert.equal(b.allowed, true);
  assert.equal(ctx._liveSpawnCount, 2);

  const c = guard.reserveSpawn(ctx);
  assert.equal(c.allowed, false, 'third spawn exceeds the budget of 2');
  assert.match(c.reason, /budget/i);
  assert.equal(ctx._liveSpawnCount, 2, 'blocked attempt does not increment');
});

test('reserveSpawn refuses to recurse at or beyond max depth', () => {
  const maxDepth = guard.maxSpawnDepth();
  assert.ok(maxDepth >= 1);
  const ctx = { userId: 'u1', depth: maxDepth };
  const out = guard.reserveSpawn(ctx);
  assert.equal(out.allowed, false);
  assert.match(out.reason, /depth/i);
  assert.equal(ctx._liveSpawnCount, undefined, 'depth-blocked attempt reserves nothing');
});

test('reserveSpawn with budget 0 blocks every spawn', () => {
  process.env.SIRAGPT_LIVE_SPAWN_BUDGET = '0';
  const out = guard.reserveSpawn({ userId: 'u1', depth: 0 });
  assert.equal(out.allowed, false);
  assert.match(out.reason, /budget/i);
});
