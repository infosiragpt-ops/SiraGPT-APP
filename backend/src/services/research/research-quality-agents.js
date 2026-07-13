'use strict';

const crypto = require('node:crypto');
const {
  extractApaCitations,
  extractDois,
  normaliseDoi,
} = require('../thesis/citation-verifier');
const { findingDirection, splitSentences } = require('./evidence-extractor');

const SOURCE_LABEL_RE = /\[S(\d{1,3})\]/gi;
const NUMBER_RE = /\b\d+(?:[.,]\d+)?\s*%?|\bp\s*[<=>]\s*0?\.\d+/gi;
const CLAIM_SIGNAL_RE = /\b(result|found|finding|show|effect|associated|increase|decrease|significant|resultado|hallazgo|mostr|efecto|asociad|aument|disminu|significativ)/i;

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function round(value) {
  return Math.round(clamp(value) * 1000) / 1000;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value) {
  return Array.from(new Set(normalizeText(value).split(' ')
    .filter((token) => token.length >= 4 && !/^\d+$/.test(token))));
}

function numberTokens(value) {
  return Array.from(new Set((String(value || '').match(NUMBER_RE) || [])
    .map((item) => normalizeText(item).replace(/\s+/g, ''))));
}

function overlapScore(claim, evidence) {
  const wanted = tokens(claim);
  if (!wanted.length) return 0;
  const available = new Set(tokens(evidence));
  return wanted.filter((token) => available.has(token)).length / wanted.length;
}

function authorNames(paper) {
  return (Array.isArray(paper?.authors) ? paper.authors : [])
    .map((author) => (typeof author === 'string' ? author : author?.name || [author?.given, author?.family].filter(Boolean).join(' ')))
    .map((name) => String(name || '').trim())
    .filter(Boolean);
}

function sourceText(paper) {
  const findings = (paper?.evidence?.findings || []).map((item) => item?.sentence).filter(Boolean);
  return [
    paper?.title,
    Number.isFinite(Number(paper?.year)) ? String(paper.year) : null,
    typeof paper?.abstract === 'string' ? paper.abstract.slice(0, 50_000) : null,
    typeof paper?.fullText === 'string' ? paper.fullText.slice(0, 250_000) : null,
    ...findings,
  ].filter(Boolean).join(' ');
}

function sourceRef(paper, index) {
  return {
    label: `[S${index + 1}]`,
    index,
    doi: normaliseDoi(paper?.doi),
    title: String(paper?.title || 'Untitled').slice(0, 500),
    year: Number(paper?.year) || null,
  };
}

function assessSourceQuality(paper, index) {
  const reasons = [];
  let score = 0.25;
  if (paper?.title) score += 0.08;
  if (authorNames(paper).length) score += 0.08;
  if (Number.isFinite(Number(paper?.year))) score += 0.05;
  if (paper?.doi) score += 0.08;
  if (paper?.abstract) score += 0.1;
  if (paper?.fullText) score += 0.12;
  if (paper?.peerReviewStatus === 'confirmed') score += 0.1;
  else if (paper?.peerReviewStatus === 'likely_peer_reviewed') score += 0.05;
  if (['systematic_review', 'meta_analysis', 'rct'].includes(paper?.studyType || paper?.evidence?.studyType)) score += 0.08;
  if ((paper?.sources?.length || paper?.sourceCount || 1) > 1) score += 0.04;
  if (paper?.riskOfBias?.level === 'high') { score -= 0.25; reasons.push('high_risk_of_bias'); }
  if (paper?.riskOfBias?.level === 'unknown') reasons.push('risk_of_bias_unknown');
  if (['retracted', 'withdrawn'].includes(paper?.integrityStatus)) { score = 0; reasons.push('unsafe_editorial_status'); }
  if (paper?.integrityStatus === 'expression_of_concern') { score -= 0.35; reasons.push('expression_of_concern'); }
  if (paper?.publicationStage === 'preprint') { score -= 0.12; reasons.push('preprint'); }
  if (!paper?.abstract && !paper?.fullText) reasons.push('evidence_text_unavailable');
  score = round(score);
  return {
    ...sourceRef(paper, index),
    score,
    level: score >= 0.75 ? 'high' : (score >= 0.5 ? 'moderate' : 'low'),
    reasons,
    textAvailable: Boolean(paper?.abstract || paper?.fullText),
  };
}

