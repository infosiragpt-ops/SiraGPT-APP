'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyPromotionPlan, runDecayAndMerge, buildBatchCycle } = require('../src/services/sira/memory-promotion-applier');

function makeAdapter(initial = {}) {
  const turns = initial.turns || [];
  const facts = new Map(initial.facts ? initial.facts.map(f => [f.key, f]) : []);
  const log = [];
  return {
    log,
    turns,
    facts,
    listTurns: async () => turns,
    listFacts: async () => Array.from(facts.values()),
    setFact: async (userId, key, value) => {
      log.push({ op: 'setFact', userId, key });
      facts.set(key, { key, ...value });
      return { key, ...value };
    },
    deleteFact: async (userId, key) => {
      log.push({ op: 'deleteFact', userId, key });
      facts.delete(key);
    },
  };
}

test('applyPromotionPlan: promotes explicit "remember" turns into setFact calls', async () => {
  const adapter = makeAdapter({
    turns: [
      { text: 'Please remember that my preferred delivery time is 2026-08-15.' },
      { text: 'hello' },
    ],
  });
  const out = await applyPromotionPlan(adapter, 'u1');
  assert.equal(out.ok, true);
  assert.ok(out.applied >= 1);
  assert.ok(adapter.log.some(l => l.op === 'setFact'));
});

test('applyPromotionPlan: tolerates missing adapter / userId', async () => {
  assert.equal((await applyPromotionPlan(null, 'u1')).ok, false);
  assert.equal((await applyPromotionPlan({}, null)).ok, false);
});

test('applyPromotionPlan: records errors when adapter throws', async () => {
  const adapter = {
    listTurns: async () => { throw new Error('db down'); },
  };
  const out = await applyPromotionPlan(adapter, 'u1');
  assert.equal(out.ok, false);
  assert.match(out.error, /listTurns/);
});

test('applyPromotionPlan: skips when adapter.setFact is missing', async () => {
  const adapter = {
    listTurns: async () => [{ text: 'Please remember the deadline 2026-08-15 for the project.' }],
    listFacts: async () => [],
  };
  const out = await applyPromotionPlan(adapter, 'u1');
  assert.ok(out.audit?.errors?.length >= 1);
});

// Decay is computed against a wall-clock `now`; pin it so these cases
// never depend on the date the suite runs (they broke on 2026-08-12 when
// a fixed 2026-03-01 fact finally decayed below HARD_FORGET_THRESHOLD).
const FIXED_NOW = Date.parse('2026-06-01T00:00:00Z');

test('runDecayAndMerge: forgets ancient facts via deleteFact', async () => {
  const adapter = makeAdapter({
    facts: [
      // 5 years before the pinned clock → far past HARD_FORGET_THRESHOLD
      { key: 'k1', text: 'fact', confidence: 0.4, timestamp: FIXED_NOW - 5 * 365 * 86_400_000 },
    ],
  });
  const out = await runDecayAndMerge(adapter, 'u1', { now: FIXED_NOW });
  assert.equal(out.ok, true);
  assert.equal(out.applied.forgotten, 1);
  assert.ok(adapter.log.some(l => l.op === 'deleteFact'));
});

test('runDecayAndMerge: keeps fresh facts', async () => {
  const adapter = makeAdapter({
    facts: [
      { key: 'k1', text: 'recent', confidence: 0.9, timestamp: FIXED_NOW - 86_400_000 },
    ],
  });
  const out = await runDecayAndMerge(adapter, 'u1', { now: FIXED_NOW });
  assert.equal(out.applied.forgotten, 0);
});

test('runDecayAndMerge: merges conflicting facts (drops older)', async () => {
  const adapter = makeAdapter({
    facts: [
      { key: 'k1', subject: 'deadline', value: '2026-08-15', timestamp: '2026-03-01T00:00:00Z' },
      { key: 'k2', subject: 'deadline', value: '2026-09-30', timestamp: '2026-05-01T00:00:00Z' },
    ],
  });
  // Both timestamps sit 1-3 months before the pinned clock, well above the
  // forget threshold, so both survive decay and the merge sees both.
  const out = await runDecayAndMerge(adapter, 'u1', { now: FIXED_NOW });
  assert.equal(out.applied.mergedSuperseded, 1);
});

test('runDecayAndMerge: tolerates empty fact list', async () => {
  const adapter = makeAdapter();
  const out = await runDecayAndMerge(adapter, 'u1');
  assert.equal(out.ok, true);
  assert.equal(out.applied.forgotten, 0);
});

test('buildBatchCycle: returns promotion + lifecycle reports + summary', async () => {
  const adapter = makeAdapter({
    turns: [{ text: 'Please remember the deadline 2026-08-15.' }],
    facts: [{ key: 'k1', text: 'old', confidence: 0.3, timestamp: Date.now() - 5 * 365 * 86_400_000 }],
  });
  const out = await buildBatchCycle(adapter, 'u1');
  assert.ok(out.promotion);
  assert.ok(out.lifecycle);
  assert.ok(out.summary);
  assert.equal(typeof out.duration_ms, 'number');
});
