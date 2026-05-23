#!/usr/bin/env node
'use strict';

/**
 * Lightweight mutation testing baseline for backend/src/utils/.
 *
 * For each target source file:
 *   1. Generate point mutants via scripts/mutation-operators.js
 *   2. For each mutant: write the mutated source to disk, run the matching
 *      test file with `node --test`, then restore the original source.
 *   3. Classify the mutant as KILLED (test failed), SURVIVED (tests passed),
 *      or TIMEOUT (tests exceeded the per-mutant deadline).
 *
 * Usage:
 *   node scripts/mutation-baseline.js
 *   MUTATION_FILES=async-guard,circuit-breaker node scripts/mutation-baseline.js
 *   MUTATION_LIMIT=20 MUTATION_TIMEOUT_MS=20000 node scripts/mutation-baseline.js
 *   MUTATION_REPORT=docs/mutation-testing-baseline.md node scripts/mutation-baseline.js
 *
 * The runner is deliberately minimal — no extra dependencies. For richer
 * reports/AST mutations install Stryker (see backend/stryker.conf.json).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { generateMutants, applyMutant } = require('./mutation-operators');

const BACKEND_DIR = path.resolve(__dirname, '..');
const UTILS_DIR = path.join(BACKEND_DIR, 'src', 'utils');
const TESTS_DIR = path.join(BACKEND_DIR, 'tests');

function listTargets() {
  const filter = (process.env.MUTATION_FILES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const all = fs.readdirSync(UTILS_DIR).filter(f => f.endsWith('.js'));
  const targets = [];
  for (const file of all) {
    const base = file.replace(/\.js$/, '');
    if (filter.length && !filter.includes(base)) continue;
    const testFile = path.join(TESTS_DIR, `${base}.test.js`);
    if (!fs.existsSync(testFile)) continue;
    targets.push({
      name: base,
      sourcePath: path.join(UTILS_DIR, file),
      testPath: testFile,
    });
  }
  return targets;
}

function runTests(testPath, timeoutMs) {
  const result = spawnSync(process.execPath, ['--test', testPath], {
    cwd: BACKEND_DIR,
    timeout: timeoutMs,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    return { status: 'TIMEOUT', code: null };
  }
  return { status: result.status === 0 ? 'PASS' : 'FAIL', code: result.status };
}

function fmtDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

async function processTarget(target, opts) {
  const original = fs.readFileSync(target.sourcePath, 'utf8');
  const sanity = runTests(target.testPath, opts.timeoutMs);
  if (sanity.status !== 'PASS') {
    return {
      target,
      skipped: true,
      reason: `baseline tests failed (${sanity.status})`,
      mutants: [],
    };
  }
  const mutants = generateMutants(original, { max: opts.limit });
  const results = [];
  try {
    for (let idx = 0; idx < mutants.length; idx++) {
      const mutant = mutants[idx];
      const mutated = applyMutant(original, mutant);
      fs.writeFileSync(target.sourcePath, mutated);
      const started = Date.now();
      const test = runTests(target.testPath, opts.timeoutMs);
      const elapsed = Date.now() - started;
      const status = test.status === 'TIMEOUT'
        ? 'TIMEOUT'
        : (test.status === 'FAIL' ? 'KILLED' : 'SURVIVED');
      results.push({ ...mutant, status, durationMs: elapsed });
      if (opts.verbose) {
        const loc = locOf(original, mutant.start);
        process.stdout.write(
          `  [${idx + 1}/${mutants.length}] ${mutant.operator} @ ${loc.line}:${loc.column} ` +
          `→ ${status} (${fmtDuration(elapsed)})\n`,
        );
      }
    }
  } finally {
    fs.writeFileSync(target.sourcePath, original);
  }
  return { target, skipped: false, mutants: results };
}

function locOf(source, offset) {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function summarize(results) {
  const totals = { mutants: 0, killed: 0, survived: 0, timeout: 0, skipped: 0 };
  const perFile = [];
  for (const r of results) {
    if (r.skipped) {
      totals.skipped += 1;
      perFile.push({ name: r.target.name, skipped: true, reason: r.reason });
      continue;
    }
    let killed = 0; let survived = 0; let timeout = 0;
    for (const m of r.mutants) {
      if (m.status === 'KILLED') killed += 1;
      else if (m.status === 'SURVIVED') survived += 1;
      else if (m.status === 'TIMEOUT') timeout += 1;
    }
    totals.mutants += r.mutants.length;
    totals.killed += killed;
    totals.survived += survived;
    totals.timeout += timeout;
    perFile.push({
      name: r.target.name,
      total: r.mutants.length,
      killed,
      survived,
      timeout,
      score: r.mutants.length === 0 ? null : (killed + timeout) / r.mutants.length,
      survivors: r.mutants.filter(m => m.status === 'SURVIVED'),
    });
  }
  const denom = totals.killed + totals.survived + totals.timeout;
  totals.score = denom === 0 ? null : (totals.killed + totals.timeout) / denom;
  return { totals, perFile };
}

function renderReport(summary, opts) {
  const { totals, perFile } = summary;
  const lines = [];
  lines.push('# Mutation Testing Baseline — backend/src/utils/');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Runner: \`backend/scripts/mutation-baseline.js\` (custom, dependency-free)`);
  lines.push(`Limit per file: ${opts.limit === Infinity ? 'unlimited' : opts.limit}`);
  lines.push(`Per-mutant timeout: ${opts.timeoutMs}ms`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Files analyzed | ${perFile.filter(f => !f.skipped).length} |`);
  lines.push(`| Files skipped | ${perFile.filter(f => f.skipped).length} |`);
  lines.push(`| Mutants generated | ${totals.mutants} |`);
  lines.push(`| Killed | ${totals.killed} |`);
  lines.push(`| Survived | ${totals.survived} |`);
  lines.push(`| Timed out | ${totals.timeout} |`);
  lines.push(`| Mutation score | ${totals.score == null ? 'n/a' : (totals.score * 100).toFixed(1) + '%'} |`);
  lines.push('');
  lines.push('Mutation score = (KILLED + TIMEOUT) / (KILLED + SURVIVED + TIMEOUT). Higher is better.');
  lines.push('');
  lines.push('## Per-file results');
  lines.push('');
  lines.push('| File | Mutants | Killed | Survived | Timeout | Score |');
  lines.push('|---|---|---|---|---|---|');
  for (const f of perFile) {
    if (f.skipped) {
      lines.push(`| ${f.name} | _skipped_ | _${f.reason}_ |  |  |  |`);
      continue;
    }
    const score = f.score == null ? 'n/a' : (f.score * 100).toFixed(1) + '%';
    lines.push(`| ${f.name} | ${f.total} | ${f.killed} | ${f.survived} | ${f.timeout} | ${score} |`);
  }
  lines.push('');
  const survivors = perFile.flatMap(f => (f.survivors || []).map(m => ({ file: f.name, ...m })));
  if (survivors.length) {
    lines.push('## Surviving mutants (test gaps)');
    lines.push('');
    lines.push('| File | Operator | Replacement | Offset |');
    lines.push('|---|---|---|---|');
    for (const s of survivors.slice(0, 100)) {
      lines.push(`| ${s.file} | ${s.operator} | \`${s.original}\` → \`${s.replacement}\` | ${s.start} |`);
    }
    if (survivors.length > 100) {
      lines.push('');
      lines.push(`…and ${survivors.length - 100} more.`);
    }
    lines.push('');
  }
  lines.push('## Notes');
  lines.push('');
  lines.push('- This runner applies one point mutation at a time, runs the matching');
  lines.push('  `*.test.js`, and classifies the mutant by exit status.');
  lines.push('- Operators are conservative (string-aware skip mask) but not AST-driven.');
  lines.push('  Equivalent mutants will appear as SURVIVED — review before treating as gaps.');
  lines.push('- For deeper coverage install Stryker: `npm i -D @stryker-mutator/core` and');
  lines.push('  run `npx stryker run` against `backend/stryker.conf.json`.');
  return lines.join('\n') + '\n';
}

async function main() {
  const opts = {
    limit: Number(process.env.MUTATION_LIMIT || 25),
    timeoutMs: Number(process.env.MUTATION_TIMEOUT_MS || 30000),
    reportPath: process.env.MUTATION_REPORT
      ? path.resolve(BACKEND_DIR, '..', process.env.MUTATION_REPORT)
      : path.resolve(BACKEND_DIR, '..', 'docs', 'mutation-testing-baseline.md'),
    verbose: process.env.MUTATION_VERBOSE !== '0',
  };
  const targets = listTargets();
  if (!targets.length) {
    console.error('[mutation-baseline] no targets found in backend/src/utils/ with matching tests');
    process.exit(1);
  }
  console.log(`[mutation-baseline] ${targets.length} target(s)`);
  const results = [];
  for (const target of targets) {
    console.log(`\n[mutation-baseline] ${target.name}`);
    try {
      const r = await processTarget(target, opts);
      results.push(r);
    } catch (err) {
      console.error(`  failed: ${err && err.stack || err}`);
      results.push({ target, skipped: true, reason: `runner error: ${err && err.message || err}`, mutants: [] });
    }
  }
  const summary = summarize(results);
  const report = renderReport(summary, opts);
  fs.mkdirSync(path.dirname(opts.reportPath), { recursive: true });
  fs.writeFileSync(opts.reportPath, report);
  console.log(`\n[mutation-baseline] report written to ${path.relative(process.cwd(), opts.reportPath)}`);
  console.log(`[mutation-baseline] mutation score: ${
    summary.totals.score == null ? 'n/a' : (summary.totals.score * 100).toFixed(1) + '%'
  } (${summary.totals.killed} killed / ${summary.totals.survived} survived / ${summary.totals.timeout} timeout)`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { listTargets, summarize, renderReport };
