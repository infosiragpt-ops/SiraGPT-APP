'use strict';

const { annotateSource, passesIntegrityFilters } = require('./source-integrity');

const FRAMEWORK_FIELDS = Object.freeze({
  pico: ['population', 'intervention', 'comparison', 'outcome'],
  spider: ['sample', 'phenomenon', 'design', 'evaluation', 'researchType'],
});

const FIELD_ALIASES = Object.freeze({
  population: ['population', 'poblacion', 'población', 'participants', 'participantes'],
  intervention: ['intervention', 'intervencion', 'intervención', 'exposure', 'exposicion', 'exposición'],
  comparison: ['comparison', 'comparacion', 'comparación', 'comparator', 'control'],
  outcome: ['outcome', 'outcomes', 'resultado', 'resultados', 'desenlace', 'desenlaces'],
  sample: ['sample', 'muestra'],
  phenomenon: ['phenomenon of interest', 'phenomenon', 'fenomeno de interes', 'fenómeno de interés', 'fenomeno', 'fenómeno'],
  design: ['design', 'diseño', 'diseno'],
  evaluation: ['evaluation', 'evaluacion', 'evaluación'],
  researchType: ['research type', 'tipo de investigacion', 'tipo de investigación', 'metodo', 'método'],
});

function stripDiacritics(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function normaliseText(value) {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectFramework(rawQuery, requested) {
  const explicit = String(requested || '').toLowerCase();
  if (explicit === 'pico' || explicit === 'spider') return explicit;
  const text = normaliseText(rawQuery);
  const labelText = stripDiacritics(rawQuery).toLowerCase();
  if (/\bspider\b/.test(text)) return 'spider';
  if (/\bpico\b/.test(text)) return 'pico';
  const aliasHits = (framework) => FRAMEWORK_FIELDS[framework].filter((field) => (
    FIELD_ALIASES[field].some((alias) => new RegExp(`(?:^|[;,.\\n])\\s*${normaliseText(alias).replace(/\s+/g, '\\s+')}\\s*:`).test(labelText))
  )).length;
  if (aliasHits('spider') >= 2) return 'spider';
  if (aliasHits('pico') >= 2) return 'pico';
  return null;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractFrameworkFields(rawQuery, framework, structured = {}) {
  if (!framework) return {};
  const text = String(rawQuery || '');
  const allAliases = [
    ...Object.values(FIELD_ALIASES).flat(),
    'incluir', 'inclusion', 'inclusión', 'include', 'inclusion criteria',
    'excluir', 'exclusion', 'exclusión', 'exclude', 'exclusion criteria',
  ].sort((a, b) => b.length - a.length);
  const nextLabel = allAliases.map((alias) => escapeRegex(alias)).join('|');
  const fields = {};
  for (const field of FRAMEWORK_FIELDS[framework]) {
    const structuredValue = structured && typeof structured[field] === 'string' ? structured[field].trim() : '';
    if (structuredValue) {
      fields[field] = structuredValue.slice(0, 300);
      continue;
    }
    for (const alias of FIELD_ALIASES[field]) {
      const re = new RegExp(`(?:^|[;,.\\n])\\s*${escapeRegex(alias)}\\s*:\\s*(.+?)(?=(?:[;,.\\n]\\s*(?:${nextLabel})\\s*:)|$)`, 'i');
      const match = text.match(re);
      if (match?.[1]?.trim()) {
        fields[field] = match[1].trim().replace(/[.;,]+$/, '').slice(0, 300);
        break;
      }
    }
  }
  return fields;
}

function quoted(value) {
  return `"${String(value || '').replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()}"`;
}

function buildBooleanQuery(framework, fields) {
  if (!framework) return '';
  return FRAMEWORK_FIELDS[framework]
    .map((field) => fields[field])
    .filter(Boolean)
    .map(quoted)
    .join(' AND ');
}

function extractManualCriteria(rawQuery, kind) {
  const label = kind === 'inclusion'
    ? '(?:incluir|inclusion|inclusión|include|inclusion criteria)'
    : '(?:excluir|exclusion|exclusión|exclude|exclusion criteria)';
  const match = String(rawQuery || '').match(new RegExp(`${label}\\s*:\\s*([^\\n]+)`, 'i'));
  if (!match) return [];
  return match[1].split(/\s*[;|]\s*/).map((value) => value.trim()).filter(Boolean).slice(0, 20);
}

function isSystematicReviewRequest(rawQuery, framework) {
  return Boolean(framework || /\brevisi[oó]n sistem[aá]tica\b|\bsystematic review\b|\bprisma\b/i.test(String(rawQuery || '')));
}

function buildProtocol(rawQuery, qa = {}, requested = {}) {
  const framework = detectFramework(rawQuery, requested.framework);
  const structuredFields = requested.fields && typeof requested.fields === 'object' ? requested.fields : requested;
  const fields = extractFrameworkFields(rawQuery, framework, structuredFields);
  const missingFields = framework ? FRAMEWORK_FIELDS[framework].filter((field) => !fields[field]) : [];
  const filters = qa.filters || {};
  const automaticInclusion = [
    filters.yearFrom ? `year >= ${filters.yearFrom}` : null,
    filters.yearTo ? `year <= ${filters.yearTo}` : null,
    filters.language ? `language = ${filters.language}` : null,
    filters.openAccessOnly ? 'open_access = true' : null,
    filters.peerReviewedOnly ? 'peer_reviewed = confirmed_or_likely' : null,
    filters.studyTypeRequired && filters.studyType ? `study_type = ${filters.studyType}` : null,
  ].filter(Boolean);
  const automaticExclusion = [
    filters.includeRetracted ? null : 'integrity_status = retracted_or_withdrawn',
    filters.excludePreprints ? 'publication_stage = preprint' : null,
  ].filter(Boolean);
  const manualInclusion = Array.isArray(requested.inclusionCriteria)
    ? requested.inclusionCriteria.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 20)
    : extractManualCriteria(rawQuery, 'inclusion');
  const manualExclusion = Array.isArray(requested.exclusionCriteria)
    ? requested.exclusionCriteria.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 20)
    : extractManualCriteria(rawQuery, 'exclusion');

  return {
    active: isSystematicReviewRequest(rawQuery, framework),
    framework,
    fields,
    missingFields,
    searchExpression: buildBooleanQuery(framework, fields),
    inclusionCriteria: {
      automatic: automaticInclusion,
      manual: manualInclusion,
    },
    exclusionCriteria: {
      automatic: automaticExclusion,
      manual: manualExclusion,
    },
    scope: 'metadata_and_abstract_preliminary',
    fullTextReviewRequired: true,
  };
}

function fieldCoverage(text, value) {
  const haystack = normaliseText(text);
  const terms = normaliseText(value).split(' ').filter((term) => term.length >= 4);
  if (!terms.length) return true;
  return terms.some((term) => haystack.includes(term));
}

function screenPaper(input, protocol, filters = {}) {
  const paper = annotateSource(input);
  const reasons = [];
  const year = Number(paper.year);
  if (!passesIntegrityFilters(paper, filters)) {
    if (['retracted', 'withdrawn'].includes(paper.integrityStatus)) reasons.push('unsafe_editorial_status');
    else if (paper.publicationStage === 'preprint') reasons.push('preprint_excluded');
    else if (filters.peerReviewedOnly) reasons.push('peer_review_not_confirmed');
    else if (filters.studyTypeRequired) reasons.push('study_type_mismatch');
    else reasons.push('integrity_filter_failed');
  }
  if (filters.yearFrom && (!Number.isFinite(year) || year < filters.yearFrom)) reasons.push('outside_year_range');
  if (filters.yearTo && (!Number.isFinite(year) || year > filters.yearTo)) reasons.push('outside_year_range');
  if (filters.openAccessOnly && !(paper.openAccess === true || paper.pdfUrl)) reasons.push('open_access_required');
  if (reasons.length) return { decision: 'exclude', reasons: Array.from(new Set(reasons)), stage: 'title_abstract' };

  const text = `${paper.title || ''} ${paper.abstract || ''}`;
  const anchors = protocol.framework === 'pico'
    ? ['population', 'intervention']
    : (protocol.framework === 'spider' ? ['sample', 'phenomenon'] : []);
  const missingAnchors = anchors.filter((field) => protocol.fields[field] && !fieldCoverage(text, protocol.fields[field]));
  if (!paper.abstract) return { decision: 'uncertain', reasons: ['abstract_unavailable'], stage: 'title_abstract' };
  if (missingAnchors.length) {
    return {
      decision: 'uncertain',
      reasons: missingAnchors.map((field) => `${field}_not_confirmed_from_abstract`),
      stage: 'title_abstract',
    };
  }
  return { decision: 'include', reasons: ['automatic_criteria_passed'], stage: 'title_abstract' };
}

function recommendedBiasTool(studyType) {
  if (studyType === 'rct') return 'RoB 2';
  if (['cohort', 'case_control', 'quantitative'].includes(studyType)) return 'ROBINS-I';
  if (['systematic_review', 'meta_analysis'].includes(studyType)) return 'AMSTAR 2';
  if (studyType === 'qualitative') return 'CASP qualitative checklist';
  return 'design-specific checklist required';
}

function biasDomains(studyType) {
  if (studyType === 'rct') return ['randomization', 'deviations_from_intervention', 'missing_outcome_data', 'outcome_measurement', 'selective_reporting'];
  if (['systematic_review', 'meta_analysis'].includes(studyType)) return ['protocol_registration', 'search_completeness', 'duplicate_screening', 'study_bias_assessment', 'publication_bias'];
  if (['cohort', 'case_control', 'quantitative'].includes(studyType)) return ['confounding', 'participant_selection', 'exposure_classification', 'missing_data', 'outcome_measurement', 'selective_reporting'];
  if (studyType === 'qualitative') return ['researcher_reflexivity', 'sampling_appropriateness', 'data_collection_rigor', 'analysis_rigor', 'participant_voice'];
  return ['design_appropriateness', 'participant_selection', 'missing_data', 'outcome_measurement', 'selective_reporting'];
}

function preliminaryRiskOfBias(input) {
  const paper = annotateSource(input);
  const checks = [
    { criterion: 'editorial_integrity', status: ['retracted', 'withdrawn'].includes(paper.integrityStatus) ? 'fail' : 'not_flagged' },
    { criterion: 'study_design_identified', status: paper.studyType && paper.studyType !== 'unknown' ? 'yes' : 'unknown' },
    { criterion: 'abstract_available', status: paper.abstract ? 'yes' : 'no' },
    { criterion: 'statistics_reported', status: paper.evidence?.hasStats ? 'yes' : 'not_detected' },
    { criterion: 'peer_review_metadata', status: paper.peerReviewStatus || 'unknown' },
    ...biasDomains(paper.studyType).map((criterion) => ({
      criterion,
      status: 'requires_full_text',
      evidence: 'not_available_in_metadata_or_abstract',
    })),
  ];
  let level = 'some_concerns';
  if (['retracted', 'withdrawn'].includes(paper.integrityStatus)) level = 'high';
  else if (!paper.abstract || paper.studyType === 'unknown') level = 'unknown';
  return {
    level,
    basis: 'metadata_and_abstract_preliminary',
    recommendedTool: recommendedBiasTool(paper.studyType),
    checks,
    requiresFullTextAssessment: true,
  };
}

function gradeEvidence(papers, synthesis = {}) {
  const total = papers.length;
  const highRisk = papers.filter((paper) => paper.riskOfBias?.level === 'high').length;
  const unknownRisk = papers.filter((paper) => paper.riskOfBias?.level === 'unknown').length;
  const preprints = papers.filter((paper) => paper.publicationStage === 'preprint').length;
  const robustDesigns = papers.filter((paper) => ['meta_analysis', 'systematic_review', 'rct'].includes(paper.studyType)).length;
  const reasons = [];
  let score = 2; // low; metadata-only grading cannot reach high certainty.
  if (total >= 5 && robustDesigns >= 2) score += 1;
  if (total < 3) { score -= 1; reasons.push('fewer_than_three_studies'); }
  if (highRisk > 0) { score -= 1; reasons.push('high_risk_records_present'); }
  if (unknownRisk > total / 2) { score -= 1; reasons.push('risk_of_bias_mostly_unknown'); }
  if (preprints > total / 2) { score -= 1; reasons.push('evidence_dominated_by_preprints'); }
  if ((synthesis.contradictions || []).length > (synthesis.consensus || []).length) {
    score -= 1;
    reasons.push('substantial_inconsistency');
  }
  if (!reasons.length) reasons.push('metadata_signals_consistent_but_full_text_pending');
  const levels = ['very_low', 'very_low', 'low', 'moderate'];
  const riskDomain = highRisk > 0 ? 'serious_concern' : (unknownRisk > total / 2 ? 'not_assessed' : 'some_concern');
  const inconsistencyDomain = (synthesis.contradictions || []).length > (synthesis.consensus || []).length
    ? 'serious_concern'
    : 'not_detected_from_abstracts';
  return {
    level: levels[Math.max(0, Math.min(3, score))],
    basis: 'preliminary_grade_from_metadata_and_abstracts',
    reasons,
    counts: { total, robustDesigns, highRisk, unknownRisk, preprints },
    domains: {
      riskOfBias: riskDomain,
      inconsistency: inconsistencyDomain,
      indirectness: 'requires_full_text_and_population_comparison',
      imprecision: 'requires_effect_estimates_and_confidence_intervals',
      publicationBias: 'requires_protocol_level_assessment',
    },
    requiresFullTextAssessment: true,
  };
}

function buildPrismaFlow({ identified = 0, deduped = 0, screened = [], included = 0 }) {
  const excluded = screened.filter((entry) => entry.screening?.decision === 'exclude');
  const uncertain = screened.filter((entry) => entry.screening?.decision === 'uncertain');
  const exclusionReasons = {};
  for (const paper of excluded) {
    for (const reason of paper.screening.reasons || []) exclusionReasons[reason] = (exclusionReasons[reason] || 0) + 1;
  }
  const eligibleAfterScreening = Math.max(0, deduped - excluded.length);
  return {
    scope: 'PRISMA-inspired preliminary flow from metadata and abstracts',
    identification: { recordsIdentified: identified },
    deduplication: { uniqueRecords: deduped, duplicatesRemoved: Math.max(0, identified - deduped) },
    screening: {
      recordsScreened: screened.length,
      recordsExcluded: excluded.length,
      recordsUncertain: uncertain.length,
      exclusionReasons,
    },
    retrieval: {
      reportsSought: eligibleAfterScreening,
      fullTextAssessmentPending: eligibleAfterScreening,
    },
    eligibility: { fullTextReportsAssessed: 0, fullTextReportsExcluded: 0 },
    included: { studiesInPreliminarySynthesis: included },
  };
}

module.exports = {
  buildBooleanQuery,
  buildPrismaFlow,
  buildProtocol,
  detectFramework,
  extractFrameworkFields,
  gradeEvidence,
  isSystematicReviewRequest,
  preliminaryRiskOfBias,
  screenPaper,
  _internal: { biasDomains, fieldCoverage, normaliseText, recommendedBiasTool, FRAMEWORK_FIELDS, FIELD_ALIASES },
};
