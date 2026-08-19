'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-gha-steps');
const { extractGhaSteps, buildGhaStepsForFiles, renderGhaStepsBlock, _internal } = engine;
const { classifyAction, parseRef } = _internal;

const WORKFLOW = `name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v3
        with:
          node-version: 20
      - uses: pnpm/action-setup@v2
      - uses: ./.github/actions/local-setup
      - uses: docker://node:20-alpine
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractGhaSteps('').total, 0);
  assert.equal(extractGhaSteps(null).total, 0);
});

test('classifyAction: official vs community vs local vs docker', () => {
  assert.equal(classifyAction('actions/checkout@v4'), 'official');
  assert.equal(classifyAction('pnpm/action-setup@v2'), 'community');
  assert.equal(classifyAction('./local'), 'local');
  assert.equal(classifyAction('docker://nginx'), 'docker');
});

test('parseRef extracts path and version', () => {
  const r = parseRef('actions/checkout@v4');
  assert.equal(r.path, 'actions/checkout');
  assert.equal(r.version, 'v4');
});

test('detects actions/checkout@v4', () => {
  const r = extractGhaSteps(WORKFLOW);
  assert.ok(r.entries.some((e) => e.ref === 'actions/checkout@v4'));
});

test('detects actions/setup-node@v3', () => {
  const r = extractGhaSteps(WORKFLOW);
  assert.ok(r.entries.some((e) => e.ref === 'actions/setup-node@v3'));
});

test('detects community action (pnpm/action-setup@v2)', () => {
  const r = extractGhaSteps(WORKFLOW);
  assert.ok(r.entries.some((e) => e.ownership === 'community'));
});

test('detects local action (./..)', () => {
  const r = extractGhaSteps(WORKFLOW);
  assert.ok(r.entries.some((e) => e.ownership === 'local'));
});

test('detects docker:// action', () => {
  const r = extractGhaSteps(WORKFLOW);
  assert.ok(r.entries.some((e) => e.ownership === 'docker'));
});

test('captures workflow name', () => {
  const r = extractGhaSteps(WORKFLOW);
  assert.equal(r.workflow, 'CI');
});

test('captures workflow triggers', () => {
  const r = extractGhaSteps(WORKFLOW);
  assert.match(r.triggers, /push/);
});

test('dedupes identical step refs', () => {
  const r = extractGhaSteps('- uses: actions/checkout@v4\n- uses: actions/checkout@v4');
  assert.equal(r.entries.filter((e) => e.ref === 'actions/checkout@v4').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `- uses: actions/setup-${i}@v1\n`;
  const r = extractGhaSteps(text);
  assert.ok(r.entries.length <= 20);
});

test('counts totals by ownership', () => {
  const r = extractGhaSteps(WORKFLOW);
  assert.ok(r.totals.official >= 2);
  assert.ok(r.totals.community >= 1);
  assert.ok(r.totals.local >= 1);
  assert.ok(r.totals.docker >= 1);
});

test('buildGhaStepsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.yml', extractedText: '- uses: actions/checkout@v4' },
    { name: 'b.yml', extractedText: '- uses: pnpm/action-setup@v2' },
  ];
  const r = buildGhaStepsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderGhaStepsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'ci.yml', extractedText: WORKFLOW }];
  const r = buildGhaStepsForFiles(files);
  const md = renderGhaStepsBlock(r);
  assert.match(md, /^## GITHUB ACTIONS/);
});

test('renderGhaStepsBlock empty when nothing surfaces', () => {
  assert.equal(renderGhaStepsBlock({ perFile: [] }), '');
  assert.equal(renderGhaStepsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildGhaStepsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '- uses: actions/checkout@v4' },
  ]);
  assert.equal(r.perFile.length, 1);
});
