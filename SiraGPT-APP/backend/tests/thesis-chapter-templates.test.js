'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CHAPTER_TEMPLATES,
  CHAPTER_BUNDLES,
  getTemplate,
  listTemplates,
  listBundle,
} = require('../src/services/thesis/chapter-templates');

test('listTemplates returns at least the spec §7.22 coverage', () => {
  const ids = listTemplates().map((t) => t.id);
  const required = [
    'introduction',
    'problematic_reality',
    'antecedents',
    'theoretical_framework',
    'research_questions',
    'objectives',
    'hypotheses',
    'justification',
    'methodological_design',
    'population_sample',
    'techniques_instruments',
    'data_processing_analysis',
    'ethical_aspects',
    'consistency_matrix',
    'operational_matrix',
    'instruments_collection',
    'references',
  ];
  for (const id of required) {
    assert.ok(ids.includes(id), `missing template ${id}`);
  }
});

test('every template has the required shape', () => {
  for (const t of listTemplates()) {
    assert.equal(typeof t.id, 'string', `id missing on ${JSON.stringify(t)}`);
    assert.equal(typeof t.title, 'string', `title missing on ${t.id}`);
    assert.ok(Array.isArray(t.sections), `sections not array on ${t.id}`);
    assert.ok(t.sections.length > 0, `empty sections on ${t.id}`);
    assert.ok(Number.isFinite(t.minWords), `minWords on ${t.id}`);
    assert.ok(Number.isFinite(t.maxWords), `maxWords on ${t.id}`);
    assert.ok(t.minWords > 0, `minWords > 0 on ${t.id}`);
    assert.ok(t.maxWords >= t.minWords, `maxWords >= minWords on ${t.id}`);
  }
});

test('template ids match their keys', () => {
  for (const [key, t] of Object.entries(CHAPTER_TEMPLATES)) {
    assert.equal(t.id, key, `key/id mismatch on ${key}`);
  }
});

test('getTemplate returns the template by id', () => {
  const t = getTemplate('problematic_reality');
  assert.ok(t);
  assert.equal(t.id, 'problematic_reality');
  assert.deepEqual(t.sections, ['internacional', 'nacional', 'local']);
});

test('getTemplate returns null for unknown ids', () => {
  assert.equal(getTemplate('does-not-exist'), null);
  assert.equal(getTemplate(''), null);
  assert.equal(getTemplate(null), null);
});

test('problematic_reality has international/national/local sections', () => {
  const t = getTemplate('problematic_reality');
  assert.ok(t.sections.includes('internacional'));
  assert.ok(t.sections.includes('nacional'));
  assert.ok(t.sections.includes('local'));
});

test('antecedents distinguishes international from national', () => {
  const t = getTemplate('antecedents');
  assert.ok(t.sections.some((s) => s.includes('internacionales')));
  assert.ok(t.sections.some((s) => s.includes('nacionales')));
});

test('techniques_instruments includes validity and reliability', () => {
  const t = getTemplate('techniques_instruments');
  assert.ok(t.sections.includes('validez'));
  assert.ok(t.sections.includes('confiabilidad'));
});

test('consistency_matrix covers the canonical 5 axes', () => {
  const t = getTemplate('consistency_matrix');
  for (const expected of ['problema', 'objetivos', 'hipotesis', 'variables', 'metodologia']) {
    assert.ok(t.sections.includes(expected), `consistency_matrix missing ${expected}`);
  }
});

test('operational_matrix covers conceptual/operational/indicators/items/scale', () => {
  const t = getTemplate('operational_matrix');
  for (const expected of ['definicion_conceptual', 'definicion_operacional', 'dimensiones', 'indicadores', 'items', 'escala']) {
    assert.ok(t.sections.includes(expected), `operational_matrix missing ${expected}`);
  }
});

test('references mentions APA 7 in the title', () => {
  const t = getTemplate('references');
  assert.match(t.title, /APA\s*7/i);
});

test('CHAPTER_BUNDLES exposes the 5-chapter Latin-American layout', () => {
  for (const key of ['capitulo_1', 'capitulo_2', 'capitulo_3', 'capitulo_4', 'capitulo_5', 'closing']) {
    assert.ok(CHAPTER_BUNDLES[key], `missing bundle ${key}`);
    assert.ok(Array.isArray(CHAPTER_BUNDLES[key]), `bundle ${key} not array`);
    assert.ok(CHAPTER_BUNDLES[key].length > 0, `bundle ${key} empty`);
  }
});

test('listBundle returns hydrated templates', () => {
  const cap3 = listBundle('capitulo_3');
  assert.ok(cap3.length >= 5);
  const ids = cap3.map((t) => t.id);
  assert.ok(ids.includes('methodological_design'));
  assert.ok(ids.includes('population_sample'));
  assert.ok(ids.includes('consistency_matrix'));
});

test('listBundle for unknown bundle returns empty array', () => {
  assert.deepEqual(listBundle('does-not-exist'), []);
});

test('legacy templates (introduction, methodology) still work', () => {
  assert.ok(getTemplate('introduction'));
  assert.ok(getTemplate('methodology'));
});
