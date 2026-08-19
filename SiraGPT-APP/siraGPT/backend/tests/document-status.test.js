'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-status');
const { extractStatus, buildStatusForFiles, renderStatusBlock, _internal } = engine;
const { bucketFor } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractStatus('').total, 0);
  assert.equal(extractStatus(null).total, 0);
});

test('bucketFor: draft / approved / deprecated / etc.', () => {
  assert.equal(bucketFor('Draft'), 'draft');
  assert.equal(bucketFor('Approved'), 'approved');
  assert.equal(bucketFor('Deprecated'), 'deprecated');
  assert.equal(bucketFor('Active'), 'active');
  assert.equal(bucketFor('Beta'), 'pre-release');
  assert.equal(bucketFor('Archived'), 'archived');
});

test('bucketFor: Spanish equivalents', () => {
  assert.equal(bucketFor('Borrador'), 'draft');
  assert.equal(bucketFor('Aprobado'), 'approved');
  assert.equal(bucketFor('Obsoleto'), 'deprecated');
  assert.equal(bucketFor('Activo'), 'active');
  assert.equal(bucketFor('En revisión'), 'review');
});

test('bucketFor: unknown returns null', () => {
  assert.equal(bucketFor('flarn'), null);
});

test('detects Status: Draft', () => {
  const r = extractStatus('Status: Draft\nDocument body.');
  assert.ok(r.entries.some((e) => e.bucket === 'draft'));
});

test('detects Status: Approved', () => {
  const r = extractStatus('Status: Approved');
  assert.ok(r.entries.some((e) => e.bucket === 'approved'));
});

test('detects Stage: Beta', () => {
  const r = extractStatus('Stage: Beta');
  assert.ok(r.entries.some((e) => e.bucket === 'pre-release'));
});

test('detects Spanish Estado: Aprobado', () => {
  const r = extractStatus('Estado: Aprobado');
  assert.ok(r.entries.some((e) => e.bucket === 'approved'));
});

test('detects inline [DRAFT] callout', () => {
  const r = extractStatus('# Title [DRAFT]\nBody.');
  assert.ok(r.entries.some((e) => e.bucket === 'draft' && e.kind === 'callout'));
});

test('detects inline DEPRECATED: callout', () => {
  const r = extractStatus('DEPRECATED: use the new endpoint.');
  assert.ok(r.entries.some((e) => e.bucket === 'deprecated'));
});

test('detects SUPERSEDED', () => {
  const r = extractStatus('SUPERSEDED by RFC-42.');
  assert.ok(r.entries.some((e) => e.bucket === 'deprecated'));
});

test('counts byBucket', () => {
  const r = extractStatus('Status: Draft\nStage: Beta\nStatus: Approved');
  assert.ok(r.byBucket.draft >= 1);
  assert.ok(r.byBucket.approved >= 1);
  assert.ok(r.byBucket['pre-release'] >= 1);
});

test('dedupes identical entries', () => {
  const r = extractStatus('Status: Draft\nStatus: Draft');
  assert.equal(r.entries.filter((e) => e.bucket === 'draft' && e.kind === 'labeled').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `Status: Draft v${i}\n`;
  const r = extractStatus(text);
  assert.ok(r.entries.length <= 16);
});

test('handles multi-token "in review"', () => {
  const r = extractStatus('Status: In Review');
  assert.ok(r.entries.some((e) => e.bucket === 'review'));
});

test('handles "RFC" as review state', () => {
  const r = extractStatus('Lifecycle: RFC');
  assert.ok(r.entries.some((e) => e.bucket === 'review'));
});

test('ignores Status: with non-recognised value', () => {
  const r = extractStatus('Status: PendingDinner');
  // PendingDinner is not in bucket map → ignored
  assert.equal(r.entries.length, 0);
});

test('buildStatusForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Status: Draft' },
    { name: 'b.md', extractedText: 'Status: Approved' },
  ];
  const r = buildStatusForFiles(files);
  assert.equal(r.perFile.length, 2);
  assert.equal(r.byBucket.draft, 1);
  assert.equal(r.byBucket.approved, 1);
});

test('renderStatusBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Status: Draft' }];
  const r = buildStatusForFiles(files);
  const md = renderStatusBlock(r);
  assert.match(md, /^## DOCUMENT STATUS \/ LIFECYCLE/);
});

test('renderStatusBlock empty when nothing surfaces', () => {
  assert.equal(renderStatusBlock({ perFile: [] }), '');
  assert.equal(renderStatusBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildStatusForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Status: Draft' },
  ]);
  assert.equal(r.perFile.length, 1);
});
