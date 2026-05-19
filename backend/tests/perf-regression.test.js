'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

/**
 * Boot-time regression budgets.
 *
 * Each service is required in a *fresh* child process so we measure
 * actual cold-start cost (including transitively loaded deps).
 * Catches accidental top-level sync DB calls, heavy imports, or
 * un-lazied analyzer chains that would slow down server boot.
 *
 * Budgets are intentionally loose (3-5× current observed values) so
 * the suite doesn't flake on a busy CI machine. Tighten when a module
 * is meaningfully optimized.
 */
const ROOT = path.join(__dirname, '..');

function bootTimeMs(modulePath) {
  const script = `
    const t = process.hrtime.bigint();
    require(${JSON.stringify(modulePath)});
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    process.stdout.write(String(ms));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', EMAIL_DEBUG_LOG_BODY: '0' },
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 15_000,
  });
  return Number(out.toString().trim());
}

const BUDGETS = [
  // [modulePath, budgetMs, why]
  ['./src/utils/pii-mask',                       50,  'tiny regex module — should never balloon'],
  ['./src/services/active-memory',              200,  'pure-JS in-memory store'],
  ['./src/services/skills-registry',            200,  'declarative registry, no I/O'],
  ['./src/services/session-manager',            200,  'pure-JS, no DB'],
  ['./src/services/document-intent-analyzer',   200,  'analyzer with lazy deps'],
  ['./src/services/scientific-search',          400,  'fetch-based provider registry'],
  ['./src/services/deep-document-analyzer',     400,  'regex-heavy but lazy'],
  // document-intelligence transitively requires the whole brain pipeline +
  // hierarchical chunker + fileProcessor; keep a generous budget.
  ['./src/services/document-intelligence',     1500,  'heavy: hierarchical chunker + file processor + lazy brain'],
];

for (const [modulePath, budgetMs, why] of BUDGETS) {
  test(`perf: ${modulePath} boots under ${budgetMs}ms (${why})`, () => {
    const ms = bootTimeMs(modulePath);
    assert.ok(
      ms < budgetMs,
      `${modulePath} took ${ms.toFixed(1)}ms — budget ${budgetMs}ms. ` +
      `Investigate sync I/O, top-level DB clients, or heavy unconditional imports.`
    );
  });
}

test('perf: top-level requires must not block on the network or sync DB', () => {
  // Spy: any module whose cold boot exceeds 3000ms is almost certainly
  // doing something it shouldn't at require time.
  const HARD_CAP_MS = 3000;
  for (const [modulePath] of BUDGETS) {
    const ms = bootTimeMs(modulePath);
    assert.ok(ms < HARD_CAP_MS, `${modulePath} cold boot ${ms.toFixed(1)}ms exceeds hard cap ${HARD_CAP_MS}ms`);
  }
});
