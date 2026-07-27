'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPrismaFlow,
  buildProtocol,
  detectFramework,
  gradeEvidence,
  gradeFullTextEvidence,
  preliminaryRiskOfBias,
  assessFullTextRiskOfBias,
  extractEffectEstimates,
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

test('full-text risk-of-bias assessment records domain evidence and reviewer overrides', () => {
  const fullText = `${'Randomized controlled trial. '.repeat(20)} Allocation concealment was used. Analysis followed the intention-to-treat principle. A validated scale and blinded outcome assessor were used. The protocol was registered before recruitment. Lost to follow-up was 4%.`;
  const assessment = assessFullTextRiskOfBias({ title: 'Randomized controlled trial', studyType: 'rct' }, {
    fullText,
    judgments: { selective_reporting: { judgment: 'low', evidence: 'Protocol registration verified by reviewer.' } },
  });
  assert.equal(assessment.basis, 'full_text_domain_assessment');
  assert.equal(assessment.requiresFullTextAssessment, false);
  assert.ok(assessment.checks.some((check) => check.domain === 'randomization' && check.evidence));
  assert.ok(assessment.checks.some((check) => check.domain === 'selective_reporting' && check.source === 'reviewer'));
});

test('full-text GRADE uses effects, intervals, sample size and bias domains', () => {
  const fullText = `${'Trial methods and results. '.repeat(25)} n=650. RR=0.72, 95% CI 0.61 to 0.84.`;
  const effects = extractEffectEstimates(fullText);
  assert.equal(effects.estimates[0].measure, 'RR');
  assert.equal(effects.estimates[0].ciLower, 0.61);
  assert.equal(effects.totalSample, 650);
  const certainty = gradeFullTextEvidence([{ studyType: 'rct', fullText, effects, riskOfBias: { level: 'low', requiresFullTextAssessment: false } }]);
  assert.equal(certainty.level, 'high');
  assert.equal(certainty.domains.imprecision, 'not_serious');
  assert.equal(certainty.requiresFullTextAssessment, false);
});
