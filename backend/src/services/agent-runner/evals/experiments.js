'use strict';

/**
 * F9 evals — A/B experiment stub.
 *
 * The tiniest thing the dashboard needs: a per-variant tally of eval
 * outcomes (variant A vs variant B, counts, pass rate). In-memory with a
 * best-effort JSON mirror; no stats library, no significance testing —
 * that is explicitly out of scope for F9.
 */

const fs = require('fs');
const path = require('path');

const EXPERIMENTS_FILE = 'experiments.json';

/** variantId → { passed, failed } */
const table = new Map();

function roundRate(passed, failed) {
  const total = passed + failed;
  if (!total) return 0;
  return Math.round((passed / total) * 1000) / 1000;
}

/**
 * Record eval outcomes for a variant.
 * @param {string} variantId
 * @param {{ passed?: number, failed?: number }} counts
 */
function recordOutcome(variantId, { passed = 0, failed = 0 } = {}) {
  const id = String(variantId || '').trim();
  if (!id) return;
  const row = table.get(id) || { passed: 0, failed: 0 };
  row.passed += Math.max(0, Math.floor(passed));
  row.failed += Math.max(0, Math.floor(failed));
  table.set(id, row);
}

/** @returns {Array<{ variant, passed, failed, passRate }>} */
function getExperiments() {
  return [...table.entries()].map(([variant, row]) => ({
    variant,
    passed: row.passed,
    failed: row.failed,
    passRate: roundRate(row.passed, row.failed),
  }));
}

function resetExperiments() {
  table.clear();
}

/** Seed the table from an optimizer scorecard (idempotent per call site). */
function seedFromScorecard(scorecard = []) {
  for (const row of scorecard) {
    recordOutcome(row.variant, { passed: row.passed, failed: row.failed });
  }
}

function persistExperiments(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, EXPERIMENTS_FILE), JSON.stringify(getExperiments(), null, 2));
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  recordOutcome,
  getExperiments,
  resetExperiments,
  seedFromScorecard,
  persistExperiments,
  EXPERIMENTS_FILE,
};
