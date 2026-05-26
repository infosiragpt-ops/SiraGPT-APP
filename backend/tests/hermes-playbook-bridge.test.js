'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const skillsRegistry = require('../src/services/skills-registry');
const {
  FOLDER_CAPABILITY_MAP,
  UPSTREAM_TO_SIRAGPT_SKILLS,
  parseSkillMarkdown,
  loadFlatInstructionSkills,
  buildHermesIntegrationMap,
  recommendAdaptedPlaybooks,
} = require('../src/services/agents/hermes-playbook-bridge');
const toolsetRegistry = require('../src/services/agents/toolset-registry');
const trajectoryCompactor = require('../src/services/agents/trajectory-compactor');
const hermesContext = require('../src/services/agents/hermes-context-patterns');

test('parseSkillMarkdown reads Hermes-style frontmatter', () => {
  const parsed = parseSkillMarkdown('---\nname: demo\ndescription: Demo skill\n---\n# Body\nText');
  assert.equal(parsed.frontmatter.name, 'demo');
  assert.match(parsed.body, /# Body/);
});

test('loadFlatInstructionSkills lists one-level SKILL.md folders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-hermes-skill-'));
  fs.mkdirSync(path.join(dir, 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Alpha\n---\n# Alpha\n');

  const skills = loadFlatInstructionSkills(dir);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].id, 'alpha');
});

test('folder capability map covers major Hermes source areas', () => {
  const folders = new Set(FOLDER_CAPABILITY_MAP.map((entry) => entry.hermes));
  for (const expected of ['agent', 'skills', 'plugins', 'gateway', 'tools', 'web']) {
    assert.ok(folders.has(expected), `expected folder map for ${expected}`);
  }
});

test('upstream Hermes skills map to active SiraGPT playbooks', () => {
  assert.ok(UPSTREAM_TO_SIRAGPT_SKILLS['systematic-debugging'].includes('runtime-debugging'));
  assert.ok(UPSTREAM_TO_SIRAGPT_SKILLS['test-driven-development'].includes('qa-smoke-testing'));
});

test('buildHermesIntegrationMap reports copied upstream and rewritten SiraGPT skills', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const matrix = buildHermesIntegrationMap({ repoRoot });

  assert.equal(matrix.source.license, 'MIT');
  assert.ok(matrix.counts.upstreamSkills >= 100, 'Hermes snapshot should include copied skills');
  assert.ok(matrix.counts.siraSkills >= 20, 'SiraGPT should include active rewritten skills');
  assert.equal(matrix.counts.coverage.partial || 0, 0, 'explicit Hermes mappings should resolve to active SiraGPT skills');
  assert.ok(matrix.skills.some((skill) => skill.upstream === 'systematic-debugging'));
});

test('recommendAdaptedPlaybooks returns SiraGPT-native skills for Hermes-flavored requests', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const recs = recommendAdaptedPlaybooks('integrar hermes agent skills nous research', { repoRoot });
  const adapted = new Set(recs.flatMap((rec) => rec.adaptedSkills));

  assert.ok(adapted.has('hermes-import-audit') || adapted.has('repo-folder-integration'));
});

test('toolset registry resolves core and composed bundles', () => {
  const core = toolsetRegistry.getToolset('core');
  assert.ok(core.tools.includes('web_search'));
  const full = toolsetRegistry.resolveToolset('full_stack');
  assert.ok(full.includes('web_search'));
  assert.ok(full.includes('create_chart'));
});

test('trajectory compactor protects head and tail turns', () => {
  const turns = Array.from({ length: 12 }, (_, i) => ({ role: i < 2 ? 'system' : 'user', content: `turn-${i}-${'x'.repeat(400)}` }));
  const result = trajectoryCompactor.compactTrajectory(turns, { targetMaxTokens: 1000, protectHead: 2, protectTail: 2 });
  assert.equal(result.compressed, true);
  assert.ok(result.afterTokens <= result.beforeTokens);
  assert.ok(result.turns.some((turn) => turn.type === 'compaction_summary'));
});

test('hermes context patterns build compaction preamble and prune tool results', () => {
  const preamble = hermesContext.buildCompactionPreamble();
  assert.match(preamble, /REFERENCE ONLY/);
  const pruned = hermesContext.pruneToolResults([
    { role: 'user', content: 'hi' },
    { role: 'tool', content: 'a' },
    { role: 'tool', content: 'b' },
    { role: 'tool', content: 'c' },
  ], { keepTailToolResults: 1 });
  assert.equal(pruned.pruned, 2);
  assert.match(pruned.messages[1].content, /cleared to save context/);
});

test('legacy skill registry exposes Hermes playbook import for runtime recommendation', () => {
  const skill = skillsRegistry.getSkill('hermes_playbook_import');
  assert.ok(skill);
  assert.equal(skill.label, 'Hermes Agent Import + Adaptation');
  assert.ok(skill.tools.includes('skill_manifest_map'));

  const recs = skillsRegistry.recommendSkills('hermes agent skills import nous', {
    userClearance: 'enterprise',
    limit: 5,
  });
  assert.ok(recs.some((candidate) => candidate.id === 'hermes_playbook_import'));
});
