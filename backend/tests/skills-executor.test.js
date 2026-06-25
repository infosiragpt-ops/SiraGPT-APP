'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Capture the real registry methods so we can restore them between tests.
// We mutate the same exports object the executor already holds a reference
// to, then put each method back in a finally block. This avoids the
// "stub doesn't propagate because the consumer captured a stale reference"
// trap of using require.cache to swap whole exports objects.
const skillsRegistry = require('../src/services/skills-registry');
const realGetSkill = skillsRegistry.getSkill;
const realVerifyPrerequisites = skillsRegistry.verifyPrerequisites;
const realRecommendSkills = skillsRegistry.recommendSkills;

const activeMemory = require('../src/services/active-memory');
const realRecall = activeMemory.recall;

async function withRegistryStubs({ skills = {}, prereq = null, recommend = [] }, run) {
  skillsRegistry.getSkill = (id) => skills[id] || null;
  skillsRegistry.verifyPrerequisites = () => prereq;
  skillsRegistry.recommendSkills = () => recommend;
  try { return await run(); }
  finally {
    skillsRegistry.getSkill = realGetSkill;
    skillsRegistry.verifyPrerequisites = realVerifyPrerequisites;
    skillsRegistry.recommendSkills = realRecommendSkills;
  }
}

async function withMemoryStub(stub, run) {
  activeMemory.recall = stub;
  try { return await run(); }
  finally { activeMemory.recall = realRecall; }
}

// Now load the executor (under real deps); behaviour is then driven via
// the stubs above which mutate the same exports objects the executor holds.
const { executeSkill, executeRecommendedSkills, HANDLERS } = require('../src/services/skills-executor');

test('exports executeSkill + executeRecommendedSkills + HANDLERS', () => {
  assert.equal(typeof executeSkill, 'function');
  assert.equal(typeof executeRecommendedSkills, 'function');
  assert.equal(typeof HANDLERS, 'object');
  assert.equal(typeof HANDLERS.deep_document_analysis, 'function');
  assert.equal(typeof HANDLERS.auto_file_analysis, 'function');
  assert.equal(typeof HANDLERS.memory_enhanced_qa, 'function');
});

test('executeSkill returns unknown_skill error when the registry has no match', async () => {
  await withRegistryStubs({ skills: {} }, async () => {
    const out = await executeSkill('nonexistent', {});
    assert.equal(out.ok, false);
    assert.match(out.error, /unknown_skill: nonexistent/);
  });
});

test('executeSkill surfaces prerequisite failures', async () => {
  await withRegistryStubs({
    skills: { deep_document_analysis: { id: 'deep_document_analysis' } },
    prereq: { ok: false, reason: 'missing input file' },
  }, async () => {
    const out = await executeSkill('deep_document_analysis', {});
    assert.equal(out.ok, false);
    assert.equal(out.error, 'missing input file');
  });
});

test('executeSkill returns no_handler when the skill has no matching HANDLERS entry', async () => {
  await withRegistryStubs({
    skills: { exotic_skill: { id: 'exotic_skill' } },
  }, async () => {
    const out = await executeSkill('exotic_skill', {});
    assert.equal(out.ok, false);
    assert.match(out.error, /no_handler: exotic_skill/);
    assert.equal(out.skill, 'exotic_skill');
  });
});

test('memory_enhanced_qa handler delegates to activeMemory.recall', async () => {
  let received = null;
  await withRegistryStubs({
    skills: { memory_enhanced_qa: { id: 'memory_enhanced_qa' } },
  }, async () => {
    await withMemoryStub((userId, query, opts) => {
      received = { userId, query, opts };
      return [{ fact: 'remembered' }];
    }, async () => {
      const out = await executeSkill('memory_enhanced_qa', { userId: 'u-1', query: 'q', limit: 5 });
      assert.equal(out.ok, true);
      assert.equal(out.skillId, 'memory_enhanced_qa');
      assert.deepEqual(out.result.facts, [{ fact: 'remembered' }]);
      assert.equal(received.userId, 'u-1');
      assert.equal(received.query, 'q');
      assert.equal(received.opts.limit, 5);
    });
  });
});

