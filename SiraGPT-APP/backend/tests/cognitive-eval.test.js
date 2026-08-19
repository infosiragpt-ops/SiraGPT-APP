'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { runEval, loadDataset, DIMENSIONS } = require('../scripts/run-cognitive-eval');

// Regression gate: the deterministic cognitive-core decisions (difficulty,
// risk, risk-domains, test-time-compute mode, verification plan) must keep
// matching the labeled dataset. A drop here means a routing/difficulty/risk
// regression — exactly what we want CI to catch.
const MIN_ACCURACY = 0.85;

describe('cognitive-core regression eval', () => {
  test('overall accuracy stays above the regression gate', () => {
    const report = runEval();
    assert.ok(
      report.accuracy >= MIN_ACCURACY,
      `cognitive-core accuracy ${report.accuracy} < ${MIN_ACCURACY}. Failures: ${JSON.stringify(report.failures)}`
    );
    assert.ok(report.checks >= 20, `expected a non-trivial number of checks, got ${report.checks}`);
  });

  test('every scored dimension is at or above the gate', () => {
    const report = runEval();
    for (const dim of DIMENSIONS) {
      const acc = report.byDimension[dim];
      if (acc == null) continue;
      assert.ok(acc >= MIN_ACCURACY, `dimension ${dim} accuracy ${acc} < ${MIN_ACCURACY}`);
    }
  });

  test('dataset is well-formed', () => {
    const data = loadDataset();
    assert.ok(Array.isArray(data.cases) && data.cases.length >= 10);
    for (const c of data.cases) {
      assert.ok(c.id && typeof c.prompt === 'string' && c.prompt.length > 0, `bad case ${JSON.stringify(c)}`);
      assert.ok(c.expect && typeof c.expect === 'object', `case ${c.id} missing expect`);
    }
  });

  test('high-stakes domains always trigger verification', () => {
    // Sanity: legal/medical/financial cases must plan a faithfulness check.
    const report = runEval();
    const verifyFailures = report.failures.filter((f) => f.dimension === 'verifyFaithfulness' && f.expected === true);
    assert.equal(verifyFailures.length, 0, `high-stakes verification regressed: ${JSON.stringify(verifyFailures)}`);
  });
});
