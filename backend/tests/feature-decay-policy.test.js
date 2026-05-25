'use strict';

const test = require('node:test');
const assert = require('node:assert');

const policy = require('../src/services/feature-decay-policy');

test('halfLifeMsFor: known kinds return the table value', () => {
  assert.strictEqual(policy.halfLifeMsFor('constraint'), policy.POLICIES.constraint);
  assert.strictEqual(policy.halfLifeMsFor('urgency'), policy.POLICIES.urgency);
  assert.strictEqual(policy.halfLifeMsFor('topic'), policy.POLICIES.topic);
});

test('halfLifeMsFor: unknown kind returns the default', () => {
  assert.strictEqual(policy.halfLifeMsFor('nonexistent'), policy.DEFAULT_HALF_LIFE_MS);
  assert.strictEqual(policy.halfLifeMsFor(null), policy.DEFAULT_HALF_LIFE_MS);
  assert.strictEqual(policy.halfLifeMsFor(undefined), policy.DEFAULT_HALF_LIFE_MS);
});

test('halfLifeMsFor: namespaced kind falls back to base', () => {
  assert.strictEqual(policy.halfLifeMsFor('topic.token'), policy.POLICIES.topic);
});

test('decay: zero ageMs returns full strength', () => {
  assert.strictEqual(policy.decay(0.8, 0, 'topic'), 0.8);
  assert.strictEqual(policy.decay(0.8, -100, 'topic'), 0.8);
});

test('decay: at one half-life returns half strength', () => {
  const hl = policy.POLICIES.topic;
  const result = policy.decay(1, hl, 'topic');
  assert.ok(result > 0.49 && result < 0.51);
});

test('decay: constraint kind decays slower than urgency kind', () => {
  const oneHour = 60 * 60 * 1000;
  const constraintAtHour = policy.decay(1, oneHour, 'constraint');
  const urgencyAtHour = policy.decay(1, oneHour, 'urgency');
  assert.ok(constraintAtHour > urgencyAtHour);
  assert.ok(urgencyAtHour < 0.01);
  assert.ok(constraintAtHour > 0.99);
});

test('decay: strength=0 stays 0', () => {
  assert.strictEqual(policy.decay(0, 1_000_000, 'topic'), 0);
});

test('decay: result always in [0, 1]', () => {
  for (const kind of Object.keys(policy.POLICIES)) {
    const r = policy.decay(0.5, 1_000_000, kind);
    assert.ok(r >= 0 && r <= 1);
  }
});

test('classifyKind: constraint = sticky, topic = normal, urgency = transient', () => {
  assert.strictEqual(policy.classifyKind('constraint'), 'sticky');
  assert.strictEqual(policy.classifyKind('topic'), 'normal');
  assert.strictEqual(policy.classifyKind('urgency'), 'transient');
});

test('classifyKind: code_language = persistent (≥ 2h half-life)', () => {
  assert.strictEqual(policy.classifyKind('code_language'), 'persistent');
});

test('classifyKind: unknown kind uses default → normal', () => {
  const result = policy.classifyKind('nonexistent');
  assert.ok(['normal', 'transient'].includes(result));
});

test('listPolicies returns every kind with metadata', () => {
  const list = policy.listPolicies();
  const kinds = list.map((p) => p.kind);
  assert.ok(kinds.includes('constraint'));
  assert.ok(kinds.includes('topic'));
  assert.ok(kinds.includes('urgency'));
  for (const entry of list) {
    assert.ok(typeof entry.halfLifeMs === 'number');
    assert.ok(typeof entry.halfLifeHuman === 'string');
    assert.ok(['sticky', 'persistent', 'normal', 'transient'].includes(entry.classification));
  }
});

test('humaniseMs returns human-readable strings', () => {
  assert.strictEqual(policy.humaniseMs(60 * 1000), '1min');
  assert.strictEqual(policy.humaniseMs(2 * 60 * 60 * 1000), '2h');
  assert.strictEqual(policy.humaniseMs(3 * 24 * 60 * 60 * 1000), '3d');
});

test('relative-ordering: sentiment < topic < entity < constraint', () => {
  assert.ok(policy.POLICIES.sentiment < policy.POLICIES.topic);
  assert.ok(policy.POLICIES.topic < policy.POLICIES.entity);
  assert.ok(policy.POLICIES.entity < policy.POLICIES.constraint);
});

test('POLICIES is frozen', () => {
  assert.throws(() => { policy.POLICIES.constraint = 1; });
});
