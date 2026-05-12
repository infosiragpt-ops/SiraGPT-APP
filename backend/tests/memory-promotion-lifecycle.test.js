'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const lifecycle = require('../src/services/sira/memory-promotion-lifecycle');
const {
  scoreTurnForPromotion,
  decidePromotions,
  decayLongTermFacts,
  mergeConflictingFacts,
  PROMOTE_THRESHOLD,
  HARD_FORGET_THRESHOLD,
} = lifecycle;

// ─── scoreTurnForPromotion ───────────────────────────────────────

test('scoreTurnForPromotion: ephemeral turns get skip', () => {
  for (const t of ['Hola', 'Thanks', 'ok', 'bye', 'open file']) {
    const r = scoreTurnForPromotion({ text: t });
    assert.equal(r.decision, 'skip', `expected skip for "${t}", got ${r.decision}`);
  }
});

test('scoreTurnForPromotion: explicit "remember" tag forces promote', () => {
  const r = scoreTurnForPromotion({ text: 'Please remember that my preferred deadline is 2026-08-15.' });
  assert.equal(r.decision, 'promote');
  assert.equal(r.signals.explicitTag, true);
});

test('scoreTurnForPromotion: factual content with dates + names scores higher', () => {
  const r = scoreTurnForPromotion({
    text: 'The contract with Acme Corp. was signed on 2026-03-15 for $1,200,000 USD over 12 months.',
  });
  assert.ok(r.score >= 0.4, `expected score ≥ 0.4, got ${r.score}`);
  assert.ok(r.signals.factual >= 0.5);
});

test('scoreTurnForPromotion: repetition across turns lifts the score', () => {
  const turn = { text: 'The Q3 deadline is 2026-09-30 for the migration project.' };
  const allTurns = [
    turn,
    { text: 'We discussed the migration project and the Q3 deadline.' },
    { text: 'Migration project: confirm the Q3 deadline with the team.' },
  ];
  const solo = scoreTurnForPromotion(turn);
  const withRepetition = scoreTurnForPromotion(turn, { allTurns });
  assert.ok(withRepetition.score > solo.score, `expected lift, got solo=${solo.score} rep=${withRepetition.score}`);
});

test('scoreTurnForPromotion: returns full signal breakdown', () => {
  const r = scoreTurnForPromotion({ text: 'My name is Luis and my deadline is 2026-08-15.' });
  assert.ok('repetitions' in r.signals);
  assert.ok('importance' in r.signals);
  assert.ok('freshness' in r.signals);
  assert.ok('explicitTag' in r.signals);
  assert.ok('factual' in r.signals);
});

// ─── decidePromotions ────────────────────────────────────────────

test('decidePromotions: separates promote / monitor / skip', () => {
  const turns = [
    { text: 'Please remember my email is luis@example.com.' },          // promote
    { text: 'The Q3 deadline is 2026-09-30 and the Q3 deadline must be confirmed' }, // monitor or promote
    { text: 'hello' },                                                    // skip
  ];
  const plan = decidePromotions(turns);
  assert.equal(plan.promote.length, 1);
  assert.equal(plan.skip.length, 1);
  assert.equal(plan.summary.total, 3);
});

test('decidePromotions: skips already-known facts', () => {
  const turns = [{ text: 'My deadline is 2026-08-15 and I always remember important deadlines.' }];
  const existing = [{ text: 'My deadline is 2026-08-15 and I always remember important deadlines.' }];
  const plan = decidePromotions(turns, existing);
  assert.equal(plan.promote.length, 0);
  assert.equal(plan.skip.length, 1);
  assert.match(plan.skip[0].reason, /already/);
});

test('decidePromotions: tolerates empty inputs', () => {
  assert.deepEqual(decidePromotions([]).summary.total, 0);
  assert.deepEqual(decidePromotions(null).summary.total, 0);
});

// ─── decayLongTermFacts ──────────────────────────────────────────

test('decayLongTermFacts: keeps fresh, high-confidence facts', () => {
  const facts = [
    { text: 'Recent fact', confidence: 0.9, timestamp: Date.now() - 86_400_000 }, // 1 day old
  ];
  const r = decayLongTermFacts(facts);
  assert.equal(r.decisions[0].action, 'keep');
});

test('decayLongTermFacts: forgets very old facts', () => {
  const facts = [
    { text: 'Ancient fact', confidence: 0.5, timestamp: Date.now() - 365 * 86_400_000 * 5 }, // 5 years
  ];
  const r = decayLongTermFacts(facts);
  assert.equal(r.decisions[0].action, 'forget');
});

test('decayLongTermFacts: reinforcement boosts confidence', () => {
  const oldTs = Date.now() - 200 * 86_400_000;
  const without = decayLongTermFacts([{ text: 'X', confidence: 0.5, timestamp: oldTs }]);
  const withBoost = decayLongTermFacts([{ text: 'X', confidence: 0.5, timestamp: oldTs, reinforcementCount: 5 }]);
  assert.ok(withBoost.decisions[0].decayedConfidence > without.decisions[0].decayedConfidence);
});

test('decayLongTermFacts: tolerates non-array input', () => {
  const r = decayLongTermFacts(null);
  assert.equal(r.summary.total, 0);
});

// ─── mergeConflictingFacts ─────────────────────────────────────

test('mergeConflictingFacts: prefers most recent for same subject', () => {
  const facts = [
    { subject: 'deadline', value: '2026-08-15', timestamp: '2026-03-01' },
    { subject: 'deadline', value: '2026-09-30', timestamp: '2026-05-01' },
  ];
  const r = mergeConflictingFacts(facts);
  assert.equal(r.kept[0].value, '2026-09-30');
  assert.equal(r.superseded.length, 1);
  assert.equal(r.conflicts.length, 1);
});

test('mergeConflictingFacts: same date breaks tie by confidence', () => {
  const facts = [
    { subject: 'plan', value: 'A', timestamp: '2026-05-01', confidence: 0.6 },
    { subject: 'plan', value: 'B', timestamp: '2026-05-01', confidence: 0.9 },
  ];
  const r = mergeConflictingFacts(facts);
  assert.equal(r.kept[0].value, 'B');
});

test('mergeConflictingFacts: no conflict when values match', () => {
  const facts = [
    { subject: 'name', value: 'Luis', timestamp: '2026-01-01' },
    { subject: 'name', value: 'Luis', timestamp: '2026-05-01' },
  ];
  const r = mergeConflictingFacts(facts);
  assert.equal(r.kept.length, 1);
  assert.equal(r.conflicts.length, 0);
});

test('mergeConflictingFacts: tolerates empty input', () => {
  const r = mergeConflictingFacts(null);
  assert.equal(r.kept.length, 0);
});

// ─── Constants ─────────────────────────────────────────────

test('exported thresholds are numeric and ordered', () => {
  assert.ok(typeof PROMOTE_THRESHOLD === 'number');
  assert.ok(typeof HARD_FORGET_THRESHOLD === 'number');
  assert.ok(PROMOTE_THRESHOLD > HARD_FORGET_THRESHOLD);
});
