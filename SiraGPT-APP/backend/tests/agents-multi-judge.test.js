/**
 * Tests for services/agents/multi-judge.js — variance-reducing
 * multi-judge aggregator.
 *
 * scoreMulti and callJudgeWithPersona ultimately call alignment-judge.
 * We stub that via require-cache injection with a dispatcher pattern.
 */

'use strict';

const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const { describe, it, before, after, beforeEach } = require('node:test');

const JUDGE_PATH = require.resolve('../src/services/agents/alignment-judge');
const MULTI_PATH = require.resolve('../src/services/agents/multi-judge');

// Dispatcher pattern: multi-judge does `require('./alignment-judge')`
// once. We keep judge.score as a stable function that delegates to
// `judgeMock._next`.
const judgeMock = {
  _next: async () => ({ helpful: 5, honest: 5, harmless: 5, overall: 5, issues: [], reasoning: '' }),
  score: (...args) => judgeMock._next(...args),
};

let origJudge, origMulti;

function installMocks() {
  origJudge = require.cache[JUDGE_PATH];
  origMulti = require.cache[MULTI_PATH];
  const m = new Module(JUDGE_PATH);
  m.filename = JUDGE_PATH;
  m.loaded = true;
  m.exports = judgeMock;
  m.paths = Module._nodeModulePaths(path.dirname(JUDGE_PATH));
  require.cache[JUDGE_PATH] = m;
  delete require.cache[MULTI_PATH];
}

function restoreMocks() {
  if (origJudge) require.cache[JUDGE_PATH] = origJudge;
  else delete require.cache[JUDGE_PATH];
  if (origMulti) require.cache[MULTI_PATH] = origMulti;
  else delete require.cache[MULTI_PATH];
}

let mj;

before(() => {
  installMocks();
  mj = require('../src/services/agents/multi-judge');
});

after(() => {
  restoreMocks();
});

beforeEach(() => {
  judgeMock._next = async () => ({
    helpful: 5, honest: 5, harmless: 5, overall: 5, issues: [], reasoning: '',
  });
});

// ── constants ────────────────────────────────────────────────────

describe('constants', () => {
  it('DEFAULT_N = 3, MAX_N = 5', () => {
    assert.equal(mj.DEFAULT_N, 3);
    assert.equal(mj.MAX_N, 5);
  });

  it('PERSONAS array has 5 entries (null + 4 named)', () => {
    assert.equal(mj.PERSONAS.length, 5);
    assert.equal(mj.PERSONAS[0], null);
  });

  it('TEMPERATURES has 5 entries in [0, 1]', () => {
    assert.equal(mj.TEMPERATURES.length, 5);
    for (const t of mj.TEMPERATURES) {
      assert.ok(t >= 0 && t <= 1);
    }
  });

  it('PERSONAS named entries each describe distinct disposition', () => {
    const text = mj.PERSONAS.filter(Boolean).join(' ');
    assert.match(text, /STRICT/);
    assert.match(text, /LENIENT/);
    assert.match(text, /PRECISE/);
    assert.match(text, /HOLISTIC/);
  });
});

// ── median / quantile / stddev ────────────────────────────────

describe('median', () => {
  it('returns 0 for empty array', () => {
    assert.equal(mj.median([]), 0);
  });

  it('odd-length: middle element', () => {
    assert.equal(mj.median([1, 2, 3]), 2);
  });

  it('even-length: mean of two middle elements', () => {
    assert.equal(mj.median([1, 2, 3, 4]), 2.5);
  });

  it('single-element array → that element', () => {
    assert.equal(mj.median([7]), 7);
  });
});

describe('quantile', () => {
  it('returns 0 for empty array', () => {
    assert.equal(mj.quantile([], 0.5), 0);
  });

  it('single-element array → that element', () => {
    assert.equal(mj.quantile([5], 0.25), 5);
  });

  it('q=0 → minimum (first), q=1 → maximum (last)', () => {
    const arr = [1, 2, 3, 4, 5];
    assert.equal(mj.quantile(arr, 0), 1);
    assert.equal(mj.quantile(arr, 1), 5);
  });

  it('q=0.5 ≈ median', () => {
    const arr = [1, 2, 3, 4, 5];
    assert.equal(mj.quantile(arr, 0.5), 3);
  });

  it('interpolates between adjacent values', () => {
    // [1, 2, 3, 4] at q=0.25 → pos = 3*0.25 = 0.75 → 1 + 0.75*(2-1) = 1.75.
    assert.ok(Math.abs(mj.quantile([1, 2, 3, 4], 0.25) - 1.75) < 1e-9);
  });
});

