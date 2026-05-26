'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-project-codenames');
const { extractProjectCodenames, buildProjectCodenamesForFiles, renderProjectCodenamesBlock, _internal } = engine;
const { looksLikeCodename } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractProjectCodenames('').total, 0);
  assert.equal(extractProjectCodenames(null).total, 0);
});

test('looksLikeCodename: rejects all-caps and reserved', () => {
  assert.equal(looksLikeCodename('Apollo'), true);
  assert.equal(looksLikeCodename('TBD'), false);
  assert.equal(looksLikeCodename('NASA'), false);
});

test('detects "Project Apollo"', () => {
  const r = extractProjectCodenames('Launched Project Apollo last quarter');
  assert.ok(r.entries.some((e) => e.kind === 'project' && e.name === 'Apollo'));
});

test('detects "Project Phoenix"', () => {
  const r = extractProjectCodenames('Project Phoenix is moving forward.');
  assert.ok(r.entries.some((e) => e.kind === 'project' && e.name === 'Phoenix'));
});

test('detects "Operation Nightfall"', () => {
  const r = extractProjectCodenames('Operation Nightfall begins Monday.');
  assert.ok(r.entries.some((e) => e.kind === 'operation' && e.name === 'Nightfall'));
});

test('detects "Initiative Atlas"', () => {
  const r = extractProjectCodenames('Initiative Atlas spans multiple teams.');
  assert.ok(r.entries.some((e) => e.kind === 'initiative' && e.name === 'Atlas'));
});

test('detects "Workstream Reliability"', () => {
  const r = extractProjectCodenames('Workstream Reliability owns this scope.');
  assert.ok(r.entries.some((e) => e.kind === 'workstream'));
});

test('detects "Programme Skywalker" (UK spelling)', () => {
  const r = extractProjectCodenames('Programme Skywalker advancing well.');
  assert.ok(r.entries.some((e) => e.kind === 'programme'));
});

test('detects "Program Skywalker" (US spelling)', () => {
  const r = extractProjectCodenames('Program Skywalker advancing well.');
  assert.ok(r.entries.some((e) => e.kind === 'programme'));
});

test('detects labeled codename', () => {
  const r = extractProjectCodenames('codename: Atlas-Mk2');
  assert.ok(r.entries.some((e) => e.source === 'codename-prefix'));
});

test('detects parenthesised codename', () => {
  const r = extractProjectCodenames('Our service (code-name Phoenix) launches Q3.');
  assert.ok(r.entries.some((e) => e.source === 'parenthesised'));
});

test('dedupes identical entries', () => {
  const r = extractProjectCodenames('Project Apollo and Project Apollo again');
  assert.equal(r.entries.filter((e) => e.kind === 'project' && e.name === 'Apollo').length, 1);
});

test('rejects reserved like "Project Manager"', () => {
  const r = extractProjectCodenames('Project Manager allocates resources.');
  assert.equal(r.entries.filter((e) => e.name === 'Manager').length, 0);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `Project Alpha${i}. `;
  const r = extractProjectCodenames(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by kind', () => {
  const r = extractProjectCodenames(
    'Project Apollo, Operation Nightfall, Initiative Atlas, codename Phoenix'
  );
  assert.ok(r.totals.project >= 1);
  assert.ok(r.totals.operation >= 1);
  assert.ok(r.totals.initiative >= 1);
  assert.ok(r.totals.codename >= 1);
});

test('buildProjectCodenamesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'Project Apollo' },
    { name: 'b', extractedText: 'Operation Nightfall' },
  ];
  const r = buildProjectCodenamesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderProjectCodenamesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'plan.md', extractedText: 'Project Apollo' }];
  const r = buildProjectCodenamesForFiles(files);
  const md = renderProjectCodenamesBlock(r);
  assert.match(md, /^## PROJECT/);
});

test('renderProjectCodenamesBlock empty when nothing surfaces', () => {
  assert.equal(renderProjectCodenamesBlock({ perFile: [] }), '');
  assert.equal(renderProjectCodenamesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildProjectCodenamesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Project Apollo' },
  ]);
  assert.equal(r.perFile.length, 1);
});
