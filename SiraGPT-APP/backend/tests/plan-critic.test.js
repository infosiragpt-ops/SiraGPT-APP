'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { critiquePlan, suggestRepairs } = require('../src/services/sira/plan-critic');

// ─── Shape resilience ──────────────────────────────────────────

test('critiquePlan: rejects null / non-object', () => {
  const r = critiquePlan(null);
  assert.equal(r.severity, 'blocking');
  assert.equal(r.verdict, 'reject');
});

test('critiquePlan: rejects plan with no steps array', () => {
  const r = critiquePlan({ intent: 'foo' });
  assert.equal(r.severity, 'blocking');
});

// ─── Clean plan ─────────────────────────────────────────────────

test('critiquePlan: accepts a well-formed linear plan', () => {
  const plan = {
    steps: [
      { id: 's1', goal: 'ingest', depends_on: [], produces: ['raw'] },
      { id: 's2', goal: 'analyze', depends_on: ['s1'], produces: ['analysis'] },
      { id: 's3', goal: 'validate', depends_on: ['s2'], type: 'validate' },
      { id: 's4', goal: 'respond', depends_on: ['s3'], produces: ['final_answer'], acceptance: 'validators pass' },
    ],
  };
  const r = critiquePlan(plan);
  assert.equal(r.verdict, 'accept', `issues: ${JSON.stringify(r.issues.map(i => i.code))}`);
  assert.equal(r.summary.blocking_count, 0);
});

// ─── Structural defects ─────────────────────────────────────────

test('critiquePlan: flags missing initial step', () => {
  const plan = {
    steps: [
      { id: 's1', goal: 'a', depends_on: ['s2'] },
      { id: 's2', goal: 'b', depends_on: ['s1'] }, // cycle, no entry
    ],
  };
  const r = critiquePlan(plan);
  assert.ok(r.issues.some(i => i.code === 'missing_initial_step' || i.code === 'circular_dependency'));
});

test('critiquePlan: flags circular dependency', () => {
  const plan = {
    steps: [
      { id: 'a', goal: 'A', depends_on: ['c'] },
      { id: 'b', goal: 'B', depends_on: ['a'] },
      { id: 'c', goal: 'C', depends_on: ['b'] },
    ],
  };
  const r = critiquePlan(plan);
  assert.ok(r.issues.some(i => i.code === 'circular_dependency'));
  assert.equal(r.severity, 'blocking');
});

test('critiquePlan: flags duplicate ids', () => {
  const plan = {
    steps: [
      { id: 's1', goal: 'a', depends_on: [] },
      { id: 's1', goal: 'b', depends_on: ['s1'] },
    ],
  };
  const r = critiquePlan(plan);
  assert.ok(r.issues.some(i => i.code === 'duplicate_id'));
});

test('critiquePlan: flags duplicate goals', () => {
  const plan = {
    steps: [
      { id: 's1', goal: 'analyze the document', depends_on: [] },
      { id: 's2', goal: 'analyze the document', depends_on: ['s1'] },
    ],
  };
  const r = critiquePlan(plan);
  assert.ok(r.issues.some(i => i.code === 'duplicate_step'));
});

test('critiquePlan: flags orphan steps', () => {
  const plan = {
    steps: [
      { id: 's1', goal: 'main entry', depends_on: [] },
      { id: 's2', goal: 'orphan', depends_on: [] }, // entry but never produced/depended on
      { id: 's3', goal: 'finish', depends_on: ['s1'], produces: ['final'] },
    ],
  };
  const r = critiquePlan(plan);
  assert.ok(r.issues.some(i => i.code === 'orphan_step'));
});

test('critiquePlan: flags missing tool when registry is supplied', () => {
  const plan = {
    steps: [
      { id: 's1', goal: 'search', tool: 'phantom_tool', depends_on: [] },
      { id: 's2', goal: 'respond', depends_on: ['s1'], produces: ['final_answer'], acceptance: 'ok' },
    ],
    tool_registry: ['web_search', 'rag_search'],
  };
  const r = critiquePlan(plan);
  assert.ok(r.issues.some(i => i.code === 'missing_tool'));
});