function claimCandidates(input = {}) {
  if (Array.isArray(input.claims) && input.claims.length) {
    return input.claims.slice(0, 100).map((claim) => (
      typeof claim === 'string'
        ? { text: claim, sourceIndexes: [] }
        : {
            text: String(claim?.text || claim?.claim || '').trim(),
            sourceIndexes: Array.isArray(claim?.sourceIndexes) ? claim.sourceIndexes : [],
          }
    )).filter((claim) => claim.text);
  }
  const synthesis = input.synthesis || {};
  const claims = [];
  for (const item of synthesis.keyFindings || []) {
    if (item?.sentence) claims.push({ text: item.sentence, sourceIndexes: [item.paperIndex] });
  }
  for (const item of synthesis.consensusEvidence || []) {
    if (item?.text) claims.push({ text: item.text, sourceIndexes: item.paperIndexes || [] });
  }
  for (const item of synthesis.contradictionEvidence || []) {
    if (item?.text) claims.push({ text: item.text, sourceIndexes: item.paperIndexes || [], declaredContradiction: true });
  }
  return claims.slice(0, 100);
}

function supportingSentence(paper, claim) {
  const sentences = splitSentences(sourceText(paper));
  let best = null;
  for (const sentence of sentences) {
    const score = overlapScore(claim, sentence);
    if (!best || score > best.score) best = { sentence, score };
  }
  return best || { sentence: '', score: 0 };
}

function evaluateClaim(claim, papers, qualities, claimIndex) {
  const indexes = claim.sourceIndexes.length
    ? Array.from(new Set(claim.sourceIndexes.filter((index) => Number.isInteger(index) && papers[index])))
    : papers.map((_, index) => index);
  const claimNumbers = numberTokens(claim.text);
  const claimDirection = findingDirection(claim.text);
  const evidence = indexes.map((index) => {
    const paper = papers[index];
    const best = supportingSentence(paper, claim.text);
    const sourceNumbers = numberTokens(sourceText(paper));
    const missingNumbers = claimNumbers.filter((number) => !sourceNumbers.includes(number));
    const evidenceDirection = findingDirection(best.sentence);
    const directionConflict = ['positive', 'negative'].includes(claimDirection)
      && ['positive', 'negative'].includes(evidenceDirection)
      && claimDirection !== evidenceDirection;
    const support = round(best.score * (missingNumbers.length ? 0.45 : 1) * (directionConflict ? 0.25 : 1));
    return {
      source: sourceRef(paper, index),
      support,
      quality: qualities[index].score,
      evidence: best.sentence.slice(0, 500) || null,
      missingNumbers,
      directionConflict,
    };
  }).sort((a, b) => (b.support * b.quality) - (a.support * a.quality));
  const strong = evidence.filter((item) => item.support >= 0.5 && item.quality >= 0.45);
  const partial = evidence.filter((item) => item.support >= 0.28);
  const conflicts = evidence.filter((item) => item.directionConflict);
  let verdict = 'unsupported';
  if (claim.declaredContradiction && partial.length >= 2) verdict = 'contradictory_evidence';
  else if (conflicts.length && !strong.length) verdict = 'contradicted';
  else if (strong.length) verdict = 'supported';
  else if (partial.length) verdict = 'partially_supported';
  return {
    id: `claim-${claimIndex + 1}`,
    text: claim.text,
    verdict,
    confidence: round(Math.max(0, ...evidence.map((item) => item.support * item.quality))),
    supportingSources: evidence.filter((item) => item.support >= 0.28).slice(0, 8),
    conflictingSources: conflicts.slice(0, 8),
    checks: {
      numericClaims: claimNumbers,
      sourceCountChecked: evidence.length,
      explicitSourceIndexes: claim.sourceIndexes.length > 0,
    },
  };
}

