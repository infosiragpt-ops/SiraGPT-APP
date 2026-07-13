'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPrismaFlow,
  buildProtocol,
  detectFramework,
  gradeEvidence,
  preliminaryRiskOfBias,
  screenPaper,
} = require('../src/services/research/systematic-review-protocol');

test('PICO extracts explicit fields and creates an auditable boolean query', () => {
  const raw = 'PICO; Población: adultos con diabetes; Intervención: telemedicina; Comparación: atención habitual; Resultado: control glucémico';
  const protocol = buildProtocol(raw, { filters: {} });
  assert.equal(protocol.framework, 'pico');
  assert.deepEqual(protocol.missingFields, []);
  assert.equal(protocol.fields.population, 'adultos con diabetes');
  assert.match(protocol.searchExpression, /"adultos con diabetes" AND "telemedicina"/);
  assert.equal(protocol.active, true);
});

test('SPIDER supports structured qualitative fields and reports missing fields', () => {
  const protocol = buildProtocol('revisión sistemática cualitativa', { filters: {} }, {
    framework: 'spider',
    fields: { sample: 'docentes rurales', phenomenon: 'adopción de IA', design: 'entrevistas' },
  });
  assert.equal(detectFramework('', 'spider'), 'spider');
  assert.equal(protocol.framework, 'spider');
  assert.equal(protocol.fields.phenomenon, 'adopción de IA');
  assert.deepEqual(protocol.missingFields, ['evaluation', 'researchType']);
});

test('framework field extraction stops before explicit manual criteria', () => {
  const protocol = buildProtocol(
    'PICO; Población: adultos; Intervención: terapia; Comparación: control; Resultado: calidad de vida; incluir: ensayos | cohortes',
    { filters: {} },
  );
  assert.equal(protocol.fields.outcome, 'calidad de vida');
  assert.deepEqual(protocol.inclusionCriteria.manual, ['ensayos', 'cohortes']);
});

test('screenPaper excludes deterministic violations and preserves uncertain records', () => {
  const protocol = buildProtocol(
    'PICO; Población: adultos; Intervención: telemedicina; Comparación: control; Resultado: calidad de vida',
    { filters: { yearFrom: 2020 } },
  );
  const excluded = screenPaper({ title: 'Old study', year: 2018, abstract: 'Adults using telemedicine.' }, protocol, { yearFrom: 2020 });
  assert.equal(excluded.decision, 'exclude');
  assert.ok(excluded.reasons.includes('outside_year_range'));

  const unsafe = screenPaper({ title: 'Retracted study', year: 2024, raw: { is_retracted: true } }, protocol, {});
  assert.equal(unsafe.decision, 'exclude');
  assert.ok(unsafe.reasons.includes('unsafe_editorial_status'));

  const uncertain = screenPaper({ title: 'Digital health', year: 2024, abstract: 'A general digital health review.' }, protocol, {});
  assert.equal(uncertain.decision, 'uncertain');
  assert.ok(uncertain.reasons.some((reason) => reason.includes('not_confirmed_from_abstract')));

  const included = screenPaper({ title: 'Telemedicina para adultos', year: 2024, abstract: 'Adultos recibieron telemedicina y reportaron calidad de vida.' }, protocol, {});
  assert.equal(included.decision, 'include');
});

test('risk of bias and certainty remain explicitly preliminary', () => {
  const assessed = preliminaryRiskOfBias({
    title: 'Randomized controlled trial',
    abstract: 'A randomized controlled trial found a significant effect (p<0.05).',
    journal: 'Clinical Evidence',
  });
  assert.equal(assessed.level, 'some_concerns');
  assert.equal(assessed.recommendedTool, 'RoB 2');
  assert.equal(assessed.requiresFullTextAssessment, true);
  assert.ok(assessed.checks.some((check) => check.criterion === 'randomization' && check.status === 'requires_full_text'));

  const certainty = gradeEvidence([{ ...assessed, riskOfBias: assessed }], { consensus: [], contradictions: [] });
  assert.notEqual(certainty.level, 'high');
  assert.equal(certainty.requiresFullTextAssessment, true);
  assert.equal(certainty.domains.imprecision, 'requires_effect_estimates_and_confidence_intervals');
});

test('PRISMA flow is computed from actual identified, deduped and screening counts', () => {
  const prisma = buildPrismaFlow({
    identified: 8,
    deduped: 5,
    screened: [
      { screening: { decision: 'include', reasons: ['automatic_criteria_passed'] } },
      { screening: { decision: 'uncertain', reasons: ['abstract_unavailable'] } },
      { screening: { decision: 'exclude', reasons: ['outside_year_range'] } },
      { screening: { decision: 'exclude', reasons: ['outside_year_range', 'open_access_required'] } },
      { screening: { decision: 'include', reasons: ['automatic_criteria_passed'] } },
    ],
    included: 3,
  });
  assert.equal(prisma.deduplication.duplicatesRemoved, 3);
  assert.equal(prisma.screening.recordsExcluded, 2);
  assert.equal(prisma.screening.recordsUncertain, 1);
  assert.equal(prisma.screening.exclusionReasons.outside_year_range, 2);
  assert.equal(prisma.included.studiesInPreliminarySynthesis, 3);
});
