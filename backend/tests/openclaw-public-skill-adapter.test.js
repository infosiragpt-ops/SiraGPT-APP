'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  VALID_STATUSES,
  PUBLIC_SKILL_ADAPTATIONS,
  classifyPublicSkill,
  buildPublicSkillCatalog,
  countPublicSkillCoverage,
} = require('../src/services/agents/openclaw-public-skill-adapter');

test('public OpenClaw catalog has an explicit SiraGPT decision for all audited skills', () => {
  const ids = Object.keys(PUBLIC_SKILL_ADAPTATIONS);
  assert.equal(ids.length, 51);
  for (const [id, definition] of Object.entries(PUBLIC_SKILL_ADAPTATIONS)) {
    assert.ok(VALID_STATUSES.has(definition.status), `${id} has invalid status`);
    assert.ok(Array.isArray(definition.adaptedSkills), `${id} adaptedSkills missing`);
    assert.ok(Array.isArray(definition.siraServices), `${id} siraServices missing`);
    assert.ok(definition.reason, `${id} reason missing`);
  }
});

test('covered public skills require concrete SiraGPT runtime evidence', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const catalog = buildPublicSkillCatalog([
    { id: 'summarize', description: 'summary' },
    { id: 'weather', description: 'weather' },
    { id: 'session-logs', description: 'sessions' },
  ], { repoRoot });

  assert.deepEqual(catalog.map((entry) => entry.status), ['covered', 'covered', 'covered']);
  assert.ok(catalog.every((entry) => entry.evidence.length > 0));
  assert.ok(catalog.every((entry) => entry.source_policy === 'native-rewrite-no-active-upstream-code'));
});

test('nominal active capability is downgraded when its SiraGPT evidence is missing', () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-public-skill-empty-'));
  const result = classifyPublicSkill({ id: 'weather', description: 'weather' }, { repoRoot: emptyRoot });
  assert.equal(result.status, 'partial');
  assert.equal(result.availableSkills.length, 0);
  assert.ok(result.missing_evidence.includes('backend/src/skills/weather'));
});

test('coverage counts use the capability-matrix status vocabulary', () => {
  const counts = countPublicSkillCoverage([
    { status: 'covered' },
    { status: 'adapted' },
    { status: 'adapted' },
    { status: 'reference-only' },
    { status: 'not-applicable' },
  ]);
  assert.deepEqual(counts, {
    covered: 1,
    adapted: 2,
    'reference-only': 1,
    'not-applicable': 1,
  });
});

test('unknown upstream public skills stay inactive by default', () => {
  const result = classifyPublicSkill({ id: 'future-upstream-skill', description: 'future' });
  assert.equal(result.status, 'reference-only');
  assert.equal(result.activation, 'inactive-reference');
  assert.deepEqual(result.availableSkills, []);
});
