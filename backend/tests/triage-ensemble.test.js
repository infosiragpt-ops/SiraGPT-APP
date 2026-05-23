'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEnsembleJudge,
  fuseVerdicts,
  raceAll,
  DEFAULT_BUDGET_MS,
} = require('../src/services/agents/triage-ensemble');

function makeJudge(verdict, delayMs = 5) {
  return async () => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    if (verdict instanceof Error) throw verdict;
    return verdict;
  };
}

// ─── fuseVerdicts (pure) ──────────────────────────────────────────────

test('fuse: empty results → execute fallback', () => {
  const v = fuseVerdicts({ results: [], totalMs: 0 });
  assert.equal(v.action, 'execute');
  assert.equal(v.agreement, 'fallback');
  assert.equal(v.reason, 'all_judges_failed');
});

test('fuse: all rejected → execute fallback', () => {
  const v = fuseVerdicts({
    results: [
      { status: 'rejected', reason: 'timeout', ms: 100, idx: 0 },
      { status: 'rejected', reason: 'error', ms: 80, idx: 1 },
    ],
  });
  assert.equal(v.action, 'execute');
  assert.equal(v.agreement, 'fallback');
});

test('fuse: unanimous ask', () => {
  const v = fuseVerdicts({
    results: [
      { status: 'fulfilled', value: { action: 'ask', question: '¿q1?' }, ms: 50, idx: 0 },
      { status: 'fulfilled', value: { action: 'ask', question: '¿q2?' }, ms: 60, idx: 1 },
    ],
  });
  assert.equal(v.action, 'ask');
  assert.equal(v.agreement, 'unanimous');
  assert.equal(v.question, '¿q1?'); // primer judge gana cuando agree
});

test('fuse: unanimous execute', () => {
  const v = fuseVerdicts({
    results: [
      { status: 'fulfilled', value: { action: 'execute' }, ms: 50, idx: 0 },
      { status: 'fulfilled', value: { action: 'execute' }, ms: 60, idx: 1 },
    ],
  });
  assert.equal(v.action, 'execute');
  assert.equal(v.agreement, 'unanimous');
});

test('fuse: majority ask 2-of-3', () => {
  const v = fuseVerdicts({
    results: [
      { status: 'fulfilled', value: { action: 'ask', question: '¿q?' }, ms: 50, idx: 0 },
      { status: 'fulfilled', value: { action: 'ask', question: '¿q2?' }, ms: 60, idx: 1 },
      { status: 'fulfilled', value: { action: 'execute' }, ms: 70, idx: 2 },
    ],
  });
  assert.equal(v.action, 'ask');
  assert.equal(v.agreement, 'majority');
  assert.match(v.reason, /majority_ask_2_of_3/);
});

test('fuse: majority execute 2-of-3', () => {
  const v = fuseVerdicts({
    results: [
      { status: 'fulfilled', value: { action: 'execute' }, ms: 50, idx: 0 },
      { status: 'fulfilled', value: { action: 'execute' }, ms: 60, idx: 1 },
      { status: 'fulfilled', value: { action: 'ask', question: '¿q?' }, ms: 70, idx: 2 },
    ],
  });
  assert.equal(v.action, 'execute');
  assert.equal(v.agreement, 'majority');
});

test('fuse: tie 1-1 → conservative execute', () => {
  const v = fuseVerdicts({
    results: [
      { status: 'fulfilled', value: { action: 'ask', question: '¿q?' }, ms: 50, idx: 0 },
      { status: 'fulfilled', value: { action: 'execute' }, ms: 60, idx: 1 },
    ],
  });
  assert.equal(v.action, 'execute');
  assert.equal(v.agreement, 'split');
});

test('fuse: ignores rejected results when others succeed', () => {
  const v = fuseVerdicts({
    results: [
      { status: 'rejected', reason: 'timeout', ms: 350, idx: 0 },
      { status: 'fulfilled', value: { action: 'ask', question: '¿q?' }, ms: 80, idx: 1 },
    ],
  });
  // n = 1 fulfilled, so unanimous_ask
  assert.equal(v.action, 'ask');
  assert.equal(v.n, 1);
});

test('fuse: malformed verdict (no action) treated as rejected', () => {
  const v = fuseVerdicts({
    results: [
      { status: 'fulfilled', value: { somethingElse: true }, ms: 50, idx: 0 },
      { status: 'fulfilled', value: { action: 'execute' }, ms: 60, idx: 1 },
    ],
  });
  assert.equal(v.n, 1);
  assert.equal(v.action, 'execute');
});

// ─── raceAll (timing) ─────────────────────────────────────────────────

