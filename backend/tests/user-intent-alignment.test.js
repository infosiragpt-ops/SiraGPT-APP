const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildUserIntentAlignmentProfile,
  buildUserIntentAlignmentPrompt,
  extractRequestedCounts,
  extractTones,
  extractLengthConstraints,
  extractOutputLanguage,
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

test('user intent alignment: captures requested tone/register', () => {
  assert.deepEqual(extractTones('explícalo de forma sencilla para principiantes'), ['tone:simple']);
  assert.deepEqual(extractTones('redáctalo con un tono formal'), ['tone:formal']);
  assert.deepEqual(extractTones('hazlo persuasivo, es copy de ventas'), ['tone:persuasive']);
  assert.deepEqual(extractTones('explícamelo para niños'), ['tone:child_friendly']);
  assert.deepEqual(extractTones('dame el dato'), []);
});

test('user intent alignment: tone detection avoids domain false positives', () => {
  // "datos de ventas" is a business domain, not a request for persuasive tone.
  assert.deepEqual(extractTones('analiza datos de ventas de 2025'), []);
  // "user-friendly" is a product adjective, not a request for informal register.
  assert.deepEqual(extractTones('haz un reporte user-friendly'), []);
});

test('user intent alignment: captures brief vs detailed and explicit lengths', () => {
  assert.ok(extractLengthConstraints('resúmelo de forma breve').includes('length:brief'));
  assert.ok(extractLengthConstraints('explícalo en profundidad y paso a paso').includes('length:detailed'));
  assert.ok(extractLengthConstraints('escríbelo en 300 palabras').includes('length:300 palabras'));
  assert.ok(extractLengthConstraints('hazlo en dos parrafos').includes('length:2 parrafos'));
  assert.ok(extractLengthConstraints('resúmelo en un parrafo').includes('length:1 parrafo'));
  assert.deepEqual(extractLengthConstraints('dame el dato'), []);
});

test('user intent alignment: detects response language only when verb-anchored', () => {
  assert.equal(extractOutputLanguage('respóndeme en inglés por favor'), 'english');
  assert.equal(extractOutputLanguage('traduce esto al frances'), 'french');
  assert.equal(extractOutputLanguage('escríbelo en español'), 'spanish');
  // "sources in English" must NOT be read as "respond in English".
  assert.equal(extractOutputLanguage('busca articulos cientificos en ingles'), null);
  // Even with a response verb, a language modifying the SOURCES must not flip
  // the response language.
  assert.equal(extractOutputLanguage('responde con articulos en ingles sobre cancer'), null);
});

test('user intent alignment: expanded Spanish number words and "de" bridge', () => {
  assert.deepEqual(extractRequestedCounts('necesito quince fuentes'), ['15 fuentes']);
  assert.deepEqual(extractRequestedCounts('dame un par de articulos'), ['2 articulos']);
  assert.deepEqual(extractRequestedCounts('reune una docena de referencias'), ['12 referencias']);
  // Idiom "a la par de" must NOT be read as a count of 2.
  assert.deepEqual(extractRequestedCounts('a la par de documentos de apoyo'), []);
});

test('user intent alignment: surfaces tone, length and language as hard constraints', () => {
  const profile = buildUserIntentAlignmentProfile({
    request: 'Respóndeme en inglés, de forma breve y con un tono formal',
  });
  assert.ok(profile.hardConstraints.includes('output_language:english'));
  assert.ok(profile.hardConstraints.includes('length:brief'));
  assert.ok(profile.hardConstraints.includes('tone:formal'));
  assert.ok(profile.responsePolicy.includes('respond_in_requested_language'));
  assert.ok(profile.responsePolicy.includes('keep_answer_brief'));
  assert.ok(profile.responsePolicy.includes('match_requested_tone'));
});
