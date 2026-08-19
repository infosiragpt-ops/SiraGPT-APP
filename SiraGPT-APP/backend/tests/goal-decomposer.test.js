'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { decomposeGoal, listSkeletons, SKELETONS } = require('../src/services/sira/goal-decomposer');

test('decomposeGoal: returns canonical skeleton per intent id', () => {
  const r = decomposeGoal('analyze_document');
  assert.equal(r.intent_id, 'analyze_document');
  assert.ok(r.steps.length >= 5);
  assert.ok(r.gates.includes('answer_validator'));
});

test('decomposeGoal: resolves aliases (e.g. "research" → research_with_citations)', () => {
  const r = decomposeGoal('research');
  assert.equal(r.intent_id, 'research_with_citations');
});

test('decomposeGoal: resolves common english/spanish aliases', () => {
  assert.equal(decomposeGoal('csv').intent_id, 'data_analysis');
  assert.equal(decomposeGoal('slides').intent_id, 'generate_presentation');
  assert.equal(decomposeGoal('chat').intent_id, 'text_answer');
});

test('decomposeGoal: falls back to general when intent unknown', () => {
  const r = decomposeGoal('totally_made_up_intent_xyz');
  assert.equal(r.intent_id, 'general');
});

test('decomposeGoal: accepts intent object with primary_intent', () => {
  const r = decomposeGoal({ primary_intent: { id: 'generate_code' } });
  assert.equal(r.intent_id, 'generate_code');
});

test('decomposeGoal: accepts intent object with label', () => {
  const r = decomposeGoal({ label: 'compare' });
  assert.equal(r.intent_id, 'compare_documents');
});

test('decomposeGoal: prepends clarify step when unknowns are provided', () => {
  const r = decomposeGoal('analyze_document', { unknowns: ['target_audience'] });
  assert.equal(r.steps[0].type, 'clarify');
  // Entry steps re-anchor to the clarify step
  assert.ok(r.steps[1].depends_on.includes(r.steps[0].id));
});

test('decomposeGoal: skip_clarification removes existing clarify steps', () => {
  const r = decomposeGoal('generate_code', { skip_clarification: true });
  assert.equal(r.steps.filter(s => s.type === 'clarify').length, 0);
});

test('decomposeGoal: each skeleton has structurally valid steps', () => {
  for (const intentId of listSkeletons()) {
    const skel = decomposeGoal(intentId);
    assert.ok(Array.isArray(skel.steps) && skel.steps.length > 0, `intent ${intentId} has no steps`);
    for (const step of skel.steps) {
      assert.ok(step.id, `step missing id in ${intentId}`);
      assert.ok(typeof step.goal === 'string', `step has no goal in ${intentId}`);
      assert.ok(Array.isArray(step.depends_on), `step has no depends_on in ${intentId}`);
    }
  }
});

test('decomposeGoal: returns a deep clone (mutations safe)', () => {
  const r1 = decomposeGoal('analyze_document');
  r1.steps[0].goal = 'mutated';
  const r2 = decomposeGoal('analyze_document');
  assert.notEqual(r2.steps[0].goal, 'mutated');
});

test('listSkeletons: returns expected intents', () => {
  const list = listSkeletons();
  for (const expected of ['analyze_document', 'compare_documents', 'generate_code', 'research_with_citations', 'data_analysis', 'generate_presentation', 'agent_long_running_task', 'general']) {
    assert.ok(list.includes(expected), `missing ${expected}`);
  }
});

test('SKELETONS catalog: each entry declares gates + estimated_calls', () => {
  for (const [key, skel] of Object.entries(SKELETONS)) {
    assert.ok(Array.isArray(skel.gates), `${key}: missing gates`);
    assert.ok(typeof skel.estimated_calls === 'number', `${key}: missing estimated_calls`);
  }
});

test('decomposeGoal: skeletons are plan-critic-clean (no cycles, has terminal)', () => {
  const { critiquePlan } = require('../src/services/sira/plan-critic');
  for (const intentId of listSkeletons()) {
    const skel = decomposeGoal(intentId);
    // Add dummy tool_registry covering all referenced tools so we don't get
    // missing_tool warnings from the cross-test
    const tools = skel.steps.map(s => s.tool).filter(Boolean);
    const r = critiquePlan({
      ...skel,
      tool_registry: tools,
    });
    assert.notEqual(r.severity, 'blocking', `skeleton ${intentId} is blocking: ${JSON.stringify(r.issues.map(i => i.code))}`);
  }
});

test('decomposeGoal: tolerates null / undefined input', () => {
  assert.equal(decomposeGoal(null).intent_id, 'general');
  assert.equal(decomposeGoal(undefined).intent_id, 'general');
});