test('race: all fast judges complete within budget', async () => {
  const judges = [makeJudge({ action: 'execute' }, 10), makeJudge({ action: 'ask', question: '?' }, 20)];
  const { results } = await raceAll(judges, {}, 100);
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.status === 'fulfilled'));
});

test('race: slow judge times out', async () => {
  const judges = [makeJudge({ action: 'execute' }, 10), makeJudge({ action: 'ask' }, 500)];
  const { results } = await raceAll(judges, {}, 80);
  const fast = results.find((r) => r.idx === 0);
  const slow = results.find((r) => r.idx === 1);
  assert.equal(fast.status, 'fulfilled');
  assert.equal(slow.status, 'rejected');
  assert.equal(slow.reason, 'timeout');
});

test('race: all timeout when budget too short', async () => {
  const judges = [makeJudge({ action: 'execute' }, 200), makeJudge({ action: 'ask' }, 250)];
  const { results } = await raceAll(judges, {}, 50);
  assert.ok(results.every((r) => r.status === 'rejected'));
});

test('race: judge error captured as rejected', async () => {
  const judges = [makeJudge(new Error('boom'), 10), makeJudge({ action: 'execute' }, 10)];
  const { results } = await raceAll(judges, {}, 100);
  assert.equal(results[0].status, 'rejected');
  assert.match(results[0].reason, /boom/);
  assert.equal(results[1].status, 'fulfilled');
});

test('race: ms is recorded per judge', async () => {
  const judges = [makeJudge({ action: 'execute' }, 10), makeJudge({ action: 'execute' }, 20)];
  const { results, totalMs } = await raceAll(judges, {}, 100);
  assert.ok(results[0].ms >= 0);
  assert.ok(results[1].ms >= 10);
  assert.ok(totalMs >= 0);
});

// ─── buildEnsembleJudge (end-to-end) ──────────────────────────────────

test('build: no judges → returns null', () => {
  const j = buildEnsembleJudge({ judges: [] });
  assert.equal(j, null);
});

test('build: filters non-functions', () => {
  const j = buildEnsembleJudge({ judges: [null, 'string', () => ({ action: 'execute' })] });
  assert.ok(typeof j === 'function');
});

test('ensemble: unanimous fast judges → unanimous verdict', async () => {
  const ensemble = buildEnsembleJudge({
    judges: [
      makeJudge({ action: 'execute' }, 5),
      makeJudge({ action: 'execute' }, 8),
    ],
    budgetMs: 100,
  });
  const v = await ensemble({ prompt: 'genera un word' });
  assert.equal(v.action, 'execute');
  assert.equal(v.agreement, 'unanimous');
});

test('ensemble: one timeout + one ask → unanimous from survivor', async () => {
  const ensemble = buildEnsembleJudge({
    judges: [
      makeJudge({ action: 'ask', question: '¿q?' }, 5),
      makeJudge({ action: 'execute' }, 500),
    ],
    budgetMs: 80,
  });
  const v = await ensemble({ prompt: 'foo' });
  assert.equal(v.action, 'ask');
});

test('ensemble: all timeout → fallback execute', async () => {
  const ensemble = buildEnsembleJudge({
    judges: [makeJudge({ action: 'ask' }, 500), makeJudge({ action: 'ask' }, 600)],
    budgetMs: 80,
  });
  const v = await ensemble({ prompt: 'foo' });
  assert.equal(v.action, 'execute');
  assert.equal(v.agreement, 'fallback');
});

test('ensemble: 3 judges, 2 ask 1 execute → ask majority', async () => {
  const ensemble = buildEnsembleJudge({
    judges: [
      makeJudge({ action: 'ask', question: '¿q1?' }, 5),
      makeJudge({ action: 'ask', question: '¿q2?' }, 8),
      makeJudge({ action: 'execute' }, 10),
    ],
    budgetMs: 100,
  });
  const v = await ensemble({ prompt: 'foo' });
  assert.equal(v.action, 'ask');
  assert.equal(v.agreement, 'majority');
});

test('ensemble: tie 1-1 → conservative execute (no false ask)', async () => {
  const ensemble = buildEnsembleJudge({
    judges: [
      makeJudge({ action: 'ask', question: '¿q?' }, 5),
      makeJudge({ action: 'execute' }, 8),
    ],
    budgetMs: 100,
  });
  const v = await ensemble({ prompt: 'foo' });
  assert.equal(v.action, 'execute');
});

test('ensemble: respects DEFAULT_BUDGET_MS when omitted', async () => {
  const ensemble = buildEnsembleJudge({
    judges: [makeJudge({ action: 'execute' }, 10)],
  });
  const t0 = Date.now();
  const v = await ensemble({ prompt: 'foo' });
  const elapsed = Date.now() - t0;
  assert.equal(v.action, 'execute');
  assert.ok(elapsed < DEFAULT_BUDGET_MS + 50);
});