function critiqueEvidence(input = {}) {
  const papers = Array.isArray(input.papers) ? input.papers.slice(0, 100) : [];
  const qualities = papers.map(assessSourceQuality);
  const claims = claimCandidates(input).map((claim, index) => evaluateClaim(claim, papers, qualities, index));
  const counts = claims.reduce((acc, claim) => {
    acc[claim.verdict] = (acc[claim.verdict] || 0) + 1;
    return acc;
  }, {});
  const contradictions = (input.synthesis?.contradictionEvidence || []).slice(0, 50).map((item, index) => ({
    id: `contradiction-${index + 1}`,
    text: item.text,
    theme: item.theme || null,
    sources: (item.paperIndexes || []).filter((paperIndex) => papers[paperIndex]).map((paperIndex) => sourceRef(papers[paperIndex], paperIndex)),
    tally: item.tally || null,
  }));
  return {
    agent: 'evidence_critic',
    status: claims.some((claim) => ['unsupported', 'contradicted'].includes(claim.verdict)) ? 'needs_review' : 'complete',
    summary: {
      claimsReviewed: claims.length,
      sourcesReviewed: papers.length,
      ...counts,
      averageSourceQuality: round(qualities.reduce((sum, item) => sum + item.score, 0) / Math.max(1, qualities.length)),
    },
    claims,
    sources: qualities,
    contradictions,
  };
}

function citationContext(text, marker) {
  const index = text.toLocaleLowerCase().indexOf(String(marker || '').toLocaleLowerCase());
  if (index < 0) return '';
  const before = text.lastIndexOf('.', index - 1);
  const after = text.indexOf('.', index + marker.length);
  return text.slice(Math.max(0, before + 1), after < 0 ? Math.min(text.length, index + marker.length + 400) : after + 1).trim();
}

function citationIndex(references) {
  const byDoi = new Map();
  const byAuthorYear = new Map();
  references.forEach((paper, index) => {
    const doi = normaliseDoi(paper?.doi);
    if (doi) byDoi.set(doi, index);
    const year = Number(paper?.year);
    for (const name of authorNames(paper)) {
      const family = normalizeText(name).split(' ').filter(Boolean).pop();
      if (family && year) byAuthorYear.set(`${family}:${year}`, index);
    }
  });
  return { byDoi, byAuthorYear };
}

function citationAssessment({ type, marker, referenceIndex, context }, references) {
  const paper = Number.isInteger(referenceIndex) ? references[referenceIndex] : null;
  if (!paper) return { type, marker, verdict: 'unverified', metadataMatch: false, textSupport: 'not_checked', context: context.slice(0, 500), source: null };
  const cleanClaim = context.replace(marker, ' ');
  const available = sourceText(paper);
  const score = overlapScore(cleanClaim, available);
  const claimNumbers = numberTokens(cleanClaim);
  const evidenceNumbers = numberTokens(available);
  const missingNumbers = claimNumbers.filter((number) => !evidenceNumbers.includes(number));
  let textSupport = 'unavailable';
  if (available) textSupport = missingNumbers.length ? 'numeric_mismatch' : (score >= 0.2 ? 'supported' : 'weak');
  let verdict = 'metadata_only';
  if (textSupport === 'supported') verdict = 'verified';
  else if (textSupport === 'numeric_mismatch') verdict = 'mismatch';
  else if (textSupport === 'weak') verdict = 'weak_support';
  return {
    type,
    marker,
    verdict,
    metadataMatch: true,
    textSupport,
    supportScore: round(score),
    missingNumbers,
    context: context.slice(0, 500),
    source: sourceRef(paper, referenceIndex),
  };
}

function verifyScientificCitations(text, references = []) {
  const content = String(text || '');
  const refs = Array.isArray(references) ? references.slice(0, 200) : [];
  const index = citationIndex(refs);
  const items = [];
  for (const doi of extractDois(content)) {
    const marker = doi;
    items.push(citationAssessment({ type: 'doi', marker, referenceIndex: index.byDoi.get(doi), context: citationContext(content, marker) }, refs));
  }
  for (const cite of extractApaCitations(content)) {
    const family = normalizeText(cite.author).split(' ').filter((part) => !['et', 'al', 'and'].includes(part)).pop();
    items.push(citationAssessment({ type: 'author_year', marker: cite.raw, referenceIndex: index.byAuthorYear.get(`${family}:${cite.year}`), context: citationContext(content, cite.raw) }, refs));
  }
  SOURCE_LABEL_RE.lastIndex = 0;
  let match;
  while ((match = SOURCE_LABEL_RE.exec(content)) !== null) {
    const marker = match[0];
    items.push(citationAssessment({ type: 'source_label', marker, referenceIndex: Number(match[1]) - 1, context: citationContext(content, marker) }, refs));
  }
  const unique = Array.from(new Map(items.map((item) => [`${item.type}:${item.marker}:${item.context}`, item])).values());
  const textEligible = unique.filter((item) => item.metadataMatch && item.textSupport !== 'unavailable');
  const sentences = splitSentences(content);
  const uncitedClaims = sentences.filter((sentence) => (
    CLAIM_SIGNAL_RE.test(sentence)
    && numberTokens(sentence).length > 0
    && !extractDois(sentence).length
    && !extractApaCitations(sentence).length
    && !/\[S\d{1,3}\]/i.test(sentence)
  )).slice(0, 50);
  const metadataVerified = unique.filter((item) => item.metadataMatch).length;
  const textVerified = unique.filter((item) => item.textSupport === 'supported').length;
  return {
    agent: 'citation_verifier',
    status: unique.some((item) => ['unverified', 'mismatch'].includes(item.verdict)) || uncitedClaims.length ? 'needs_review' : 'complete',
    summary: {
      citationsChecked: unique.length,
      metadataVerified,
      textVerified,
      metadataCoverage: round(metadataVerified / Math.max(1, unique.length)),
      textCoverage: round(textVerified / Math.max(1, textEligible.length)),
      uncitedClaims: uncitedClaims.length,
    },
    citations: unique,
    uncitedClaims,
  };
}

