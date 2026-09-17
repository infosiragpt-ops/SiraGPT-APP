'use strict';

/**
 * F9 evals — CLI entry for `npm run test:agent-evals`.
 *
 * Runs the mocked harness (built-in bank + any PR #285 fixtures found on
 * disk) and the prompt optimizer, prints the per-category / per-variant
 * pass rates, persists the JSON artifacts, and exits non-zero when any
 * scenario failed. No network, no OpenRouter, no real sandbox.
 */

const { runSuite } = require('./harness');
const { optimizePrompt } = require('./optimizer');
const { evalsDir } = require('./harness');

function formatRate(rate) {
  return `${Math.round(rate * 1000) / 10}%`;
}

async function main() {
  const run = await runSuite({ persist: true });

  console.log(`\nAgentRunner F9 evals — ${run.generatedAt}`);
  console.log(`scenarios: ${run.total}  passed: ${run.passed}  failed: ${run.failed}\n`);
  console.log('category            passed  failed  pass-rate');
  console.log('------------------  ------  ------  ---------');
  for (const category of run.categories) {
    console.log(
      `${category.name.padEnd(18)}  ${String(category.passed).padStart(6)}  ${String(category.failed).padStart(6)}  ${formatRate(category.passRate).padStart(9)}`,
    );
  }

  for (const result of run.results.filter((r) => !r.passed)) {
    console.log(`\nFAIL ${result.id} [${result.category}]: ${result.reason}`);
  }

  const scorecard = await optimizePrompt({ persist: true });
  console.log('\nPrompt optimizer (held-out suite, winner is NOT auto-deployed):');
  for (const row of scorecard.scorecard) {
    const mark = row.variant === scorecard.winner ? ' ← winner' : '';
    console.log(`  ${row.variant.padEnd(14)} ${formatRate(row.passRate).padStart(7)} (${row.passed}/${row.passed + row.failed}, ${row.promptChars} chars)${mark}`);
  }

  console.log(`\nArtifacts persisted under: ${evalsDir()}`);

  if (run.failed > 0) {
    console.error(`\n${run.failed} scenario(s) failed.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('agent-evals harness crashed:', err);
  process.exitCode = 1;
});
