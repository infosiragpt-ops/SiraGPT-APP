const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildUserIntentAlignmentProfile,
  buildUserIntentAlignmentPrompt,
  extractRequestedCounts,
  inferTaskType,
} = require('../src/services/agents/user-intent-alignment');

test('user intent alignment: keeps article requests inline when user says no format', () => {
  const profile = buildUserIntentAlignmentProfile({
    request: 'Dame 5 articulos cientificos sobre conducta disruptiva sin ningun formato',
  });

  assert.equal(profile.taxonomy, 'generation');
  assert.equal(profile.outputMode, 'inline');
  assert.equal(profile.requestedFormat, null);
  assert.ok(profile.hardConstraints.includes('answer_inline_only'));
  assert.ok(profile.hardConstraints.includes('requested_count:5 articulos'));
  assert.ok(profile.responsePolicy.includes('do_not_create_file_unless_user_asked'));
});

test('user intent alignment: detects strict academic Excel constraints', () => {
  const profile = buildUserIntentAlignmentProfile({
    request: 'Investiga 40 articulos cientificos reales con DOI de 2022 a 2026 y ponlos en Excel',
  });

  assert.equal(profile.outputMode, 'downloadable_artifact');
  assert.equal(profile.requestedFormat, 'xlsx');
  assert.equal(profile.groundingMode, 'source_verification_required');
  assert.ok(profile.hardConstraints.includes('verified_sources_only'));
  assert.ok(profile.hardConstraints.includes('citations_required'));
  assert.ok(profile.hardConstraints.includes('requested_count:40 articulos'));
});

test('user intent alignment: treats attachments as closed context even with short prompts', () => {
  const profile = buildUserIntentAlignmentProfile({
    request: 'dame un resumen',
    fileIds: ['docx-1'],
  });

  assert.equal(profile.taxonomy, 'summarization');
  assert.equal(profile.groundingMode, 'private_context_required');
  assert.ok(profile.hardConstraints.includes('use_private_context'));
});

test('user intent alignment: prompt is compact and does not echo private user text', () => {
  const request = 'Investiga 40 articulos cientificos reales sobre un tema privado de mi tesis y ponlos en Excel';
  const profile = buildUserIntentAlignmentProfile({ request });
  const prompt = buildUserIntentAlignmentPrompt(profile);

  assert.match(prompt, /Helpful/i);
  assert.match(prompt, /Honest/i);
  assert.match(prompt, /source_verification_required/);
  assert.doesNotMatch(prompt, /tema privado de mi tesis/);
});

test('user intent alignment: count extraction covers numeric and Spanish word counts', () => {
  assert.deepEqual(extractRequestedCounts('necesito 40 articulos y diez fuentes'), [
    '40 articulos',
    '10 fuentes',
  ]);
});

test('user intent alignment: task taxonomy follows InstructGPT-style buckets', () => {
  assert.equal(inferTaskType('clasifica este texto como positivo o negativo', false), 'classification');
  assert.equal(inferTaskType('parafrasea este parrafo', false), 'rewrite');
  assert.equal(inferTaskType('que es el aprendizaje por refuerzo?', false), 'open_qa');
  assert.equal(inferTaskType('extrae las fechas del documento', true), 'extraction');
});