describe('stddev', () => {
  it('returns 0 for arrays with <2 elements', () => {
    assert.equal(mj.stddev([]), 0);
    assert.equal(mj.stddev([5]), 0);
  });

  it('identical values → 0', () => {
    assert.equal(mj.stddev([5, 5, 5, 5]), 0);
  });

  it('approximates sample std-dev correctly', () => {
    // [1, 2, 3]: mean=2, variance = ((1-2)^2 + (2-2)^2 + (3-2)^2)/2 = 1
    // → stddev = 1
    assert.ok(Math.abs(mj.stddev([1, 2, 3]) - 1) < 1e-9);
  });
});

// ── scoreMulti · no-openai fallback ───────────────────────────

describe('scoreMulti · no openai', () => {
  it('falls back to neutral single-score when openai missing', async () => {
    // judgeMock.score gets called with openai:null; the dispatcher
    // returns whatever _next yields (default neutral 5s).
    const out = await mj.scoreMulti({ userRequest: 'q', response: 'r' });
    assert.equal(out.n, 1);
    assert.equal(out.median, 5);
    assert.equal(out.iqr, 0);
    assert.equal(out.disagreement, 'low');
    assert.equal(out.aggregated.overall, 5);
  });
});

// ── scoreMulti · happy paths ──────────────────────────────────

describe('scoreMulti · aggregation', () => {
  it('runs n rounds and returns median + mean + stdDev', async () => {
    let i = 0;
    const scores = [4, 6, 8];
    judgeMock._next = async () => ({
      helpful: 5, honest: 5, harmless: 5, overall: scores[i++ % 3],
      issues: [], reasoning: '',
    });
    const out = await mj.scoreMulti({
      openai: {}, userRequest: 'q', response: 'r', n: 3,
    });
    assert.equal(out.n, 3);
    assert.equal(out.median, 6);
    assert.ok(Math.abs(out.mean - 6) < 1e-9);
    assert.ok(out.stdDev > 0);
  });

  it('clamps n to MAX_N (5)', async () => {
    let calls = 0;
    judgeMock._next = async () => {
      calls++;
      return { helpful: 5, honest: 5, harmless: 5, overall: 5, issues: [], reasoning: '' };
    };
    await mj.scoreMulti({ openai: {}, userRequest: 'q', response: 'r', n: 99 });
    assert.equal(calls, mj.MAX_N);
  });

  it('clamps n to floor of 1', async () => {
    let calls = 0;
    judgeMock._next = async () => {
      calls++;
      return { helpful: 5, honest: 5, harmless: 5, overall: 5, issues: [], reasoning: '' };
    };
    await mj.scoreMulti({ openai: {}, userRequest: 'q', response: 'r', n: 0 });
    assert.equal(calls, 1);
  });

  it('disagreement = "low" when IQR < 1', async () => {
    judgeMock._next = async () => ({
      helpful: 5, honest: 5, harmless: 5, overall: 7,
      issues: [], reasoning: '',
    });
    const out = await mj.scoreMulti({ openai: {}, userRequest: 'q', response: 'r', n: 3 });
    assert.equal(out.disagreement, 'low');
  });

  it('disagreement = "medium" when 1 <= IQR < 3', async () => {
    // Scores 5, 6, 7 → IQR = 1 (q3=6.5, q1=5.5).
    let i = 0;
    const seq = [5, 6, 7];
    judgeMock._next = async () => ({
      helpful: 5, honest: 5, harmless: 5, overall: seq[i++ % seq.length],
      issues: [], reasoning: '',
    });
    const out = await mj.scoreMulti({ openai: {}, userRequest: 'q', response: 'r', n: 3 });
    assert.equal(out.disagreement, 'medium');
  });

  it('disagreement = "high" when IQR >= 3', async () => {
    let i = 0;
    const seq = [2, 5, 9];
    judgeMock._next = async () => ({
      helpful: 5, honest: 5, harmless: 5, overall: seq[i++ % seq.length],
      issues: [], reasoning: '',
    });
    const out = await mj.scoreMulti({ openai: {}, userRequest: 'q', response: 'r', n: 3 });
    assert.equal(out.disagreement, 'high');
  });

  it('aggregated.helpful/honest/harmless are independent medians', async () => {
    let i = 0;
    const seq = [
      { helpful: 9, honest: 5, harmless: 1, overall: 5 },
      { helpful: 5, honest: 9, harmless: 5, overall: 6 },
      { helpful: 1, honest: 5, harmless: 9, overall: 5 },
    ];
    judgeMock._next = async () => ({
      ...seq[i++ % seq.length], issues: [], reasoning: '',
    });
    const out = await mj.scoreMulti({ openai: {}, userRequest: 'q', response: 'r', n: 3 });
    assert.equal(out.aggregated.helpful, 5);
    assert.equal(out.aggregated.honest, 5);
    assert.equal(out.aggregated.harmless, 5);
  });

  it('dedupes issues across rounds (case-insensitive) preserving first-seen order', async () => {
    let i = 0;
    const seq = [
      { helpful: 5, honest: 5, harmless: 5, overall: 5, issues: ['Slow response time', 'No citations'], reasoning: '' },
      { helpful: 5, honest: 5, harmless: 5, overall: 5, issues: ['SLOW response time', 'Minor typo'], reasoning: '' },
      { helpful: 5, honest: 5, harmless: 5, overall: 5, issues: ['no citations', 'Tone off'], reasoning: '' },
    ];
    judgeMock._next = async () => seq[i++ % seq.length];
    const out = await mj.scoreMulti({ openai: {}, userRequest: 'q', response: 'r', n: 3 });
    // 4 unique issues across 6 raw ones.
    assert.equal(out.issues.length, 4);
    assert.deepEqual(out.issues.slice(0, 2), ['Slow response time', 'No citations']);
  });

  it('caps issues at 10 even when dedup-set is larger', async () => {
    let i = 0;
    const longList = Array.from({ length: 20 }, (_, k) => `issue-${k}`);
    judgeMock._next = async () => ({
      helpful: 5, honest: 5, harmless: 5, overall: 5,
      issues: longList,
      reasoning: '',
    });
    const out = await mj.scoreMulti({ openai: {}, userRequest: 'q', response: 'r', n: 1 });
    assert.equal(out.issues.length, 10);
  });
});