test('deep_document_analysis handler reports an inner error when content is blank', async () => {
  await withRegistryStubs({
    skills: { deep_document_analysis: { id: 'deep_document_analysis' } },
  }, async () => {
    const out = await executeSkill('deep_document_analysis', { content: '   ' });
    assert.equal(out.ok, true, 'outer envelope is ok (handler ran)');
    assert.equal(out.result.ok, false, 'inner handler must signal content required');
    assert.match(out.result.error, /content required/);
  });
});

test('auto_file_analysis handler requires content AND userId', async () => {
  await withRegistryStubs({
    skills: { auto_file_analysis: { id: 'auto_file_analysis' } },
  }, async () => {
    let out = await executeSkill('auto_file_analysis', { content: 'text' });
    assert.equal(out.result.ok, false, 'missing userId must be rejected');
    out = await executeSkill('auto_file_analysis', { userId: 'u-1' });
    assert.equal(out.result.ok, false, 'missing content must be rejected');
  });
});

test('executeSkill catches handler exceptions and returns a sanitised error', async () => {
  await withRegistryStubs({
    skills: { memory_enhanced_qa: { id: 'memory_enhanced_qa' } },
  }, async () => {
    await withMemoryStub(() => { throw new Error('memory blew up'); }, async () => {
      const out = await executeSkill('memory_enhanced_qa', { userId: 'u', query: 'q' });
      assert.equal(out.ok, false);
      assert.equal(out.skillId, 'memory_enhanced_qa');
      assert.equal(out.error, 'memory blew up');
    });
  });
});

test('executeRecommendedSkills enforces the limit cap (1..5)', async () => {
  await withRegistryStubs({
    skills: { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' }, d: { id: 'd' }, e: { id: 'e' }, f: { id: 'f' } },
    recommend: [
      { skill: { id: 'a' } }, { skill: { id: 'b' } }, { skill: { id: 'c' } },
      { skill: { id: 'd' } }, { skill: { id: 'e' } }, { skill: { id: 'f' } },
    ],
  }, async () => {
    // `Number(opts.limit) || 2` coalesces 0/NaN to the default 2, then
    // clamps to [1, 5]. So limit=0 still produces 2 results, limit=100
    // clamps down to 5.
    const defaulted = await executeRecommendedSkills('intent', {}, { limit: 0 });
    assert.equal(defaulted.length, 2, 'limit=0 falls back to default 2');
    const max = await executeRecommendedSkills('intent', {}, { limit: 100 });
    assert.equal(max.length, 5, 'limit=100 clamps down to 5');
    const negative = await executeRecommendedSkills('intent', {}, { limit: -3 });
    assert.equal(negative.length, 1, 'negative limit clamps up to 1 floor');
  });
});

test('executeRecommendedSkills tolerates non-array recommendations', async () => {
  await withRegistryStubs({ skills: {}, recommend: null }, async () => {
    const out = await executeRecommendedSkills('intent', {});
    assert.deepEqual(out, []);
  });
});

test('executeRecommendedSkills degrades to no-skills when recommendSkills throws', async () => {
  const orig = skillsRegistry.recommendSkills;
  skillsRegistry.recommendSkills = () => { throw new TypeError('boom'); };
  try {
    const out = await executeRecommendedSkills({ query: 'x' }, {});
    assert.deepEqual(out, [], 'a throwing recommendation must not propagate — degrade to []');
  } finally {
    skillsRegistry.recommendSkills = orig;
  }
});

test('executeRecommendedSkills resolves skill ids from multiple shapes', async () => {
  await withRegistryStubs({
    skills: { x: { id: 'x' } },
    recommend: [
      { skill: { id: 'x' } },
      { id: 'x' },
      { skillId: 'x' },
      {}, // no id → must be skipped
    ],
  }, async () => {
    // Default limit is 2 — only the first 2 entries are processed.
    const out = await executeRecommendedSkills('intent', {}, { limit: 5 });
    // We bumped the limit so all 4 entries can be processed; the one with
    // no id is skipped, so we expect 3 envelopes.
    assert.equal(out.length, 3);
  });
});
