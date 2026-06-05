const test = require('node:test');
const assert = require('node:assert');

const {
  createSession,
  recordAnswer,
  recordIntegrations,
  recordConstraints,
  coverage,
  isComplete,
  nextQuestion,
  buildBrief,
  normalisePlatform,
  normaliseEntities,
  normaliseStyle,
} = require('../src/services/builder/intake-engine');
const { QuestionCardSchema, ProjectBriefSchema, COVERAGE_DIMENSIONS } = require('../src/services/builder/contracts');
const { questionForDimension } = require('../src/services/builder/questions');

function answerAll(session) {
  recordAnswer(session, 'purpose', 'Vender cursos online');
  recordAnswer(session, 'platform', 'web');
  recordAnswer(session, 'coreFeatures', 'pagos, búsqueda');
  recordAnswer(session, 'dataEntities', 'Usuario, Curso');
  recordAnswer(session, 'style', 'minimalista');
  recordAnswer(session, 'audience', 'estudiantes');
  return session;
}

test('createSession starts empty', () => {
  const s = createSession();
  assert.deepStrictEqual(s.answers, {});
  assert.strictEqual(coverage(s).ratio, 0);
  assert.strictEqual(isComplete(s), false);
});

test('recordAnswer ignores blank values', () => {
  const s = createSession();
  recordAnswer(s, 'purpose', '   ');
  recordAnswer(s, 'coreFeatures', []);
  recordAnswer(s, 'audience', null);
  assert.deepStrictEqual(coverage(s).covered, []);
});

test('recordAnswer rejects unknown dimension', () => {
  const s = createSession();
  assert.throws(() => recordAnswer(s, 'budget', 'x'), /unknown coverage dimension/);
});

test('coverage tracks covered vs missing', () => {
  const s = createSession();
  recordAnswer(s, 'purpose', 'algo');
  recordAnswer(s, 'platform', 'web');
  const cov = coverage(s);
  assert.deepStrictEqual(cov.covered, ['purpose', 'platform']);
  assert.deepStrictEqual(cov.missing, ['coreFeatures', 'dataEntities', 'style', 'audience']);
  assert.strictEqual(cov.complete, false);
  assert.strictEqual(cov.ratio, 0.3333); // 2/6 rounded to 4 decimals
});

test('nextQuestion follows COVERAGE_DIMENSIONS order and is a valid card', () => {
  const s = createSession();
  const first = nextQuestion(s);
  assert.strictEqual(first.dimension, COVERAGE_DIMENSIONS[0]);
  assert.strictEqual(QuestionCardSchema.safeParse(first).success, true);

  recordAnswer(s, 'purpose', 'algo');
  assert.strictEqual(nextQuestion(s).dimension, 'platform');
});

test('nextQuestion returns null when complete', () => {
  const s = answerAll(createSession());
  assert.strictEqual(isComplete(s), true);
  assert.strictEqual(nextQuestion(s), null);
});

test('buildBrief throws while incomplete', () => {
  const s = createSession();
  recordAnswer(s, 'purpose', 'algo');
  assert.throws(() => buildBrief(s), /missing dimensions/);
});

test('buildBrief assembles a valid ProjectBrief', () => {
  const s = answerAll(createSession());
  recordIntegrations(s, 'Stripe, SendGrid');
  recordConstraints(s, 'Entregar en 2 semanas');
  const brief = buildBrief(s, { openQuestions: ['¿idioma?'] });

  assert.strictEqual(ProjectBriefSchema.safeParse(brief).success, true);
  assert.strictEqual(brief.platform, 'web');
  assert.deepStrictEqual(brief.coreFeatures, ['pagos', 'búsqueda']);
  assert.deepStrictEqual(brief.dataEntities, [
    { name: 'Usuario', fields: [] },
    { name: 'Curso', fields: [] },
  ]);
  assert.deepStrictEqual(brief.style, { theme: 'minimalista', refs: [] });
  assert.deepStrictEqual(brief.integrations, ['Stripe', 'SendGrid']);
  assert.strictEqual(brief.constraints, 'Entregar en 2 semanas');
  assert.deepStrictEqual(brief.openQuestions, ['¿idioma?']);
});

test('normalisePlatform maps synonyms and rejects nonsense', () => {
  assert.strictEqual(normalisePlatform('Móvil'), 'mobile');
  assert.strictEqual(normalisePlatform('una app para android'), 'mobile');
  assert.strictEqual(normalisePlatform('landing page'), 'landing');
  assert.strictEqual(normalisePlatform('sitio web'), 'web');
  assert.strictEqual(normalisePlatform('cohete espacial'), null);
});

test('buildBrief rejects an un-mappable platform', () => {
  const s = answerAll(createSession());
  s.answers.platform = 'cohete espacial';
  assert.throws(() => buildBrief(s), /not one of/);
});

test('normaliseEntities accepts structured and free-text input', () => {
  assert.deepStrictEqual(normaliseEntities('Usuario, Pedido'), [
    { name: 'Usuario', fields: [] },
    { name: 'Pedido', fields: [] },
  ]);
  assert.deepStrictEqual(
    normaliseEntities([{ name: 'Usuario', fields: ['email', 'nombre'] }]),
    [{ name: 'Usuario', fields: ['email', 'nombre'] }],
  );
});

test('normaliseStyle accepts object and string', () => {
  assert.deepStrictEqual(normaliseStyle({ theme: 'oscuro', refs: ['dribbble.com'] }), {
    theme: 'oscuro',
    refs: ['dribbble.com'],
  });
  assert.deepStrictEqual(normaliseStyle('moderno'), { theme: 'moderno', refs: [] });
});

test('questionForDimension returns a frozen-copy valid card for every dimension', () => {
  for (const dim of COVERAGE_DIMENSIONS) {
    const card = questionForDimension(dim);
    assert.strictEqual(card.dimension, dim);
    assert.strictEqual(QuestionCardSchema.safeParse(card).success, true);
    // mutating the returned copy must not leak into the bank
    card.options.push('x');
    assert.ok(!questionForDimension(dim).options.includes('x'));
  }
});
