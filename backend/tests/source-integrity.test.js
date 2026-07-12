'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  annotateSource,
  detectIntegrityStatus,
  doiStatus,
  passesIntegrityFilters,
} = require('../src/services/research/source-integrity');

test('doiStatus validates syntax without claiming that a DOI resolves', () => {
  assert.equal(doiStatus('https://doi.org/10.1000/example.12'), 'format_valid');
  assert.equal(doiStatus('10.1/not-valid'), 'format_invalid');
  assert.equal(doiStatus(''), 'missing');
});

test('annotateSource identifies preprints and avoids peer-review claims', () => {
  const source = annotateSource({
    source: 'medrxiv',
    title: 'A randomized controlled trial preprint',
    doi: '10.1101/2026.01.02.123456',
  });

  assert.equal(source.publicationStage, 'preprint');
  assert.equal(source.peerReviewStatus, 'not_peer_reviewed');
  assert.equal(source.studyType, 'rct');
  assert.equal(source.doiStatus, 'format_valid');
});

test('OpenAlex and Crossref integrity metadata expose high-risk records', () => {
  assert.equal(detectIntegrityStatus({ raw: { is_retracted: true } }), 'retracted');
  assert.equal(detectIntegrityStatus({ raw: { 'update-to': [{ type: 'expression-of-concern' }] } }), 'expression_of_concern');
  assert.equal(detectIntegrityStatus({ raw: { relation: { 'is-corrected-by': [{ type: 'correction' }] } } }), 'corrected');
  assert.equal(detectIntegrityStatus({ raw: { relation: { 'is-retracted-by': [{ id: '10.1000/retraction' }] } } }), 'retracted');
});

test('retracted and withdrawn records are excluded unless explicitly requested', () => {
  const retracted = annotateSource({ source: 'openalex', raw: { is_retracted: true } });
  const withdrawn = annotateSource({ source: 'crossref', raw: { 'update-to': [{ type: 'withdrawal' }] } });
  assert.equal(passesIntegrityFilters(retracted, {}), false);
  assert.equal(passesIntegrityFilters(withdrawn, {}), false);
  assert.equal(passesIntegrityFilters(retracted, { includeRetracted: true }), true);
});

test('peer-review filter rejects preprints and accepts journal publications as likely', () => {
  const preprint = annotateSource({ source: 'arxiv', title: 'Working paper' });
  const journal = annotateSource({ source: 'pubmed', title: 'Published article', journal: 'Medical Journal' });
  assert.equal(passesIntegrityFilters(preprint, { peerReviewedOnly: true }), false);
  assert.equal(passesIntegrityFilters(journal, { peerReviewedOnly: true }), true);
  assert.equal(journal.peerReviewStatus, 'likely_peer_reviewed');
});
