/**
 * Tests for services/agents/alignment-judge.js — HHH rubric scorer
 * used by best-of-N and post-response self-checks.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  score,
  JUDGE_SYSTEM,
  buildJudgePrompt,
  normalise,
} = require('../src/services/agents/alignment-judge');

// ── JUDGE_SYSTEM ────────────────────────────────────────────────

describe('JUDGE_SYSTEM constant', () => {
  it('mentions HELPFUL, HONEST, HARMLESS rubric dimensions', () => {
    assert.match(JUDGE_SYSTEM, /HELPFUL/);
    assert.match(JUDGE_SYSTEM, /HONEST/);
    assert.match(JUDGE_SYSTEM, /HARMLESS/);
  });

  it('cites the InstructGPT paper (Ouyang 2022)', () => {
    assert.match(JUDGE_SYSTEM, /InstructGPT|Ouyang/);
  });

  it('specifies STRICT JSON output format', () => {
    assert.match(JUDGE_SYSTEM, /STRICT JSON/);
    assert.match(JUDGE_SYSTEM, /"overall"/);
  });

  it('uses 0–10 score scale with anchor descriptions', () => {
    assert.match(JUDGE_SYSTEM, /0-10/);
    assert.match(JUDGE_SYSTEM, /10:.*exemplary/);
  });

  it('caps issues array at 4 concrete failings', () => {
    assert.match(JUDGE_SYSTEM, /up to 4 concrete failings/);
  });
});

// ── buildJudgePrompt ────────────────────────────────────────────

describe('buildJudgePrompt', () => {
  it('always includes USER REQUEST and MODEL RESPONSE sections', () => {
    const out = buildJudgePrompt({
      userRequest: 'q1',
      response: 'r1',
    });
    assert.match(out, /USER REQUEST:/);
    assert.match(out, /MODEL RESPONSE TO SCORE:/);
  });

  it('includes SOURCE CONTEXT section only when supplied', () => {
    const without = buildJudgePrompt({ userRequest: 'q', response: 'r' });
    assert.equal(without.includes('SOURCE CONTEXT'), false);
    const withCtx = buildJudgePrompt({ userRequest: 'q', response: 'r', sourceContext: 'ctx' });
    assert.match(withCtx, /SOURCE CONTEXT/);
  });

  it('JSON-stringifies non-string response', () => {
    const out = buildJudgePrompt({
      userRequest: 'q',
      response: { foo: 'bar', n: 42 },
    });
    assert.match(out, /"foo":"bar"/);
    assert.match(out, /"n":42/);
  });

  it('caps userRequest to 4000 chars', () => {
    const long = 'q'.repeat(10_000);
    const out = buildJudgePrompt({ userRequest: long, response: 'r' });
    const userPortion = out.match(/USER REQUEST:\n([\s\S]*?)\n\n---/)[1];
    assert.ok(userPortion.length <= 4000);
  });

  it('caps response to 8000 chars', () => {
    const long = 'r'.repeat(20_000);
    const out = buildJudgePrompt({ userRequest: 'q', response: long });
    const respPortion = out.match(/MODEL RESPONSE TO SCORE:\n([\s\S]*?)(?:\n\n---|\s*$)/)[1];
    assert.ok(respPortion.length <= 8000);
  });

  it('caps sourceContext to 6000 chars', () => {
    const long = 's'.repeat(10_000);
    const out = buildJudgePrompt({ userRequest: 'q', response: 'r', sourceContext: long });
    const ctxPortion = out.match(/SOURCE CONTEXT[^\n]*:\n([\s\S]*)$/)[1];
    assert.ok(ctxPortion.length <= 6000);
  });

  it('uses --- separator between sections', () => {
    const out = buildJudgePrompt({ userRequest: 'q', response: 'r', sourceContext: 'c' });
    const sections = out.split('\n\n---\n\n');
    assert.equal(sections.length, 3);
  });
});

// ── normalise ────────────────────────────────────────────────────

describe('normalise', () => {
  it('returns the parsed scores when input is valid', () => {
    const out = normalise(JSON.stringify({
      helpful: 9, honest: 7, harmless: 10, overall: 8,
      issues: ['nit-pick 1'], reasoning: 'mostly good',
    }));
    assert.equal(out.helpful, 9);
    assert.equal(out.honest, 7);
    assert.equal(out.harmless, 10);
    assert.equal(out.overall, 8);
    assert.deepEqual(out.issues, ['nit-pick 1']);
    assert.equal(out.reasoning, 'mostly good');
  });

  it('clamps scores to [0, 10]', () => {
    const out = normalise(JSON.stringify({
      helpful: 15, honest: -2, harmless: 50, overall: 12,
    }));
    assert.equal(out.helpful, 10);
    assert.equal(out.honest, 0);
    assert.equal(out.harmless, 10);
    assert.equal(out.overall, 10);
  });

  it('non-numeric strings default to 5 (neutral)', () => {
    // clamp() uses Number(n) → NaN for 'high' → !isFinite → null → ?? 5.
    // BUT: Number(null) is 0, which IS finite → clamps to 0 (not 5).
    // Pin the actual behavior: only NaN-producing inputs fall back to 5.
    const out = normalise(JSON.stringify({
      helpful: 'high', honest: 'low',
    }));
    assert.equal(out.helpful, 5);
    assert.equal(out.honest, 5);
  });

  it('null score coerces via Number(null)=0 (NOT a fallback to 5)', () => {
    const out = normalise(JSON.stringify({ helpful: null }));
    assert.equal(out.helpful, 0, 'Number(null)=0 is finite → clamps to 0');
  });

  it('missing overall computes min(helpful, honest, harmless)', () => {
    const out = normalise(JSON.stringify({
      helpful: 8, honest: 7, harmless: 3,
    }));
    assert.equal(out.overall, 3, 'overall should be min when missing');
  });

  it('missing overall AND missing dimensions: defaults to min(5, 5, 5) = 5', () => {
    const out = normalise(JSON.stringify({}));
    assert.equal(out.overall, 5);
  });

  it('truncates issues to 4 entries', () => {
    const issues = ['i1', 'i2', 'i3', 'i4', 'i5', 'i6'];
    const out = normalise(JSON.stringify({
      helpful: 5, honest: 5, harmless: 5, overall: 5,
      issues,
    }));
    assert.equal(out.issues.length, 4);
  });

  it('each issue capped at 200 chars and coerced to string', () => {
    const out = normalise(JSON.stringify({
      issues: ['x'.repeat(500), 42, null, 'short'],
    }));
    assert.equal(out.issues[0].length, 200);
    // 42 → "42" (valid)
    assert.equal(out.issues[1], '42');
    // null becomes 'null' as a string; truthy after coercion, so included.
    // Actually: String(null) = "null" → 4 chars → kept. The filter is Boolean
    // which excludes empty string ''.
    // 'null' is non-empty, so it's kept.
    assert.equal(out.issues.length, 4);
  });

  it('non-array issues → []', () => {
    const out = normalise(JSON.stringify({ issues: 'one' }));
    assert.deepEqual(out.issues, []);
  });

  it('reasoning capped at 300 chars and coerced to string', () => {
    const out = normalise(JSON.stringify({ reasoning: 'r'.repeat(500) }));
    assert.equal(out.reasoning.length, 300);
  });

  it('non-string reasoning → ""', () => {
    const out = normalise(JSON.stringify({ reasoning: 42 }));
    assert.equal(out.reasoning, '');
  });

  it('unparseable JSON returns fallback (neutral 5s)', () => {
    const out = normalise('not json {');
    assert.equal(out.helpful, 5);
    assert.equal(out.honest, 5);
    assert.equal(out.harmless, 5);
    assert.equal(out.overall, 5);
    assert.match(out.reasoning, /unparseable/);
  });

  it('always includes raw field with the original input', () => {
    const json = '{"helpful":7}';
    const out = normalise(json);
    assert.equal(out.raw, json);
  });
});

// ── score (LLM-driven) ─────────────────────────────────────────

describe('score', () => {
  function fakeOpenAI(content) {
    return {
      chat: {
        completions: {
          create: async function (req) {
            this.lastReq = req;
            return { choices: [{ message: { content } }] };
          },
        },
      },
    };
  }

  it('returns fallback when openai client is missing', async () => {
    const out = await score({ userRequest: 'q', response: 'r' });
    assert.equal(out.helpful, 5);
    assert.equal(out.overall, 5);
    assert.match(out.reasoning, /judge unavailable.*no LLM client/);
  });

  it('returns parsed scores on success', async () => {
    const openai = fakeOpenAI(JSON.stringify({
      helpful: 9, honest: 8, harmless: 10, overall: 9,
      issues: [], reasoning: 'great',
    }));
    const out = await score({ openai, userRequest: 'q', response: 'r' });
    assert.equal(out.helpful, 9);
    assert.equal(out.overall, 9);
  });

  it('fails open on LLM error (returns neutral fallback, does not throw)', async () => {
    const muted = console.warn;
    console.warn = () => {};
    try {
      const openai = {
        chat: { completions: { create: async () => { throw new Error('llm exploded'); } } },
      };
      const out = await score({ openai, userRequest: 'q', response: 'r' });
      assert.equal(out.helpful, 5);
      assert.equal(out.overall, 5);
      assert.match(out.reasoning, /llm exploded/);
    } finally {
      console.warn = muted;
    }
  });

  it('uses temperature=0 (deterministic) and json_object response_format', async () => {
    let captured;
    const openai = {
      chat: { completions: { create: async (req) => {
        captured = req;
        return { choices: [{ message: { content: '{}' } }] };
      }}},
    };
    await score({ openai, userRequest: 'q', response: 'r' });
    assert.equal(captured.temperature, 0.0);
    assert.equal(captured.response_format.type, 'json_object');
  });

  it('forwards model param to the LLM call', async () => {
    let captured;
    const openai = {
      chat: { completions: { create: async (req) => {
        captured = req;
        return { choices: [{ message: { content: '{}' } }] };
      }}},
    };
    await score({ openai, userRequest: 'q', response: 'r', model: 'custom-judge-model' });
    assert.equal(captured.model, 'custom-judge-model');
  });

  it('default model is gpt-4o-mini', async () => {
    let captured;
    const openai = {
      chat: { completions: { create: async (req) => {
        captured = req;
        return { choices: [{ message: { content: '{}' } }] };
      }}},
    };
    await score({ openai, userRequest: 'q', response: 'r' });
    assert.equal(captured.model, 'gpt-4o-mini');
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports score, JUDGE_SYSTEM, buildJudgePrompt, normalise', () => {
    const mod = require('../src/services/agents/alignment-judge');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['JUDGE_SYSTEM', 'buildJudgePrompt', 'normalise', 'score']);
  });
});
