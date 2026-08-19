/**
 * Tests for services/agents/best-of-n.js — inference-time best-of-N
 * sample + rerank.
 *
 * The pick() function depends on ./alignment-judge.score — we mock
 * that via require-cache injection. generateAndPick() additionally
 * uses an openai chat client; we pass a fake one.
 */

'use strict';

const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const { describe, it, before, after, beforeEach } = require('node:test');

const JUDGE_PATH = require.resolve('../src/services/agents/alignment-judge');
const BON_PATH = require.resolve('../src/services/agents/best-of-n');

// Predictable judge mock: returns whatever the test sets up.
// best-of-n.js destructures `score` at require time, so the score
// function reference MUST stay stable across tests. A dispatcher
// delegates to `_next`, which tests swap.
const judgeMock = {
  _next: async () => ({ overall: 0.5 }),
  score: (...args) => judgeMock._next(...args),
};

let origJudgeCache, origBonCache;

function installMocks() {
  origJudgeCache = require.cache[JUDGE_PATH];
  origBonCache = require.cache[BON_PATH];
  const m = new Module(JUDGE_PATH);
  m.filename = JUDGE_PATH;
  m.loaded = true;
  m.exports = judgeMock;
  m.paths = Module._nodeModulePaths(path.dirname(JUDGE_PATH));
  require.cache[JUDGE_PATH] = m;
  delete require.cache[BON_PATH];
}

function restoreMocks() {
  if (origJudgeCache) require.cache[JUDGE_PATH] = origJudgeCache;
  else delete require.cache[JUDGE_PATH];
  if (origBonCache) require.cache[BON_PATH] = origBonCache;
  else delete require.cache[BON_PATH];
}

let bon;

before(() => {
  installMocks();
  bon = require('../src/services/agents/best-of-n');
});

after(() => {
  restoreMocks();
});

beforeEach(() => {
  judgeMock._next = async () => ({ overall: 0.5 });
});

// ── exported constants ──────────────────────────────────────────

describe('exported constants', () => {
  it('DEFAULT_N is 3', () => {
    assert.equal(bon.DEFAULT_N, 3);
  });

  it('SAMPLING_TEMPERATURES is the documented 4-temp ladder', () => {
    assert.deepEqual(bon.SAMPLING_TEMPERATURES, [0.2, 0.7, 1.0, 1.2]);
  });

  it('temperatures are strictly increasing', () => {
    const t = bon.SAMPLING_TEMPERATURES;
    for (let i = 1; i < t.length; i++) {
      assert.ok(t[i] > t[i - 1], `expected t[${i}] > t[${i - 1}]`);
    }
  });
});

// ── pick ──────────────────────────────────────────────────────────

