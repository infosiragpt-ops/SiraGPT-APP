'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-lifecycle-phases');
const { extractLifecyclePhases, buildLifecyclePhasesForFiles, renderLifecyclePhasesBlock, _internal } = engine;
const { normalisePhase } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractLifecyclePhases('').total, 0);
  assert.equal(extractLifecyclePhases(null).total, 0);
});

test('normalisePhase: lowercase + hyphen', () => {
  assert.equal(normalisePhase('General Availability'), 'general-availability');
});

test('detects alpha', () => {
  const r = extractLifecyclePhases('Currently in alpha phase');
  assert.ok(r.entries.some((e) => e.term === 'alpha' && e.bucket === 'early'));
});

test('detects beta', () => {
  const r = extractLifecyclePhases('Public beta opens next week');
  assert.ok(r.entries.some((e) => e.bucket === 'mid'));
});

test('detects GA', () => {
  const r = extractLifecyclePhases('Now GA across all regions');
  assert.ok(r.entries.some((e) => e.bucket === 'stable'));
});

test('detects deprecated', () => {
  const r = extractLifecyclePhases('This API is deprecated since v2');
  assert.ok(r.entries.some((e) => e.bucket === 'end'));
});

test('detects sunset', () => {
  const r = extractLifecyclePhases('Service sunset planned Q4');
  assert.ok(r.entries.some((e) => e.bucket === 'end'));
});

test('detects EOL', () => {
  const r = extractLifecyclePhases('EOL: 2026-01-01');
  assert.ok(r.entries.some((e) => e.bucket === 'end'));
});

test('detects "release candidate" multi-word', () => {
  const r = extractLifecyclePhases('Now in release candidate phase');
  assert.ok(r.entries.some((e) => e.bucket === 'mid'));
});

test('detects "end of life" multi-word', () => {
  const r = extractLifecyclePhases('end of life: December 2025');
  assert.ok(r.entries.some((e) => e.bucket === 'end'));
});

test('detects version-attached phase 1.2.3-beta.4', () => {
  const r = extractLifecyclePhases('Released 2.0.0-beta.3 yesterday');
  assert.ok(r.entries.some((e) => e.source === 'version'));
});

test('detects 1.0.0-rc.1', () => {
  const r = extractLifecyclePhases('Tagged 1.0.0-rc.1 today');
  assert.ok(r.entries.some((e) => e.source === 'version'));
});

test('dedupes identical entries', () => {
  const r = extractLifecyclePhases('beta and beta');
  assert.equal(r.entries.filter((e) => e.term === 'beta').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  const terms = ['alpha', 'beta', 'preview', 'canary', 'experimental', 'rc', 'GA', 'stable', 'deprecated', 'EOL', 'sunset', 'retired'];
  for (let i = 0; i < 20; i++) text += `${terms[i % terms.length]} `;
  const r = extractLifecyclePhases(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by bucket', () => {
  const r = extractLifecyclePhases('alpha then beta then GA then deprecated');
  assert.ok(r.totals.early >= 1);
  assert.ok(r.totals.mid >= 1);
  assert.ok(r.totals.stable >= 1);
  assert.ok(r.totals.end >= 1);
});

test('buildLifecyclePhasesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'in alpha' },
    { name: 'b', extractedText: 'now stable' },
  ];
  const r = buildLifecyclePhasesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderLifecyclePhasesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'rel.md', extractedText: 'in beta' }];
  const r = buildLifecyclePhasesForFiles(files);
  const md = renderLifecyclePhasesBlock(r);
  assert.match(md, /^## LIFECYCLE/);
});

test('renderLifecyclePhasesBlock empty when nothing surfaces', () => {
  assert.equal(renderLifecyclePhasesBlock({ perFile: [] }), '');
  assert.equal(renderLifecyclePhasesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildLifecyclePhasesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'in beta' },
  ]);
  assert.equal(r.perFile.length, 1);
});
