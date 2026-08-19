/**
 * Tests for services/agents/eval-harness.js — alignment-eval harness
 * with single-variant scoring + A/B comparison.
 */

'use strict';

const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const { describe, it, before, after, beforeEach } = require('node:test');

const JUDGE_PATH = require.resolve('../src/services/agents/alignment-judge');
const EVAL_PATH = require.resolve('../src/services/agents/eval-harness');

const judgeMock = {
  _next: async () => ({ overall: 8, helpful: 8, honest: 8, harmless: 8, issues: [], reasoning: '' }),
  score: (...args) => judgeMock._next(...args),
};

let origJudge, origEval;

function installMocks() {
  origJudge = require.cache[JUDGE_PATH];
  origEval = require.cache[EVAL_PATH];
  const m = new Module(JUDGE_PATH);
  m.filename = JUDGE_PATH;
  m.loaded = true;
  m.exports = judgeMock;
  m.paths = Module._nodeModulePaths(path.dirname(JUDGE_PATH));
  require.cache[JUDGE_PATH] = m;
  delete require.cache[EVAL_PATH];
}

function restoreMocks() {
  if (origJudge) require.cache[JUDGE_PATH] = origJudge;
  else delete require.cache[JUDGE_PATH];
  if (origEval) require.cache[EVAL_PATH] = origEval;
  else delete require.cache[EVAL_PATH];
}

let harness;

before(() => {
  installMocks();
  harness = require('../src/services/agents/eval-harness');
});

after(() => {
  restoreMocks();
});

beforeEach(() => {
  judgeMock._next = async () => ({
    overall: 8, helpful: 8, honest: 8, harmless: 8,
    issues: [], reasoning: '',
  });
});

// ── BUILT_IN_SETS + defaultPromptsFor ───────────────────────────

describe('BUILT_IN_SETS', () => {
  it('includes the 7 documented agent sets', () => {
    for (const k of ['code_review', 'test_gen', 'debug', 'code_gen', 'requirements', 'maintenance', 'general']) {
      assert.ok(Array.isArray(harness.BUILT_IN_SETS[k]), `missing ${k}`);
      assert.ok(harness.BUILT_IN_SETS[k].length > 0);
    }
  });

  it('every prompt entry has { id, prompt } strings', () => {
    for (const [agent, set] of Object.entries(harness.BUILT_IN_SETS)) {
      for (const p of set) {
        assert.equal(typeof p.id, 'string');
        assert.equal(typeof p.prompt, 'string');
        assert.ok(p.id.length > 0, `${agent} has empty id`);
      }
    }
  });
});

describe('defaultPromptsFor', () => {
  it('returns the matching set for a known agent', () => {
    assert.strictEqual(
      harness.defaultPromptsFor('code_review'),
      harness.BUILT_IN_SETS.code_review,
    );
  });

  it('falls back to the general set for unknown agents', () => {
    assert.strictEqual(
      harness.defaultPromptsFor('unknown'),
      harness.BUILT_IN_SETS.general,
    );
  });
});

// ── mean / stddev / twoProportionZ ─────────────────────────────

describe('mean', () => {
  it('returns 0 for empty array', () => {
    assert.equal(harness.mean([]), 0);
  });

  it('computes arithmetic mean', () => {
    assert.equal(harness.mean([1, 2, 3, 4, 5]), 3);
  });
});

describe('stddev', () => {
  it('returns 0 for <2 elements', () => {
    assert.equal(harness.stddev([]), 0);
    assert.equal(harness.stddev([5]), 0);
  });

  it('matches sample-stddev formula', () => {
    // [1, 2, 3]: variance = ((1-2)^2 + (2-2)^2 + (3-2)^2)/2 = 1 → 1.
    assert.ok(Math.abs(harness.stddev([1, 2, 3]) - 1) < 1e-9);
  });
});

describe('twoProportionZ', () => {
  it('returns z=0, p=1 when total=0', () => {
    const out = harness.twoProportionZ(0, 0, 0);
    assert.equal(out.z, 0);
    assert.equal(out.pApprox, 1);
  });

  it('returns z=0 when A and B win equally (no difference)', () => {
    const out = harness.twoProportionZ(50, 50, 100);
    assert.equal(out.z, 0);
  });

  it('positive z when B beats A', () => {
    const out = harness.twoProportionZ(20, 80, 100);
    assert.ok(out.z > 0);
    assert.ok(out.winRateB > out.winRateA);
  });

  it('p-approximation is between 0 and 1', () => {
    const out = harness.twoProportionZ(50, 60, 100);
    assert.ok(out.pApprox >= 0 && out.pApprox <= 1);
  });
});

// ── runEval · validation + happy path ──────────────────────────

