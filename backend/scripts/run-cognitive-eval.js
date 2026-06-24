#!/usr/bin/env node
'use strict';

/**
 * run-cognitive-eval.js — deterministic regression eval for the cognitive core.
 * ───────────────────────────────────────────────────────────────────────────
 * Feeds a labeled dataset through reasoning-orchestrator.decide() and scores the
 * brain's DECISIONS (difficulty, risk, risk-domains, test-time-compute mode,
 * verification plan) against human-intended labels. No LLM call — fully
 * deterministic, so it can gate CI and catch regressions in the routing /
 * difficulty / risk / compute logic.
 *
 * Usage:
 *   node scripts/run-cognitive-eval.js [--dataset=path.json] [--json] [--strict] [--min=0.85]
 *
 * Exit code: 0 if overall accuracy >= min (default 0.85), else 1 (when --strict
 * or run as a CLI). The test wrapper imports runEval() directly.
 */

const fs = require('fs');
const path = require('path');

const orchestrator = require('../src/services/reasoning-orchestrator');

const DIMENSIONS = ['difficulty', 'risk', 'riskDomains', 'compute', 'verifyFaithfulness'];

function loadDataset(p) {
  const file = p || path.join(__dirname, '..', 'tests', 'fixtures', 'cognitive-eval-dataset.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function checkDimension(dim, expected, decision) {
  switch (dim) {
    case 'difficulty': return decision.difficulty.bucket === expected;
    case 'risk': return decision.risk.level === expected;
    case 'riskDomains':
      return Array.isArray(expected) && expected.every((d) => (decision.risk.domains || []).includes(d));
    case 'compute': return decision.compute.mode === expected;
    case 'verifyFaithfulness': return decision.verify.faithfulness === expected;
    default: return false;
  }
}

function runEval(dataset, opts = {}) {
  const data = dataset || loadDataset(opts.dataset);
  const defaults = data.defaults || {};
  const perDim = Object.fromEntries(DIMENSIONS.map((d) => [d, { correct: 0, total: 0 }]));
  const failures = [];
  let checks = 0;
  let correct = 0;

  for (const c of data.cases || []) {
    const decision = orchestrator.decide({
      prompt: c.prompt,
      userModel: c.userModel || defaults.userModel || 'gpt-4o-mini',
      userProvider: 'OpenAI',
      plan: c.plan || defaults.plan || 'PRO',
      routingMode: c.routingMode || defaults.routingMode || 'escalate',
      hasGrounding: !!c.hasGrounding,
      language: c.lang || 'es',
    });
    const expect = c.expect || {};
    for (const dim of DIMENSIONS) {
      if (!(dim in expect)) continue;
      const ok = checkDimension(dim, expect[dim], decision);
      perDim[dim].total += 1;
      checks += 1;
      if (ok) { perDim[dim].correct += 1; correct += 1; }
      else {
        failures.push({
          id: c.id,
          dimension: dim,
          expected: expect[dim],
          got: dim === 'difficulty' ? decision.difficulty.bucket
            : dim === 'risk' ? decision.risk.level
            : dim === 'riskDomains' ? decision.risk.domains
            : dim === 'compute' ? decision.compute.mode
            : decision.verify.faithfulness,
        });
      }
    }
  }

  const accuracy = checks ? correct / checks : 1;
  const byDimension = Object.fromEntries(
    DIMENSIONS.map((d) => [d, perDim[d].total ? round(perDim[d].correct / perDim[d].total) : null])
  );
  return {
    cases: (data.cases || []).length,
    checks,
    correct,
    accuracy: round(accuracy),
    byDimension,
    failures,
  };
}

function round(n) { return Math.round(n * 1000) / 1000; }

function parseArgs(argv) {
  const o = {};
  for (const a of argv) {
    if (a.startsWith('--dataset=')) o.dataset = a.slice('--dataset='.length);
    else if (a === '--json') o.json = true;
    else if (a === '--strict') o.strict = true;
    else if (a.startsWith('--min=')) o.min = Number(a.slice('--min='.length));
  }
  return o;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const min = Number.isFinite(opts.min) ? opts.min : 0.85;
  const report = runEval(null, opts);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(`Cognitive eval: ${report.correct}/${report.checks} checks across ${report.cases} cases — accuracy ${report.accuracy}`);
    for (const [dim, acc] of Object.entries(report.byDimension)) {
      if (acc != null) console.log(`  ${dim.padEnd(18)} ${acc}`);
    }
    if (report.failures.length) {
      console.log('Failures:');
      for (const f of report.failures) {
        console.log(`  [${f.id}] ${f.dimension}: expected ${JSON.stringify(f.expected)} got ${JSON.stringify(f.got)}`);
      }
    }
  }
  if (report.accuracy < min) {
    console.error(`::cognitive-eval:: accuracy ${report.accuracy} < min ${min}`);
    if (opts.strict || !opts.json) process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { runEval, loadDataset, checkDimension, DIMENSIONS };
