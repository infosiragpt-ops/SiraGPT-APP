'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Capture real registry methods so we can mutate + restore between tests.
const skillsRegistry = require('../src/services/skills-registry');
const realListSkills = skillsRegistry.listSkills;
const realRecommendSkills = skillsRegistry.recommendSkills;

const {
  TOOL_ALIASES,
  resolveToolNames,
  getSkillManifests,
  recommendToolsForIntent,
} = require('../src/services/skill-tool-adapter');

async function withRegistryStubs({ list, recommend }, run) {
  if (list) skillsRegistry.listSkills = list;
  if (recommend) skillsRegistry.recommendSkills = recommend;
  try { return await run(); }
  finally {
    skillsRegistry.listSkills = realListSkills;
    skillsRegistry.recommendSkills = realRecommendSkills;
  }
}

test('exports the documented surface', () => {
  assert.equal(typeof TOOL_ALIASES, 'object');
  assert.equal(typeof resolveToolNames, 'function');
  assert.equal(typeof getSkillManifests, 'function');
  assert.equal(typeof recommendToolsForIntent, 'function');
});

test('TOOL_ALIASES maps multiple abstract names onto the same concrete tool', () => {
  // Concrete tool python_exec is the target for several abstract names.
  assert.equal(TOOL_ALIASES.code_sandbox, 'python_exec');
  assert.equal(TOOL_ALIASES.generate_code, 'python_exec');
  assert.equal(TOOL_ALIASES.generate_tests, 'python_exec');
  assert.equal(TOOL_ALIASES.static_check, 'python_exec');
  assert.equal(TOOL_ALIASES.test_runner, 'python_exec');
});

test('resolveToolNames deduplicates abstract tools that map to the same concrete tool', () => {
  const out = resolveToolNames(['code_sandbox', 'generate_code', 'static_check']);
  assert.deepEqual(out, ['python_exec']);
});

test('resolveToolNames silently drops unknown abstract tools', () => {
  const out = resolveToolNames(['rag_retrieve', 'totally_made_up_tool', 'web_search']);
  assert.deepEqual(out.sort(), ['rag_retrieve', 'web_search'].sort());
});

test('resolveToolNames returns [] for non-array input', () => {
  assert.deepEqual(resolveToolNames(null), []);
  assert.deepEqual(resolveToolNames(undefined), []);
  assert.deepEqual(resolveToolNames('not-an-array'), []);
  assert.deepEqual(resolveToolNames({}), []);
});

test('resolveToolNames maps fetch_url to web_search (alias consolidation)', () => {
  assert.deepEqual(resolveToolNames(['fetch_url']), ['web_search']);
});

test('getSkillManifests builds one manifest per skill with the expected shape', async () => {
  await withRegistryStubs({
    list: () => [
      {
        id: 'deep_analyze',
        label: 'Deep Document Analysis',
        description: 'Performs deep semantic analysis of an uploaded document.',
        tools: ['deep_document_analyzer', 'document_intelligence'],
        clearance: 'paid',
        category: 'document',
        sideEffects: ['outbound_http_requests'],
        examples: [{ when: 'user uploads a thesis chapter', call: 'analyze chapter' }],
        estimatedCost: { latencyMsP95: 8000, toolCalls: 2 },
        prerequisites: ['document'],
        idempotent: false,
      },
    ],
  }, async () => {
    const manifests = getSkillManifests();
    const m = manifests.skill_deep_analyze;
    assert.ok(m, 'manifest must exist for the registered skill');
    assert.equal(m.name, 'skill_deep_analyze');
    assert.match(m.purpose, /Deep Document Analysis/);
    assert.equal(m.inputs.required[0], 'query');
    assert.equal(m.usage_limits.timeout_ms_default, 8000);
    assert.equal(m.usage_limits.requires_auth, true, 'paid clearance must require auth');
    assert.equal(m.usage_limits.requires_network, true, 'outbound_http_requests must flag requires_network');
    assert.equal(m._skillMeta.skillId, 'deep_analyze');
    // Both abstract tools map to deep_analyze + docintel_analyze
    assert.ok(m._skillMeta.concreteTools.includes('deep_analyze') || m._skillMeta.concreteTools.includes('docintel_analyze'));
    assert.deepEqual(m.scopes, ['paid']);
  });
});

test('getSkillManifests uses default timeout 10000 + max_calls 5 when estimatedCost is missing', async () => {
  await withRegistryStubs({
    list: () => [
      {
        id: 'simple_skill',
        label: 'Simple',
        description: 'desc',
        tools: ['rag_retrieve'],
        clearance: 'public',
        category: 'information',
        sideEffects: [],
        examples: [],
        prerequisites: [],
        idempotent: true,
      },
    ],
  }, async () => {
    const m = getSkillManifests().skill_simple_skill;
    assert.equal(m.usage_limits.timeout_ms_default, 10000);
    assert.equal(m.usage_limits.max_calls_per_task, 5);
    assert.equal(m.usage_limits.requires_auth, false, 'public clearance must NOT require auth');
    assert.equal(m.usage_limits.requires_network, false);
    assert.equal(m.side_effect_level, 'none');
  });
});

test('getSkillManifests synthesises an example when the skill has none', async () => {
  await withRegistryStubs({
    list: () => [
      {
        id: 'no_examples',
        label: 'No Examples',
        description: 'd',
        tools: ['rag_retrieve'],
        clearance: 'public',
        category: 'information',
        sideEffects: [],
        examples: [],
        prerequisites: [],
        idempotent: true,
      },
    ],
  }, async () => {
    const m = getSkillManifests().skill_no_examples;
    assert.equal(m.examples_positive.length, 1);
    assert.match(m.examples_positive[0].when, /No Examples/);
  });
});

test('getSkillManifests scopes enterprise skills onto the enterprise scope', async () => {
  await withRegistryStubs({
    list: () => [
      { id: 'ent', label: 'Ent', description: 'd', tools: [], clearance: 'enterprise', category: 'agentic', sideEffects: [], examples: [], prerequisites: [], idempotent: true },
    ],
  }, async () => {
    const m = getSkillManifests().skill_ent;
    assert.deepEqual(m.scopes, ['enterprise']);
  });
});

test('recommendToolsForIntent returns recommended skills + the union of their concrete tools', async () => {
  await withRegistryStubs({
    recommend: () => [
      { id: 'a', label: 'A', score: 0.9, tools: ['code_sandbox', 'generate_code'] },
      { id: 'b', label: 'B', score: 0.7, tools: ['web_search', 'fetch_url'] },
    ],
  }, async () => {
    const out = recommendToolsForIntent('debug my code and fetch docs');
    assert.equal(out.recommendedSkills.length, 2);
    assert.equal(out.recommendedSkills[0].id, 'a');
    // The two code_sandbox/generate_code aliases collapse onto python_exec;
    // the two web_search/fetch_url aliases collapse onto web_search.
    assert.deepEqual(out.concreteTools.sort(), ['python_exec', 'web_search'].sort());
  });
});

test('recommendToolsForIntent returns empty arrays when registry recommends nothing', async () => {
  await withRegistryStubs({ recommend: () => [] }, async () => {
    const out = recommendToolsForIntent('hello world');
    assert.deepEqual(out.recommendedSkills, []);
    assert.deepEqual(out.concreteTools, []);
  });
});
