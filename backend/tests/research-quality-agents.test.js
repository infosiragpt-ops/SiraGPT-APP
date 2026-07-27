'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSystematicReviewAudit,
  critiqueEvidence,
  verifyScientificCitations,
} = require('../src/services/research/research-quality-agents');
const {
  runSystematicReviewAgent,
  systematicQuery,
} = require('../src/services/research/systematic-review-agent');

const PAPERS = [
  {
    title: 'Digital intervention reduces hospital admissions',
    authors: [{ name: 'María García' }, { name: 'Luis Soto' }],
    year: 2024,
    doi: '10.1234/digital.2024.1',
    abstract: 'A randomized controlled trial of 420 adults found that the digital intervention reduced hospital admissions by 25% compared with usual care.',
    peerReviewStatus: 'confirmed',
    studyType: 'rct',
    integrityStatus: 'clear',
    sources: ['pubmed', 'crossref'],
    evidence: {
      studyType: 'rct',
      findings: [{ sentence: 'The digital intervention reduced hospital admissions by 25% compared with usual care.', direction: 'negative', score: 5 }],
    },
    riskOfBias: { level: 'low' },
  },
  {
    title: 'Digital intervention and hospital use in rural clinics',
    authors: [{ name: 'John Smith' }],
    year: 2023,
    doi: '10.1234/digital.2023.2',
    abstract: 'The cohort study found no reduction in hospital use and reported a small increase among older participants.',
    peerReviewStatus: 'likely_peer_reviewed',
    studyType: 'cohort',
    integrityStatus: 'clear',
    evidence: {
      studyType: 'cohort',
      findings: [{ sentence: 'The study found no reduction in hospital use and a small increase among older participants.', direction: 'positive', score: 4 }],
    },
    riskOfBias: { level: 'some_concerns' },
  },
];

test('evidence critic links supported claims to quality-scored sources and rejects unsupported numbers', () => {
  const result = critiqueEvidence({
    papers: PAPERS,
    claims: [
      { text: 'The digital intervention reduced hospital admissions by 25% compared with usual care.', sourceIndexes: [0] },
      { text: 'The digital intervention reduced hospital admissions by 91%.', sourceIndexes: [0] },
    ],
  });
  assert.equal(result.agent, 'evidence_critic');
  assert.equal(result.claims[0].verdict, 'supported');
  assert.ok(result.claims[0].supportingSources[0].evidence.includes('25%'));
  assert.notEqual(result.claims[1].verdict, 'supported');
  assert.ok(result.claims[1].supportingSources.every((item) => item.missingNumbers.includes('91%')));
  assert.equal(result.sources[0].level, 'high');
});

test('evidence critic preserves declared contradictions and their source trail', () => {
  const result = critiqueEvidence({
    papers: PAPERS,
    synthesis: {
      contradictionEvidence: [{
        text: 'The evidence is split on hospital use.',
        theme: 'Hospital use',
        paperIndexes: [0, 1],
        tally: { positive: 1, negative: 1 },
      }],
    },
  });
  assert.equal(result.contradictions.length, 1);
  assert.deepEqual(result.contradictions[0].sources.map((item) => item.label), ['[S1]', '[S2]']);
});

test('citation verifier checks DOI, author-year and source labels against metadata and text', () => {
  const text = [
    'The digital intervention reduced hospital admissions by 25% [S1].',
    'This result was reported by (García, 2024) under DOI 10.1234/digital.2024.1.',
    'A separate unsupported claim cites (Inventado, 2022).',
  ].join(' ');
  const result = verifyScientificCitations(text, PAPERS);
  assert.equal(result.agent, 'citation_verifier');
  assert.ok(result.citations.some((item) => item.type === 'source_label' && item.verdict === 'verified'));
  assert.ok(result.citations.some((item) => item.type === 'doi' && item.metadataMatch));
  assert.ok(result.citations.some((item) => item.marker === '(Inventado, 2022)' && item.verdict === 'unverified'));
  assert.ok(result.summary.metadataCoverage > 0.5);
});

test('citation verifier flags a numeric mismatch even when the source label exists', () => {
  const result = verifyScientificCitations('Hospital admissions fell by 91% [S1].', PAPERS);
  const citation = result.citations.find((item) => item.type === 'source_label');
  assert.equal(citation.metadataMatch, true);
  assert.equal(citation.verdict, 'mismatch');
  assert.deepEqual(citation.missingNumbers, ['91%']);
});

test('systematic review audit exposes stages, checkpoint and human review queue', () => {
  const review = {
    query: { normalized: 'digital interventions' },
    protocol: { framework: 'pico' },
    prisma: { identification: { recordsIdentified: 4 }, deduplication: { uniqueRecords: 2 } },
    papers: PAPERS,
    synthesis: { keyFindings: [{ sentence: PAPERS[0].evidence.findings[0].sentence, paperIndex: 0 }], contradictionEvidence: [] },
    screeningDecisions: [{ title: 'Unclear abstract', screening: { decision: 'uncertain', reasons: ['abstract_unavailable'] } }],
    report: 'Hospital admissions fell by 91% [S1].',
    meta: { providers: ['pubmed'], queriesRun: ['digital interventions'], screeningUncertain: 1 },
  };
  const audit = buildSystematicReviewAudit(review);
  assert.equal(audit.agent, 'systematic_review');
  assert.equal(audit.status, 'requires_human_review');
  assert.equal(audit.resumable, true);
  assert.match(audit.checkpoint, /^[a-f0-9]{24}$/);
  assert.deepEqual(audit.stages.map((item) => item.id), [
    'strategy', 'retrieval', 'deduplication', 'screening', 'extraction', 'critical_appraisal', 'synthesis', 'citation_verification',
  ]);
  assert.ok(audit.humanReviewQueue.some((item) => item.type === 'screening'));
  assert.ok(audit.humanReviewQueue.some((item) => item.type === 'citation'));
});

test('systematic review agent forces systematic mode and emits auditable stage events', async () => {
  const events = [];
  const fakeReview = {
    query: { normalized: 'digital interventions' },
    protocol: { framework: null },
    prisma: { identification: { recordsIdentified: 2 }, deduplication: { uniqueRecords: 2 } },
    papers: PAPERS,
    synthesis: { keyFindings: [], contradictionEvidence: [] },
    screeningDecisions: [],
    report: 'The result is supported by [S1].',
    meta: { providers: ['pubmed'], queriesRun: ['digital interventions'] },
  };
  let receivedQuery = '';
  const result = await runSystematicReviewAgent('digital interventions', {
    buildReview: async (query) => { receivedQuery = query; return fakeReview; },
    onStage: (event) => events.push(event),
  });
  assert.match(receivedQuery, /^Revisión sistemática:/);
  assert.equal(result.originalQuery, 'digital interventions');
  assert.equal(result.agents.systematicReview.resumable, true);
  assert.ok(events.some((event) => event.stage === 'citation_verification'));
  assert.equal(systematicQuery('PRISMA telemedicine'), 'PRISMA telemedicine');
});

test('scientific search route registers the three specialized agent endpoints', () => {
  const router = require('../src/routes/scientific-search');
  const paths = router.stack.map((layer) => layer.route?.path).filter(Boolean);
  assert.ok(paths.includes('/agents/evidence-critic'));
  assert.ok(paths.includes('/agents/citation-verifier'));
  assert.ok(paths.includes('/agents/systematic-review'));
});