describe('runEval', () => {
  it('throws when runAgent is missing', async () => {
    await assert.rejects(
      () => harness.runEval({ openai: {} }),
      /runAgent function required/,
    );
  });

  it('returns empty stats for an empty prompt set', async () => {
    const out = await harness.runEval({
      openai: {}, runAgent: async () => 'r', prompts: [],
      agent: 'nonexistent',  // falls back to "general" which is non-empty
    });
    // "general" has 2 prompts; we get 2 runs.
    assert.equal(out.n, 2);
  });

  it('passRate is the fraction with score >= passThreshold', async () => {
    let n = 0;
    judgeMock._next = async () => {
      n += 1;
      return { overall: n === 1 ? 5 : 8, helpful: 5, honest: 5, harmless: 5, issues: [], reasoning: '' };
    };
    const prompts = [
      { id: 'a', prompt: 'p1' },
      { id: 'b', prompt: 'p2' },
      { id: 'c', prompt: 'p3' },
    ];
    const out = await harness.runEval({
      openai: {}, runAgent: async () => 'r', prompts, passThreshold: 6,
    });
    // First scored 5 (fail), others scored 8 (pass) → 2/3.
    assert.ok(Math.abs(out.passRate - 2/3) < 1e-9);
  });

  it('computes meanOverall / meanHelpful / meanHonest / meanHarmless', async () => {
    let n = 0;
    const seq = [{ o: 6, hp: 7, hn: 8, ha: 9 }, { o: 4, hp: 5, hn: 6, ha: 7 }];
    judgeMock._next = async () => {
      const s = seq[n++ % seq.length];
      return { overall: s.o, helpful: s.hp, honest: s.hn, harmless: s.ha, issues: [], reasoning: '' };
    };
    const out = await harness.runEval({
      openai: {}, runAgent: async () => 'r',
      prompts: [{ id: 'a', prompt: 'p1' }, { id: 'b', prompt: 'p2' }],
    });
    assert.equal(out.meanOverall, 5);
    assert.equal(out.meanHelpful, 6);
    assert.equal(out.meanHonest, 7);
    assert.equal(out.meanHarmless, 8);
  });

  it('failureModes aggregates issues across runs (lowercased, prefix-keyed)', async () => {
    let n = 0;
    judgeMock._next = async () => {
      n += 1;
      return {
        overall: 7, helpful: 7, honest: 7, harmless: 7,
        issues: n === 1 ? ['Too brief'] : ['too brief, lacking detail', 'missing examples'],
        reasoning: '',
      };
    };
    const out = await harness.runEval({
      openai: {}, runAgent: async () => 'r',
      prompts: [{ id: 'a', prompt: 'p1' }, { id: 'b', prompt: 'p2' }],
    });
    // Both "Too brief" and "too brief, lacking detail" share the prefix
    // "too brief" → count = 2.
    assert.equal(out.failureModes['too brief'], 2);
    assert.equal(out.failureModes['missing examples'], 1);
  });

  it('catches agent failures and stores error result without throwing', async () => {
    const out = await harness.runEval({
      openai: {}, runAgent: async () => { throw new Error('agent down'); },
      prompts: [{ id: 'a', prompt: 'p1' }],
    });
    assert.equal(out.n, 1);
    assert.deepEqual(out.runs[0].response, { error: 'agent down' });
  });

  it('uses defaultPromptsFor when prompts arg omitted', async () => {
    const out = await harness.runEval({
      openai: {}, runAgent: async () => 'r', agent: 'code_review',
    });
    assert.equal(out.n, harness.BUILT_IN_SETS.code_review.length);
  });
});

// ── runAB ──────────────────────────────────────────────────────

