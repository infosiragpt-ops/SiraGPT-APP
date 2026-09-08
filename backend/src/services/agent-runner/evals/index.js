'use strict';

/**
 * F9 — AgentRunner evals: harness + prompt optimizer + A/B stub + summary.
 *
 * Everything in this directory is offline by construction: the "model" is
 * a scripted client and the "sandbox" is a mock executor map, so CI and
 * the admin dashboard never spend OpenRouter credits.
 *
 * Entry points:
 *   - runSuite()            → run the fixture bank, aggregate by category
 *   - optimizePrompt()      → score prompt variants, pick (not deploy) a winner
 *   - buildEvalsSummary()   → dashboard payload for GET /api/admin/evals/summary
 *   - `npm run test:agent-evals` → cli.js, human-readable harness run
 */

const fixtures = require('./fixtures');
const harness = require('./harness');
const promptVariants = require('./prompt-variants');
const optimizer = require('./optimizer');
const experiments = require('./experiments');
const summary = require('./summary');
const scriptedLlm = require('./scripted-llm');

module.exports = {
  ...fixtures,
  ...harness,
  ...promptVariants,
  ...optimizer,
  ...experiments,
  ...summary,
  ...scriptedLlm,
};