describe('pick', () => {
  it('returns {winner: null, candidates: []} for empty samples', async () => {
    const out = await bon.pick({ openai: {}, userRequest: 'q', samples: [] });
    assert.deepEqual(out, { winner: null, candidates: [] });
  });

  it('returns {winner: null, candidates: []} for non-array samples', async () => {
    const out = await bon.pick({ openai: {}, userRequest: 'q', samples: 'not-array' });
    assert.deepEqual(out, { winner: null, candidates: [] });
  });

  it('single-sample shortcut: scores once and returns that sample as winner', async () => {
    let callCount = 0;
    judgeMock._next = async () => { callCount += 1; return { overall: 0.9 }; };
    const out = await bon.pick({
      openai: {}, userRequest: 'q', samples: ['only one'],
    });
    assert.equal(callCount, 1, 'judge should be called exactly once for a single sample');
    assert.equal(out.winner.index, 0);
    assert.equal(out.winner.response, 'only one');
    assert.equal(out.candidates.length, 1);
  });

  it('ranks N samples by judge.score.overall descending', async () => {
    // Map each sample to a deterministic score.
    judgeMock._next = async ({ response }) => {
      const scores = { a: 0.3, b: 0.9, c: 0.5 };
      return { overall: scores[response] ?? 0 };
    };
    const out = await bon.pick({
      openai: {}, userRequest: 'q', samples: ['a', 'b', 'c'],
    });
    assert.equal(out.winner.response, 'b', 'highest score should win');
    // Candidates list sorted same way.
    assert.deepEqual(out.candidates.map(c => c.response), ['b', 'c', 'a']);
  });

  it('stable tie-breaking: returns FIRST candidate on tied scores', async () => {
    judgeMock._next = async () => ({ overall: 0.5 });
    const out = await bon.pick({
      openai: {}, userRequest: 'q', samples: ['first', 'second', 'third'],
    });
    assert.equal(out.winner.response, 'first', 'on tie, first by original index wins');
    assert.equal(out.winner.index, 0);
  });

  it('preserves original index in winner + candidates', async () => {
    judgeMock._next = async ({ response }) => ({
      overall: response === 'second' ? 0.99 : 0.1,
    });
    const out = await bon.pick({
      openai: {}, userRequest: 'q', samples: ['first', 'second', 'third'],
    });
    assert.equal(out.winner.index, 1);
    // Each candidate's index field stays the SAMPLE's original index.
    const indices = out.candidates.map(c => c.index).sort();
    assert.deepEqual(indices, [0, 1, 2]);
  });

  it('forwards sourceContext and judgeModel through to the judge', async () => {
    let captured;
    judgeMock._next = async (args) => { captured = args; return { overall: 0.5 }; };
    await bon.pick({
      openai: { id: 'oa-x' },
      userRequest: 'q',
      samples: ['s'],
      sourceContext: 'src-ctx',
      judgeModel: 'judge-xyz',
    });
    assert.equal(captured.sourceContext, 'src-ctx');
    assert.equal(captured.model, 'judge-xyz');
    assert.equal(captured.userRequest, 'q');
  });
});

// ── generateAndPick ──────────────────────────────────────────────

describe('generateAndPick · validation', () => {
  it('throws when openai missing', async () => {
    await assert.rejects(
      () => bon.generateAndPick({ messages: [{ role: 'user', content: 'x' }] }),
      /openai client required/,
    );
  });

  it('throws when messages is missing or empty', async () => {
    const fakeOA = { chat: { completions: { create: async () => ({ choices: [] }) } } };
    await assert.rejects(
      () => bon.generateAndPick({ openai: fakeOA }),
      /messages array required/,
    );
    await assert.rejects(
      () => bon.generateAndPick({ openai: fakeOA, messages: [] }),
      /messages array required/,
    );
    await assert.rejects(
      () => bon.generateAndPick({ openai: fakeOA, messages: 'not-array' }),
      /messages array required/,
    );
  });
});

