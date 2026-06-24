/**
 * server/intelligence/eval/run.ts
 *
 * Assembles the deterministic understanding/routing/safety stack and runs the
 * regression suite. Exposed both as a function (used by the CI regression test)
 * and as a tiny CLI (used by `npm run eval:intelligence`).
 */

import { createDefaultClassifier } from '../core/classifier';
import { createDefaultRouter } from '../core/router';
import { createDefaultSecurityGateway } from '../core/security-gateway';
import { createStaticRegistry, createDefaultTestModels } from '../adapters/null-adapters';
import type { EvalDeps, EvalReport } from './scorer';
import { runEvalSuite } from './scorer';
import { EVAL_SUITE, type EvalCase } from './suite';

export function createEvalDeps(): EvalDeps {
  return {
    classifier: createDefaultClassifier(),
    router: createDefaultRouter(),
    registry: createStaticRegistry(createDefaultTestModels()),
    security: createDefaultSecurityGateway(),
  };
}

export async function runDefaultEval(
  cases: ReadonlyArray<EvalCase> = EVAL_SUITE
): Promise<EvalReport> {
  return runEvalSuite(cases, createEvalDeps());
}

export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push('SiraGPT Intelligence Core — Eval Regression');
  lines.push('='.repeat(48));
  lines.push(
    `Overall: ${(report.overall * 100).toFixed(1)}%  ` +
      `(${report.passedChecks}/${report.totalChecks} checks)`
  );
  lines.push('');
  lines.push('Metrics by check:');
  for (const [name, m] of Object.entries(report.metrics).sort()) {
    lines.push(`  ${name.padEnd(18)} ${(m.rate * 100).toFixed(0).padStart(3)}%  (${m.passed}/${m.total})`);
  }
  const failedCases = report.cases.filter((c) => c.score < 1);
  if (failedCases.length > 0) {
    lines.push('');
    lines.push('Imperfect cases:');
    for (const c of failedCases) {
      const failed = c.checks.filter((ch) => !ch.passed).map((ch) => `${ch.name}(${ch.detail ?? ''})`);
      lines.push(`  - ${c.id}: ${(c.score * 100).toFixed(0)}%  failed: ${failed.join(', ')}`);
    }
  }
  if (report.criticalFailures.length > 0) {
    lines.push('');
    lines.push('CRITICAL (safety) failures:');
    for (const f of report.criticalFailures) lines.push(`  ! ${f}`);
  }
  return lines.join('\n');
}

// Tiny CLI: `node .test-dist/server/intelligence/eval/run.js` (after tsc build)
// or via `npm run eval:intelligence`. Exits non-zero on regression so CI fails.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  const json = process.argv.includes('--json');
  const threshold = Number(process.env.SIRAGPT_INTELLIGENCE_EVAL_THRESHOLD || '0.9');
  runDefaultEval()
    .then((report) => {
      if (json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatReport(report)}\n`);
      }
      const ok = report.overall >= threshold && report.criticalFailures.length === 0;
      if (!ok) {
        process.stderr.write(
          `\nEval below threshold (${threshold}) or has critical failures.\n`
        );
        process.exit(1);
      }
    })
    .catch((e: unknown) => {
      process.stderr.write(`eval failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    });
}
