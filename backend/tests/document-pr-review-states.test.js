'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-pr-review-states');
const { extractPrReviewStates, buildPrReviewStatesForFiles, renderPrReviewStatesBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractPrReviewStates('').total, 0);
  assert.equal(extractPrReviewStates(null).total, 0);
});

test('detects LGTM', () => {
  const r = extractPrReviewStates('LGTM, ready to merge.');
  assert.ok(r.entries.some((e) => e.kind === 'approval'));
});

test('detects "looks good to me"', () => {
  const r = extractPrReviewStates('Code looks good to me.');
  assert.ok(r.entries.some((e) => e.kind === 'approval'));
});

test('detects "ship it"', () => {
  const r = extractPrReviewStates('Ship it!');
  assert.ok(r.entries.some((e) => e.kind === 'approval'));
});

test('detects "approved"', () => {
  const r = extractPrReviewStates('Reviewer approved the changes.');
  assert.ok(r.entries.some((e) => e.kind === 'approval'));
});

test('detects :lgtm: emoji', () => {
  const r = extractPrReviewStates(':lgtm: from senior eng');
  assert.ok(r.entries.some((e) => e.kind === 'approval'));
});

test('detects :+1: emoji as approval', () => {
  const r = extractPrReviewStates('+1 from team :+1:');
  assert.ok(r.entries.some((e) => e.kind === 'approval'));
});

test('detects "requested changes"', () => {
  const r = extractPrReviewStates('Reviewer requested changes on file.js');
  assert.ok(r.entries.some((e) => e.kind === 'changes'));
});

test('detects "needs changes"', () => {
  const r = extractPrReviewStates('PR needs changes before merge.');
  assert.ok(r.entries.some((e) => e.kind === 'changes'));
});

test('detects ":-1:" emoji', () => {
  const r = extractPrReviewStates(':-1: blocking issue');
  assert.ok(r.entries.some((e) => e.kind === 'changes'));
});

test('detects "dismissed review"', () => {
  const r = extractPrReviewStates('Stale review dismissed.');
  assert.ok(r.entries.some((e) => e.kind === 'dismissed'));
});

test('detects "nit:" neutral feedback', () => {
  const r = extractPrReviewStates('nit: extra whitespace here');
  assert.ok(r.entries.some((e) => e.kind === 'neutral'));
});

test('detects "non-blocking"', () => {
  const r = extractPrReviewStates('non-blocking observation about naming');
  assert.ok(r.entries.some((e) => e.kind === 'neutral'));
});

test('detects "optional:" feedback', () => {
  const r = extractPrReviewStates('optional: rename helper');
  assert.ok(r.entries.some((e) => e.kind === 'neutral'));
});

test('detects +1 voting', () => {
  const r = extractPrReviewStates('+1 from me on the design');
  assert.ok(r.entries.some((e) => e.kind === 'voting'));
});

test('dedupes identical entries', () => {
  const r = extractPrReviewStates('LGTM and LGTM');
  assert.equal(r.entries.filter((e) => e.kind === 'approval' && /^LGTM$/i.test(e.snippet)).length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `LGTM ${i} `;
  const r = extractPrReviewStates(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by kind', () => {
  const r = extractPrReviewStates('LGTM and request changes and nit: thing');
  assert.ok(r.totals.approval >= 1);
  assert.ok(r.totals.changes >= 1);
  assert.ok(r.totals.neutral >= 1);
});

test('buildPrReviewStatesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'LGTM' },
    { name: 'b', extractedText: 'requested changes' },
  ];
  const r = buildPrReviewStatesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderPrReviewStatesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'pr-comments', extractedText: 'LGTM' }];
  const r = buildPrReviewStatesForFiles(files);
  const md = renderPrReviewStatesBlock(r);
  assert.match(md, /^## PR REVIEW/);
});

test('renderPrReviewStatesBlock empty when nothing surfaces', () => {
  assert.equal(renderPrReviewStatesBlock({ perFile: [] }), '');
  assert.equal(renderPrReviewStatesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildPrReviewStatesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'LGTM' },
  ]);
  assert.equal(r.perFile.length, 1);
});