test('critiquePlan: flags missing validation gate after artifact production', () => {
  const plan = {
    steps: [
      { id: 's1', goal: 'plan', depends_on: [] },
      { id: 's2', goal: 'generate', depends_on: ['s1'], produces: ['code_artifact'] },
      { id: 's3', goal: 'respond', depends_on: ['s2'], produces: ['final_answer'], acceptance: 'ok' },
    ],
  };
  const r = critiquePlan(plan);
  assert.ok(r.issues.some(i => i.code === 'missing_validation_gate'));
});

test('critiquePlan: flags missing clarification when intent has unknowns', () => {
  const plan = {
    steps: [
      { id: 's1', goal: 'execute', depends_on: [] },
      { id: 's2', goal: 'respond', depends_on: ['s1'], produces: ['final_answer'], acceptance: 'ok' },
    ],
    intent: { primary_intent: 'analyze', unknowns: ['target_audience', 'deadline'] },
  };
  const r = critiquePlan(plan);
  assert.ok(r.issues.some(i => i.code === 'missing_clarification'));
});

test('critiquePlan: flags excessive parallelism', () => {
  const branches = Array.from({ length: 8 }, (_, i) => ({
    id: `b${i}`, goal: `parallel ${i}`, depends_on: ['root'], parallel_group: 'g1',
  }));
  const plan = {
    steps: [
      { id: 'root', goal: 'fan-out', depends_on: [] },
      ...branches,
      { id: 'join', goal: 'join', depends_on: branches.map(b => b.id), produces: ['final_answer'], acceptance: 'ok' },
    ],
  };
  const r = critiquePlan(plan);
  assert.ok(r.issues.some(i => i.code === 'excessive_parallelism'));
});

test('critiquePlan: flags excessive depth', () => {
  const steps = [];
  steps.push({ id: 's0', goal: 'entry', depends_on: [] });
  for (let i = 1; i < 15; i++) {
    steps.push({ id: `s${i}`, goal: `step ${i}`, depends_on: [`s${i - 1}`] });
  }
  steps.push({ id: 'final', goal: 'respond', depends_on: ['s14'], produces: ['final_answer'], acceptance: 'ok' });
  const r = critiquePlan({ steps });
  assert.ok(r.issues.some(i => i.code === 'excessive_depth'));
});

test('critiquePlan: flags missing acceptance test on terminal output step', () => {
  const plan = {
    steps: [
      { id: 's1', goal: 'work', depends_on: [] },
      { id: 's2', goal: 'finish', depends_on: ['s1'], produces: ['final_answer'] },
    ],
  };
  const r = critiquePlan(plan);
  assert.ok(r.issues.some(i => i.code === 'missing_acceptance_test'));
});

// ─── Repairs ─────────────────────────────────────────────────

test('suggestRepairs: returns actionable sentences for each issue', () => {
  const r = critiquePlan({
    steps: [
      { id: 's1', goal: 'a', depends_on: ['s2'] },
      { id: 's2', goal: 'b', depends_on: ['s1'] },
    ],
  });
  const tips = suggestRepairs(r);
  assert.ok(tips.length > 0);
  for (const t of tips) {
    assert.ok(typeof t === 'string' && t.length > 0);
  }
});

test('suggestRepairs: empty array for clean report', () => {
  const r = critiquePlan({
    steps: [
      { id: 's1', goal: 'entry', depends_on: [] },
      { id: 's2', goal: 'finish', depends_on: ['s1'], produces: ['final_answer'], acceptance: 'ok' },
    ],
  });
  assert.equal(suggestRepairs(r).length, 0);
});

test('suggestRepairs: tolerates null', () => {
  assert.deepEqual(suggestRepairs(null), []);
});
