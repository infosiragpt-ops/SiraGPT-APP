'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  listSkills,
  getSkill,
  recommendedSkills,
  verifyPrerequisites,
  checkIdempotencyKey,
  SKILLS,
  INTENT_SKILLS,
} = require('../src/services/sira/agent-skill-registry');

test('listSkills: returns expected ids', () => {
  const ids = listSkills();
  for (const expected of ['rag_grounded_qa', 'web_research_with_citations', 'document_professional_analysis', 'cross_document_comparison', 'code_generation_with_tests', 'presentation_from_brief', 'data_summary_with_viz', 'image_generation', 'long_running_task', 'conversational_answer']) {
    assert.ok(ids.includes(expected), `missing ${expected}`);
  }
});

test('getSkill: returns descriptor with required fields', () => {
  const s = getSkill('rag_grounded_qa');
  assert.ok(s);
  for (const field of ['id', 'label', 'category', 'tools_used', 'prerequisites', 'acceptance', 'estimated_cost', 'clearance']) {
    assert.ok(field in s, `missing field ${field}`);
  }
});

test('getSkill: returns null for unknown id', () => {
  assert.equal(getSkill('does_not_exist'), null);
  assert.equal(getSkill(null), null);
  assert.equal(getSkill(123), null);
});

test('recommendedSkills: returns candidates by intent', () => {
  const skills = recommendedSkills('text_answer');
  assert.ok(skills.length >= 1);
  assert.ok(skills.some(s => s.id === 'conversational_answer'));
});

test('recommendedSkills: filters by clearance', () => {
  const skills = recommendedSkills('generate_presentation', { user_clearance: 'authenticated' });
  // presentation_from_brief requires 'paid' clearance → should be filtered out
  assert.ok(!skills.some(s => s.id === 'presentation_from_brief'));
});

test('recommendedSkills: filters by max_llm_calls budget', () => {
  const skills = recommendedSkills('generate_code', { max_llm_calls: 1 });
  // code_generation_with_tests is 3 llm_calls → out of budget
  assert.ok(!skills.some(s => s.id === 'code_generation_with_tests'));
});

test('recommendedSkills: filters by max_latency_ms', () => {
  const skills = recommendedSkills('agent_long_running_task', { max_latency_ms: 5000 });
  // long_running_task p95 is 120s → out
  assert.ok(!skills.some(s => s.id === 'long_running_task'));
});

test('recommendedSkills: respects web_access_enabled=false', () => {
  const skills = recommendedSkills('research_with_citations', { web_access_enabled: false });
  // web_research_with_citations has outbound_http_requests as side effect
  assert.ok(!skills.some(s => s.id === 'web_research_with_citations'));
});

test('recommendedSkills: falls back to general intent when unknown', () => {
  const skills = recommendedSkills('totally_unknown_intent_xyz');
  assert.ok(skills.length >= 1);
});

// ─── Prerequisites ──────────────────────────────────

test('verifyPrerequisites: ok when all are present', () => {
  const s = getSkill('rag_grounded_qa');
  const r = verifyPrerequisites(s, {
    collection_indexed: true,
    query_text: 'something',
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
});

test('verifyPrerequisites: lists missing prerequisites', () => {
  const s = getSkill('code_generation_with_tests');
  const r = verifyPrerequisites(s, {});
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes('language_known'));
  assert.ok(r.missing.includes('target_environment'));
});

test('verifyPrerequisites: tolerates null skill', () => {
  const r = verifyPrerequisites(null, {});
  assert.equal(r.ok, true);
});

// ─── Idempotency keys ──────────────────────────────

test('checkIdempotencyKey: stable across argument order', () => {
  const skill = getSkill('rag_grounded_qa');
  const k1 = checkIdempotencyKey(skill, { query: 'X', userId: 'u1' });
  const k2 = checkIdempotencyKey(skill, { userId: 'u1', query: 'X' });
  assert.equal(k1, k2);
});

test('checkIdempotencyKey: null for non-idempotent skills', () => {
  const skill = getSkill('code_generation_with_tests');
  const k = checkIdempotencyKey(skill, { lang: 'ts' });
  assert.equal(k, null);
});

// ─── Catalog consistency ────────────────────────

test('SKILLS catalog: every entry has the required fields', () => {
  const required = ['id', 'label', 'category', 'description', 'tools_used', 'prerequisites', 'side_effects', 'idempotent', 'acceptance', 'estimated_cost', 'clearance', 'failure_recovery', 'output_kind'];
  for (const [id, s] of Object.entries(SKILLS)) {
    for (const f of required) {
      assert.ok(f in s, `skill ${id} missing field ${f}`);
    }
    assert.ok(Array.isArray(s.tools_used));
    assert.ok(Array.isArray(s.prerequisites));
    assert.ok(Array.isArray(s.side_effects));
    assert.equal(typeof s.idempotent, 'boolean');
    assert.ok(['text', 'artifact', 'pair'].includes(s.output_kind));
  }
});

test('INTENT_SKILLS: each referenced skill exists in catalog', () => {
  for (const [intent, ids] of Object.entries(INTENT_SKILLS)) {
    for (const id of ids) {
      assert.ok(SKILLS[id], `intent ${intent} references missing skill ${id}`);
    }
  }
});

test('SKILLS catalog: estimated_cost has required numeric fields', () => {
  for (const [id, s] of Object.entries(SKILLS)) {
    assert.equal(typeof s.estimated_cost.llm_calls, 'number', `${id}: bad llm_calls`);
    assert.equal(typeof s.estimated_cost.tool_calls, 'number', `${id}: bad tool_calls`);
    assert.equal(typeof s.estimated_cost.latency_ms_p95, 'number', `${id}: bad latency_ms_p95`);
  }
});
