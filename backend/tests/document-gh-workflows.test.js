'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-gh-workflows');
const { extractGhWorkflows, buildGhWorkflowsForFiles, renderGhWorkflowsBlock, _internal } = engine;
const { isGhWorkflowLike } = _internal;

const WORKFLOW_FIXTURE = `name: CI
on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: npm ci
      - run: npm test
        env:
          API_TOKEN: \${{ secrets.API_TOKEN }}
          DATABASE_URL: \${{ secrets.DATABASE_URL }}

  release:
    runs-on: macos-latest
    steps:
      - uses: ./.github/actions/build-mac
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractGhWorkflows('').total, 0);
  assert.equal(extractGhWorkflows(null).total, 0);
});

test('non-workflow YAML returns empty', () => {
  const r = extractGhWorkflows('services:\n  web:\n    image: nginx\n');
  assert.equal(r.total, 0);
});

test('isGhWorkflowLike heuristic', () => {
  assert.ok(isGhWorkflowLike('on: push\njobs:\n  x:\n    runs-on: ubuntu-latest'));
  assert.ok(!isGhWorkflowLike('foo: bar'));
});

test('detects job names', () => {
  const r = extractGhWorkflows(WORKFLOW_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'job' && e.name === 'build'));
  assert.ok(r.entries.some((e) => e.kind === 'job' && e.name === 'release'));
});

test('detects runs-on platforms', () => {
  const r = extractGhWorkflows(WORKFLOW_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'runsOn' && e.name === 'ubuntu-latest'));
  assert.ok(r.entries.some((e) => e.kind === 'runsOn' && e.name === 'macos-latest'));
});

test('detects uses: action references', () => {
  const r = extractGhWorkflows(WORKFLOW_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'uses' && /actions\/checkout/.test(e.name)));
  assert.ok(r.entries.some((e) => e.kind === 'uses' && /actions\/setup-node/.test(e.name)));
});

test('detects local action uses', () => {
  const r = extractGhWorkflows(WORKFLOW_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'uses' && e.name.startsWith('./')));
});

test('detects secret names (masked)', () => {
  const r = extractGhWorkflows(WORKFLOW_FIXTURE);
  const apiTok = r.entries.find((e) => e.kind === 'secret' && e.name === 'API_TOKEN');
  assert.ok(apiTok);
  assert.equal(apiTok.detail, '*** masked ***');
  assert.ok(r.entries.some((e) => e.kind === 'secret' && e.name === 'DATABASE_URL'));
});

test('detects permissions block', () => {
  const r = extractGhWorkflows(WORKFLOW_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'permission' && e.name === 'contents' && e.detail === 'read'));
  assert.ok(r.entries.some((e) => e.kind === 'permission' && e.name === 'pull-requests' && e.detail === 'write'));
});

test('detects cancel-in-progress', () => {
  const r = extractGhWorkflows(WORKFLOW_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'cancelInProgress' && e.name === 'true'));
});

test('counts concurrency blocks', () => {
  const r = extractGhWorkflows(WORKFLOW_FIXTURE);
  assert.ok(r.totals.concurrency >= 1);
});

test('dedupes identical job names', () => {
  const r = extractGhWorkflows('on: push\njobs:\n  x:\n    runs-on: ubuntu-latest\n  x:\n    runs-on: ubuntu-latest');
  assert.equal(r.entries.filter((e) => e.kind === 'job' && e.name === 'x').length, 1);
});

test('caps entries per file', () => {
  let text = 'on: push\njobs:\n';
  for (let i = 0; i < 30; i++) text += `  job${i}:\n    runs-on: ubuntu-latest\n`;
  const r = extractGhWorkflows(text);
  assert.ok(r.entries.length <= 24);
});

test('counts totals by kind', () => {
  const r = extractGhWorkflows(WORKFLOW_FIXTURE);
  assert.ok(r.totals.job >= 2);
  assert.ok(r.totals.uses >= 2);
  assert.ok(r.totals.secret >= 2);
});

test('buildGhWorkflowsForFiles aggregates across batch', () => {
  const files = [
    { name: 'ci.yml', extractedText: WORKFLOW_FIXTURE },
    { name: 'release.yml', extractedText: 'on: push\njobs:\n  publish:\n    runs-on: ubuntu-latest' },
  ];
  const r = buildGhWorkflowsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderGhWorkflowsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'ci.yml', extractedText: WORKFLOW_FIXTURE }];
  const r = buildGhWorkflowsForFiles(files);
  const md = renderGhWorkflowsBlock(r);
  assert.match(md, /^## GITHUB ACTIONS/);
});

test('renderGhWorkflowsBlock empty when nothing surfaces', () => {
  assert.equal(renderGhWorkflowsBlock({ perFile: [] }), '');
  assert.equal(renderGhWorkflowsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildGhWorkflowsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: WORKFLOW_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});

test('full secret values are NEVER emitted (only names)', () => {
  const r = extractGhWorkflows(WORKFLOW_FIXTURE);
  const allText = JSON.stringify(r.entries);
  assert.ok(!/sk_[a-z]{2,}_[a-zA-Z0-9]{20,}/.test(allText));
});