describe('generateAndPick · happy paths', () => {
  function fakeOpenAI(responses) {
    let i = 0;
    return {
      chat: {
        completions: {
          create: async ({ temperature }) => {
            const text = responses(temperature, i);
            i += 1;
            return { choices: [{ message: { content: text } }] };
          },
        },
      },
    };
  }

  it('generates N samples at varied temperatures and ranks them', async () => {
    judgeMock._next = async ({ response }) => ({
      overall: response.length / 10,  // longer = higher
    });
    const openai = fakeOpenAI((t) => `sample-T${t}`);
    const out = await bon.generateAndPick({
      openai,
      messages: [{ role: 'user', content: 'q' }],
      n: 3,
      userRequest: 'q',
    });
    assert.equal(out.candidates.length, 3);
    assert.ok(out.winner);
  });

  it('clamps n to SAMPLING_TEMPERATURES.length (max 4)', async () => {
    judgeMock._next = async () => ({ overall: 0.5 });
    const openai = fakeOpenAI((t) => `s-${t}`);
    const out = await bon.generateAndPick({
      openai,
      messages: [{ role: 'user', content: 'q' }],
      n: 99,
      userRequest: 'q',
    });
    assert.equal(out.candidates.length, bon.SAMPLING_TEMPERATURES.length);
  });

  it('clamps n to a floor of 1', async () => {
    judgeMock._next = async () => ({ overall: 0.5 });
    const openai = fakeOpenAI((t) => `s-${t}`);
    const out = await bon.generateAndPick({
      openai,
      messages: [{ role: 'user', content: 'q' }],
      n: 0,
      userRequest: 'q',
    });
    assert.equal(out.candidates.length, 1);
  });

  it('a single failing sample does NOT kill the batch — drops the slot', async () => {
    const muted = console.warn;
    console.warn = () => {};
    try {
      let i = 0;
      const openai = {
        chat: {
          completions: {
            create: async () => {
              i += 1;
              if (i === 2) throw new Error('mid sample failed');
              return { choices: [{ message: { content: `s${i}` } }] };
            },
          },
        },
      };
      judgeMock._next = async () => ({ overall: 0.5 });
      const out = await bon.generateAndPick({
        openai,
        messages: [{ role: 'user', content: 'q' }],
        n: 3,
        userRequest: 'q',
      });
      // 2 succeed, 1 failed → 2 candidates remain.
      assert.equal(out.candidates.length, 2);
    } finally {
      console.warn = muted;
    }
  });

  it('all-failing samples produces empty result', async () => {
    const muted = console.warn;
    console.warn = () => {};
    try {
      const openai = {
        chat: { completions: { create: async () => { throw new Error('all failed'); } } },
      };
      const out = await bon.generateAndPick({
        openai,
        messages: [{ role: 'user', content: 'q' }],
        n: 3,
        userRequest: 'q',
      });
      assert.deepEqual(out, { winner: null, candidates: [] });
    } finally {
      console.warn = muted;
    }
  });

  it('forwards completionOpts (response_format, tools, etc.)', async () => {
    let captured;
    const openai = {
      chat: { completions: { create: async (opts) => {
        captured = opts;
        return { choices: [{ message: { content: 'x' } }] };
      }}},
    };
    judgeMock._next = async () => ({ overall: 0.5 });
    await bon.generateAndPick({
      openai,
      messages: [{ role: 'user', content: 'q' }],
      n: 1,
      userRequest: 'q',
      completionOpts: { response_format: { type: 'json_object' } },
    });
    assert.deepEqual(captured.response_format, { type: 'json_object' });
  });

  it('uses the requested model + default model when none supplied', async () => {
    const calls = [];
    const openai = {
      chat: { completions: { create: async (opts) => {
        calls.push(opts.model);
        return { choices: [{ message: { content: 'x' } }] };
      }}},
    };
    judgeMock._next = async () => ({ overall: 0.5 });
    await bon.generateAndPick({
      openai,
      messages: [{ role: 'user', content: 'q' }],
      n: 1,
      userRequest: 'q',
    });
    assert.equal(calls[0], 'gpt-4o-mini');  // default model

    await bon.generateAndPick({
      openai,
      messages: [{ role: 'user', content: 'q' }],
      n: 1,
      model: 'custom-model',
      userRequest: 'q',
    });
    assert.equal(calls[1], 'custom-model');
  });

  it('uses temperatures from SAMPLING_TEMPERATURES in order', async () => {
    const tempsUsed = [];
    const openai = {
      chat: { completions: { create: async (opts) => {
        tempsUsed.push(opts.temperature);
        return { choices: [{ message: { content: 's' } }] };
      }}},
    };
    judgeMock._next = async () => ({ overall: 0.5 });
    await bon.generateAndPick({
      openai,
      messages: [{ role: 'user', content: 'q' }],
      n: 4,
      userRequest: 'q',
    });
    assert.deepEqual(tempsUsed.sort(), bon.SAMPLING_TEMPERATURES.slice());
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const keys = Object.keys(bon).sort();
    assert.deepEqual(keys, ['DEFAULT_N', 'SAMPLING_TEMPERATURES', 'generateAndPick', 'pick']);
  });
});
