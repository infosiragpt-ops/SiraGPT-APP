'use strict';

/**
 * F9 evals — pass-rate summary for the admin dashboard.
 *
 * `GET /api/admin/evals/summary` (wired in routes/admin.js behind the
 * declarative admin route policy) serves:
 *
 *   {
 *     generatedAt,
 *     categories: [{ name, passed, failed, passRate }],
 *     variants:   [{ variant, passed, failed, passRate }],
 *     winner, totals
 *   }
 *
 * Data source: the last persisted harness run + optimizer scorecard. When
 * neither exists yet (fresh process, empty dir) the mocked built-in suite
 * and the held-out optimizer run on demand — both are scripted and finish
 * in milliseconds with zero LLM calls, so the dashboard is never empty.
 */

const { runSuite, getLastRun } = require('./harness');
const { optimizePrompt, getLastScorecard } = require('./optimizer');
const { getExperiments, seedFromScorecard } = require('./experiments');

async function buildEvalsSummary({ refresh = false, env = process.env } = {}) {
  let run = refresh ? null : getLastRun({ env });
  if (!run) run = await runSuite({ env });

  let scorecard = refresh ? null : getLastScorecard({ env });
  if (!scorecard) scorecard = await optimizePrompt({ env });

  let variants = getExperiments();
  if (!variants.length) {
    // Persisted scorecard from a previous process: mirror it into the
    // in-memory A/B table so the dashboard always has per-variant rows.
    seedFromScorecard(scorecard.scorecard || []);
    variants = getExperiments();
  }

  return {
    generatedAt: run.generatedAt,
    categories: run.categories,
    variants,
    winner: scorecard.winner ?? null,
    totals: {
      scenarios: run.total,
      passed: run.passed,
      failed: run.failed,
      passRate: run.total ? Math.round((run.passed / run.total) * 1000) / 1000 : 0,
    },
  };
}

/**
 * Express handler for GET /api/admin/evals/summary. Kept here (not in
 * routes/admin.js) so tests can call it with a stub req/res without
 * loading the full admin router. Auth/permissions are enforced upstream
 * by the admin router middleware + declarative route policy.
 */
async function evalsSummaryHandler(req, res) {
  try {
    const refresh = String(req?.query?.refresh || '') === '1';
    const summary = await buildEvalsSummary({ refresh });
    res.json(summary);
  } catch (err) {
    res.status(500).json({
      error: 'Failed to build evals summary',
      detail: err?.message || String(err),
    });
  }
}

module.exports = {
  buildEvalsSummary,
  evalsSummaryHandler,
};