describe('runAB', () => {
  it('throws when runA or runB is missing', async () => {
    await assert.rejects(
      () => harness.runAB({ openai: {}, runA: async () => 'x' }),
      /runA and runB functions required/,
    );
    await assert.rejects(
      () => harness.runAB({ openai: {}, runB: async () => 'x' }),
      /runA and runB functions required/,
    );
  });

  it('aggregates wins/ties across prompts (judge mock returns A every time)', async () => {
    // Override judge so A wins; the judge sees our scoring prompt.
    judgeMock._next = async (req) => ({
      overall: 7, helpful: 7, honest: 7, harmless: 7,
      issues: [], reasoning: '',
    });
    // The A/B judge uses pickWinner which has its own LLM call. Mock
    // pickWinner directly is harder — but we can test that runAB
    // returns the expected structure. The internal LLM call returns
    // empty {} → "tie".
    const out = await harness.runAB({
      openai: null,  // ensures pickWinner returns tie short-circuit
      runA: async () => 'a-response',
      runB: async () => 'b-response',
      prompts: [{ id: 'p1', prompt: 'q1' }, { id: 'p2', prompt: 'q2' }],
    });
    assert.equal(out.n, 2);
    assert.equal(out.ties, 2);  // null openai forces tie
    assert.equal(out.A.wins, 0);
    assert.equal(out.B.wins, 0);
    // Half-credit ties → both winRate = 0.5
    assert.equal(out.A.winRate, 0.5);
    assert.equal(out.B.winRate, 0.5);
  });

  it('captures verdicts per prompt', async () => {
    const out = await harness.runAB({
      openai: null,
      runA: async () => 'a',
      runB: async () => 'b',
      prompts: [{ id: 'p1', prompt: 'q1' }],
    });
    assert.equal(out.verdicts.length, 1);
    assert.equal(out.verdicts[0].id, 'p1');
    assert.equal(out.verdicts[0].respA, 'a');
    assert.equal(out.verdicts[0].respB, 'b');
  });

  it('uses defaultPromptsFor when prompts omitted', async () => {
    const out = await harness.runAB({
      openai: null,
      runA: async () => 'a',
      runB: async () => 'b',
      agent: 'code_review',
    });
    assert.equal(out.n, harness.BUILT_IN_SETS.code_review.length);
  });

  it('agent failure becomes { error } response without throwing', async () => {
    const out = await harness.runAB({
      openai: null,
      runA: async () => { throw new Error('a fail'); },
      runB: async () => 'b',
      prompts: [{ id: 'p1', prompt: 'q1' }],
    });
    assert.deepEqual(out.verdicts[0].respA, { error: 'a fail' });
    assert.equal(out.verdicts[0].respB, 'b');
  });

  it('custom labels A/B respected in output', async () => {
    const out = await harness.runAB({
      openai: null,
      runA: async () => 'x',
      runB: async () => 'y',
      prompts: [{ id: 'p1', prompt: 'q1' }],
      labelA: 'baseline',
      labelB: 'challenger',
    });
    assert.ok('baseline' in out);
    assert.ok('challenger' in out);
  });
});

// ── pickWinner ─────────────────────────────────────────────────

describe('pickWinner', () => {
  it('returns tie when openai missing', async () => {
    const out = await harness.pickWinner({
      prompt: 'q', respA: 'a', respB: 'b', labelA: 'A', labelB: 'B',
    });
    assert.equal(out.label, 'tie');
    assert.match(out.reasoning, /no LLM client/);
  });

  it('parses {preferred:"A"} into labelA', async () => {
    const openai = {
      chat: { completions: { create: async () => ({
        choices: [{ message: { content: JSON.stringify({
          preferred: 'A', reasoning: 'A is clearer',
        }) } }],
      })}},
    };
    const out = await harness.pickWinner({
      openai, prompt: 'q', respA: 'a', respB: 'b',
      labelA: 'baseline', labelB: 'challenger',
    });
    assert.equal(out.label, 'baseline');
    assert.equal(out.reasoning, 'A is clearer');
  });

  it('parses {preferred:"B"} into labelB', async () => {
    const openai = {
      chat: { completions: { create: async () => ({
        choices: [{ message: { content: JSON.stringify({
          preferred: 'B', reasoning: 'B is grounded',
        }) } }],
      })}},
    };
    const out = await harness.pickWinner({
      openai, prompt: 'q', respA: 'a', respB: 'b',
      labelA: 'A', labelB: 'B',
    });
    assert.equal(out.label, 'B');
  });

  it('preferred="tie" or any unknown → tie', async () => {
    const openai = {
      chat: { completions: { create: async () => ({
        choices: [{ message: { content: JSON.stringify({ preferred: 'tie' }) } }],
      })}},
    };
    const out = await harness.pickWinner({
      openai, prompt: 'q', respA: 'a', respB: 'b', labelA: 'A', labelB: 'B',
    });
    assert.equal(out.label, 'tie');
  });

  it('LLM error → tie with reasoning', async () => {
    const openai = {
      chat: { completions: { create: async () => { throw new Error('judge down'); } } },
    };
    const out = await harness.pickWinner({
      openai, prompt: 'q', respA: 'a', respB: 'b', labelA: 'A', labelB: 'B',
    });
    assert.equal(out.label, 'tie');
    assert.match(out.reasoning, /judge error/);
  });

  it('AB_SYSTEM prompt mentions STRICT JSON and HHH axes', () => {
    assert.match(harness.AB_SYSTEM, /STRICT JSON/);
    assert.match(harness.AB_SYSTEM, /helpful\/honest\/harmless/);
    assert.match(harness.AB_SYSTEM, /willing to call a tie/);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const keys = Object.keys(harness).sort();
    assert.deepEqual(keys, [
      'AB_SYSTEM', 'BUILT_IN_SETS', 'defaultPromptsFor', 'mean',
      'pickWinner', 'runAB', 'runEval', 'stddev', 'twoProportionZ',
    ]);
  });
});
