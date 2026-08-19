/**
 * Tests for services/agents/intent-clarifier.js — ambiguity-detection
 * pre-flight check.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  clarify,
  normalise,
  SYSTEM,
  MAX_QUESTIONS,
} = require('../src/services/agents/intent-clarifier');

// ── constants ────────────────────────────────────────────────────

describe('constants', () => {
  it('MAX_QUESTIONS = 3', () => {
    assert.equal(MAX_QUESTIONS, 3);
  });

  it('SYSTEM is a non-empty string mentioning "clear" vs "ambiguous"', () => {
    assert.equal(typeof SYSTEM, 'string');
    assert.match(SYSTEM, /CLEAR/);
    assert.match(SYSTEM, /AMBIGUOUS/);
    assert.match(SYSTEM, /1-3 questions/);
  });
});

// ── normalise ────────────────────────────────────────────────────

describe('normalise', () => {
  it('returns clear for unparseable JSON (pass-through default)', () => {
    const out = normalise('not json {');
    assert.equal(out.status, 'clear');
    assert.match(out.reasoning, /unparseable/);
  });

  it('returns clear for an empty object', () => {
    const out = normalise('{}');
    assert.equal(out.status, 'clear');
  });

  it('ambiguous with valid questions yields status=ambiguous', () => {
    const out = normalise(JSON.stringify({
      status: 'ambiguous',
      questions: ['What file should we test?', 'What is the entry point?'],
      reasoning: 'no target specified',
    }));
    assert.equal(out.status, 'ambiguous');
    assert.equal(out.questions.length, 2);
    assert.equal(out.reasoning, 'no target specified');
  });

  it('filters out questions shorter than 6 chars', () => {
    const out = normalise(JSON.stringify({
      status: 'ambiguous',
      questions: ['ok?', 'why', 'this is a real question?'],
    }));
    assert.equal(out.questions.length, 1);
    assert.equal(out.questions[0], 'this is a real question?');
  });

  it('filters out questions longer than 300 chars', () => {
    const out = normalise(JSON.stringify({
      status: 'ambiguous',
      questions: ['short ok?', 'x'.repeat(400)],
    }));
    assert.equal(out.questions.length, 1);
    assert.equal(out.questions[0], 'short ok?');
  });

  it('caps to MAX_QUESTIONS (3)', () => {
    const out = normalise(JSON.stringify({
      status: 'ambiguous',
      questions: ['q1 here?', 'q2 here?', 'q3 here?', 'q4 here?', 'q5 here?'],
    }));
    assert.equal(out.questions.length, 3);
  });

  it('trims whitespace from each question', () => {
    const out = normalise(JSON.stringify({
      status: 'ambiguous',
      questions: ['  what is the file?  '],
    }));
    assert.equal(out.questions[0], 'what is the file?');
  });

  it('coerces non-string questions and skips empty', () => {
    const out = normalise(JSON.stringify({
      status: 'ambiguous',
      questions: ['valid question?', null, 42, '', 'another?'],
    }));
    // null → 'null' (5 chars, filtered as <6)
    // 42 → '42' (filtered)
    // '' → filtered
    assert.equal(out.questions.length, 2);
  });

  it('ambiguous-without-actionable-questions degrades to clear', () => {
    // When reasoning is provided, it's preserved; only the absence
    // triggers the default 'ambiguous-without-questions → pass'.
    const withReasoning = normalise(JSON.stringify({
      status: 'ambiguous',
      questions: [],
      reasoning: 'unclear but no questions',
    }));
    assert.equal(withReasoning.status, 'clear');
    assert.equal(withReasoning.reasoning, 'unclear but no questions');

    const withoutReasoning = normalise(JSON.stringify({
      status: 'ambiguous',
      questions: [],
    }));
    assert.equal(withoutReasoning.status, 'clear');
    assert.match(withoutReasoning.reasoning, /ambiguous-without-questions/);
  });

  it('ambiguous with non-array questions degrades to clear', () => {
    const out = normalise(JSON.stringify({
      status: 'ambiguous',
      questions: 'not-an-array',
    }));
    assert.equal(out.status, 'clear');
  });

  it('reasoning truncated to 300 chars on ambiguous', () => {
    const out = normalise(JSON.stringify({
      status: 'ambiguous',
      questions: ['real question?'],
      reasoning: 'r'.repeat(500),
    }));
    assert.equal(out.reasoning.length, 300);
  });

  it('blocked status surfaces with reason', () => {
    const out = normalise(JSON.stringify({
      status: 'blocked',
      reason: 'out of scope for code assistant',
    }));
    assert.equal(out.status, 'blocked');
    assert.equal(out.reason, 'out of scope for code assistant');
  });

  it('blocked without reason defaults to "out of scope"', () => {
    const out = normalise(JSON.stringify({ status: 'blocked' }));
    assert.equal(out.status, 'blocked');
    assert.equal(out.reason, 'out of scope');
  });

  it('blocked.reason truncated to 300 chars', () => {
    const out = normalise(JSON.stringify({
      status: 'blocked',
      reason: 'x'.repeat(500),
    }));
    assert.equal(out.reason.length, 300);
  });

  it('unknown status falls through to clear', () => {
    const out = normalise(JSON.stringify({ status: 'maybe', reasoning: 'IDK' }));
    assert.equal(out.status, 'clear');
    assert.equal(out.reasoning, 'IDK');
  });
});

// ── clarify ──────────────────────────────────────────────────────

describe('clarify', () => {
  function fakeOpenAI(content) {
    return {
      lastRequest: null,
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

  it('returns clear (pass-through) when openai client is missing', async () => {
    const out = await clarify({ request: 'hello world' });
    assert.equal(out.status, 'clear');
    assert.match(out.reasoning, /no LLM client/);
  });

  it('short / empty / non-string request → ambiguous with short-asking question', async () => {
    const openai = fakeOpenAI('{}');
    const shorts = ['', '   ', null, 42, 'hi', 'help?'];
    for (const r of shorts) {
      const out = await clarify({ openai, request: r });
      assert.equal(out.status, 'ambiguous', `failed for ${JSON.stringify(r)}`);
      assert.equal(out.questions.length, 1);
      assert.match(out.questions[0], /full sentence/);
    }
  });

  it('forwards a real request through and parses the response', async () => {
    const openai = fakeOpenAI(JSON.stringify({ status: 'clear' }));
    const out = await clarify({
      openai,
      request: 'Generate unit tests for utils/foo.ts',
    });
    assert.equal(out.status, 'clear');
  });

  it('fails open: returns clear on LLM error (no propagation)', async () => {
    const muted = console.warn;
    console.warn = () => {};
    try {
      const openai = {
        chat: { completions: { create: async () => { throw new Error('llm down'); } } },
      };
      const out = await clarify({
        openai,
        request: 'A reasonable engineering ask',
      });
      assert.equal(out.status, 'clear');
      assert.match(out.reasoning, /clarifier error/);
    } finally {
      console.warn = muted;
    }
  });

  it('sends response_format=json_object and low temperature (0.1)', async () => {
    let captured;
    const openai = {
      chat: { completions: { create: async (req) => {
        captured = req;
        return { choices: [{ message: { content: '{}' } }] };
      }}},
    };
    await clarify({
      openai,
      request: 'A real engineering ask',
    });
    assert.equal(captured.response_format.type, 'json_object');
    assert.equal(captured.temperature, 0.1);
  });

  it('caps request to MAX_REQUEST_CHARS (4000) before sending', async () => {
    let captured;
    const openai = {
      chat: { completions: { create: async (req) => {
        captured = req;
        return { choices: [{ message: { content: '{}' } }] };
      }}},
    };
    const longReq = 'a'.repeat(10_000);
    await clarify({ openai, request: longReq });
    // The user message includes the request body — must be ≤ 4000.
    const userMsg = captured.messages.find(m => m.role === 'user').content;
    // The body lives after "REQUEST:\n", so the request portion ≤ 4000.
    const requestPortion = userMsg.split('REQUEST:\n')[1] || '';
    assert.ok(requestPortion.length <= 4000);
  });

  it('includes agent label in the user prompt when supplied', async () => {
    let captured;
    const openai = {
      chat: { completions: { create: async (req) => {
        captured = req;
        return { choices: [{ message: { content: '{}' } }] };
      }}},
    };
    await clarify({
      openai,
      request: 'real engineering ask',
      agent: 'code-gen-agent',
    });
    const userMsg = captured.messages.find(m => m.role === 'user').content;
    assert.match(userMsg, /Intended specialist: code-gen-agent/);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports clarify, normalise, SYSTEM, MAX_QUESTIONS', () => {
    const mod = require('../src/services/agents/intent-clarifier');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['MAX_QUESTIONS', 'SYSTEM', 'clarify', 'normalise']);
  });
});
