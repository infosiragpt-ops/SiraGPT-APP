'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  READINESS_LANES,
  buildOpsReadinessReport,
  assertOpsReady,
} = require('../src/services/agents/platform-ops-readiness');

test('ops readiness covers config deploy security qa and automation', () => {
  const ids = new Set(READINESS_LANES.map((lane) => lane.id));
  for (const expected of ['config', 'deploy', 'security', 'qa', 'automation']) {
    assert.ok(ids.has(expected), `expected ${expected}`);
  }
});

test('ops readiness reports current repo as ready', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const report = buildOpsReadinessReport({ repoRoot });
  assert.equal(report.status, 'ready', report.missing.join(', '));
  assert.equal(report.counts.missing, 0);
  assert.equal(report.score, 1);
});

test('assertOpsReady returns report when no required operational files are missing', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const report = assertOpsReady({ repoRoot });
  assert.ok(report.counts.total >= 20);
});