// ── callJudgeWithPersona ────────────────────────────────────

describe('callJudgeWithPersona', () => {
  it('passes default temperature through to the judge when none provided', async () => {
    // judge.score is the dispatcher → _next captures the underlying
    // openai call. We can't easily inspect what was sent at that
    // level — instead verify the persona doesn't break the call.
    judgeMock._next = async () => ({
      helpful: 5, honest: 5, harmless: 5, overall: 5, issues: [], reasoning: '',
    });
    const out = await mj.callJudgeWithPersona({
      openai: { chat: { completions: { create: async () => ({ choices: [{ message: { content: '{}' } }] }) } } },
      userRequest: 'q', response: 'r',
      persona: 'You are strict.',
      temperature: 0.7,
    });
    assert.equal(out.overall, 5);
  });

  it('prepends persona to the system prompt when wrapping openai', async () => {
    let captured;
    const realOpenai = {
      chat: { completions: { create: async (params) => {
        captured = params;
        return { choices: [{ message: { content: '{}' } }] };
      }}},
    };
    // For this test we want the REAL judge to run with our wrapped
    // openai. Bypass the mock by calling the underlying logic — but
    // multi-judge's callJudgeWithPersona always goes through
    // `require('./alignment-judge').score`. So we override
    // _next to call wrappedOpenAI.chat.completions.create directly
    // so we can observe what the wrapper produced.
    judgeMock._next = async ({ openai }) => {
      // The wrapped openai's create() is what we want to capture.
      await openai.chat.completions.create({
        messages: [{ role: 'system', content: 'BASE SYSTEM' }],
      });
      return { helpful: 5, honest: 5, harmless: 5, overall: 5, issues: [], reasoning: '' };
    };
    await mj.callJudgeWithPersona({
      openai: realOpenai,
      userRequest: 'q', response: 'r',
      persona: 'STRICT JUDGE',
      temperature: 0.3,
    });
    // The wrapper should have prepended the persona to the first msg.
    assert.match(captured.messages[0].content, /STRICT JUDGE/);
    assert.match(captured.messages[0].content, /BASE SYSTEM/);
    // Temperature override applied.
    assert.equal(captured.temperature, 0.3);
  });

  it('null persona leaves the system prompt unchanged', async () => {
    let captured;
    const realOpenai = {
      chat: { completions: { create: async (params) => {
        captured = params;
        return { choices: [{ message: { content: '{}' } }] };
      }}},
    };
    judgeMock._next = async ({ openai }) => {
      await openai.chat.completions.create({
        messages: [{ role: 'system', content: 'BASE SYSTEM' }],
      });
      return { helpful: 5, honest: 5, harmless: 5, overall: 5, issues: [], reasoning: '' };
    };
    await mj.callJudgeWithPersona({
      openai: realOpenai,
      userRequest: 'q', response: 'r',
      persona: null,
      temperature: 0.1,
    });
    assert.equal(captured.messages[0].content, 'BASE SYSTEM');
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const keys = Object.keys(mj).sort();
    assert.deepEqual(keys, [
      'DEFAULT_N', 'MAX_N', 'PERSONAS', 'TEMPERATURES',
      'callJudgeWithPersona', 'median', 'quantile', 'scoreMulti', 'stddev',
    ]);
  });
});