function stage(id, status, details = {}) {
  return { id, status, details };
}

function buildSystematicReviewAudit(review = {}, agents = {}) {
  const papers = review.papers || [];
  const screening = review.screeningDecisions || [];
  const critic = agents.evidenceCritic || critiqueEvidence({ papers, synthesis: review.synthesis });
  const citations = agents.citationVerifier || verifyScientificCitations(review.report, papers);
  const humanReviewQueue = [];
  for (const decision of screening.filter((item) => item.screening?.decision === 'uncertain')) {
    humanReviewQueue.push({ type: 'screening', title: decision.title, reasons: decision.screening.reasons || [] });
  }
  for (const claim of critic.claims.filter((item) => ['unsupported', 'contradicted', 'partially_supported'].includes(item.verdict))) {
    humanReviewQueue.push({ type: 'claim', claimId: claim.id, verdict: claim.verdict, text: claim.text });
  }
  for (const citation of citations.citations.filter((item) => item.verdict !== 'verified')) {
    humanReviewQueue.push({ type: 'citation', marker: citation.marker, verdict: citation.verdict });
  }
  const stages = [
    stage('strategy', review.protocol ? 'complete' : 'needs_input', { framework: review.protocol?.framework || null, queries: review.meta?.queriesRun || [] }),
    stage('retrieval', 'complete', { providers: review.meta?.providers || [], identified: review.prisma?.identification?.recordsIdentified ?? papers.length }),
    stage('deduplication', 'complete', review.prisma?.deduplication || { uniqueRecords: papers.length }),
    stage('screening', screening.length ? 'complete' : 'not_applicable', { decisions: screening.length, excluded: review.meta?.screeningExcluded || 0, uncertain: review.meta?.screeningUncertain || 0 }),
    stage('extraction', papers.every((paper) => paper.evidence) ? 'complete' : 'needs_review', { studies: papers.length }),
    stage('critical_appraisal', critic.status === 'complete' ? 'complete' : 'needs_review', critic.summary),
    stage('synthesis', review.synthesis ? 'complete' : 'needs_review', { claims: critic.summary.claimsReviewed || 0, contradictions: critic.contradictions.length }),
    stage('citation_verification', citations.status === 'complete' ? 'complete' : 'needs_review', citations.summary),
  ];
  const checkpoint = crypto.createHash('sha256').update(JSON.stringify({
    query: review.query?.normalized || review.query || '',
    paperIds: papers.map((paper) => normaliseDoi(paper.doi) || normalizeText(paper.title)),
    stages: stages.map((item) => [item.id, item.status]),
  })).digest('hex').slice(0, 24);
  return {
    agent: 'systematic_review',
    status: humanReviewQueue.length ? 'requires_human_review' : 'complete',
    checkpoint,
    resumable: true,
    stages,
    humanReviewQueue: humanReviewQueue.slice(0, 100),
    completion: {
      completedStages: stages.filter((item) => item.status === 'complete').length,
      totalStages: stages.length,
      includedStudies: papers.length,
    },
  };
}

module.exports = {
  assessSourceQuality,
  buildSystematicReviewAudit,
  critiqueEvidence,
  verifyScientificCitations,
  _internal: {
    claimCandidates,
    citationIndex,
    normalizeText,
    numberTokens,
    overlapScore,
    sourceText,
  },
};
