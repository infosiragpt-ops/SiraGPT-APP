const test = require('node:test');
const assert = require('node:assert');
const { QuestionCardSchema, ProjectBriefSchema, COVERAGE_DIMENSIONS } = require('../src/services/builder/contracts');

test('COVERAGE_DIMENSIONS has the 6 expected dims', () => {
  assert.deepStrictEqual(COVERAGE_DIMENSIONS,
    ['purpose', 'platform', 'coreFeatures', 'dataEntities', 'style', 'audience']);
});

test('QuestionCardSchema accepts a valid chips card', () => {
  const card = { id: 'q1', dimension: 'platform', prompt: '¿Web o móvil?', type: 'chips', options: ['web', 'mobile'], allowFreeText: false };
  assert.strictEqual(QuestionCardSchema.safeParse(card).success, true);
});

test('QuestionCardSchema rejects unknown type', () => {
  const bad = { id: 'q1', dimension: 'platform', prompt: 'x', type: 'radio', options: [] };
  assert.strictEqual(QuestionCardSchema.safeParse(bad).success, false);
});

test('ProjectBriefSchema requires platform enum', () => {
  const brief = { purpose: 'p', platform: 'desktop', audience: 'a', coreFeatures: [], dataEntities: [], style: { theme: 't', refs: [] }, integrations: [], constraints: '', openQuestions: [] };
  assert.strictEqual(ProjectBriefSchema.safeParse(brief).success, false);
});
