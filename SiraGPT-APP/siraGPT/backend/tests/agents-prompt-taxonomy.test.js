/**
 * Tests for services/agents/prompt-taxonomy.js — 10-category prompt
 * classifier with per-user histograms.
 */

'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');

const {
  classify,
  recordClassification,
  getHistogram,
  distance,
  clearUser,
  _reset,
  TAXONOMY,
  DESCRIPTIONS,
  CLASSIFIER_SYSTEM,
} = require('../src/services/agents/prompt-taxonomy');

beforeEach(() => {
  _reset();
});

// ── enum + descriptions ────────────────────────────────────────

describe('TAXONOMY enum', () => {
  it('contains exactly 10 categories (paper Table 1)', () => {
    assert.equal(TAXONOMY.length, 10);
  });

  it('pins the exact list', () => {
    assert.deepEqual(TAXONOMY, [
      'generation',
      'open_qa',
      'closed_qa',
      'brainstorming',
      'chat',
      'rewrite',
      'summarization',
      'classification',
      'extraction',
      'other',
    ]);
  });

  it('every category has a DESCRIPTIONS entry', () => {
    for (const c of TAXONOMY) {
      assert.equal(typeof DESCRIPTIONS[c], 'string');
      assert.ok(DESCRIPTIONS[c].length > 0);
    }
  });

  it('no extra categories in DESCRIPTIONS', () => {
    assert.equal(Object.keys(DESCRIPTIONS).length, TAXONOMY.length);
  });
});

// ── CLASSIFIER_SYSTEM prompt ───────────────────────────────────

describe('CLASSIFIER_SYSTEM constant', () => {
  it('cites the InstructGPT paper origin', () => {
    assert.match(CLASSIFIER_SYSTEM, /Ouyang|2022|Table 1/);
  });

  it('mentions every category name in the prompt', () => {
    for (const c of TAXONOMY) {
      assert.match(CLASSIFIER_SYSTEM, new RegExp(c));
    }
  });

  it('uses STRICT JSON output spec', () => {
    assert.match(CLASSIFIER_SYSTEM, /STRICT JSON/);
    assert.match(CLASSIFIER_SYSTEM, /"category"/);
    assert.match(CLASSIFIER_SYSTEM, /"confidence"/);
  });
});

// ── recordClassification + getHistogram ────────────────────────

describe('recordClassification', () => {
  it('ignores invalid category', () => {
    recordClassification('u1', 'invalid');
    const h = getHistogram('u1');
    assert.equal(h.total, 0);
  });

  it('ignores empty userId', () => {
    recordClassification('', 'chat');
    const h = getHistogram('');
    assert.equal(h.total, 0);
  });

  it('records valid category and increments counter', () => {
    recordClassification('u1', 'chat');
    recordClassification('u1', 'chat');
    recordClassification('u1', 'open_qa');
    const h = getHistogram('u1');
    assert.equal(h.counts.chat, 2);
    assert.equal(h.counts.open_qa, 1);
    assert.equal(h.total, 3);
  });

  it('isolates per-user counters', () => {
    recordClassification('u1', 'chat');
    recordClassification('u2', 'chat');
    recordClassification('u2', 'chat');
    assert.equal(getHistogram('u1').counts.chat, 1);
    assert.equal(getHistogram('u2').counts.chat, 2);
  });
});

describe('getHistogram', () => {
  it('returns all-zero histogram for unknown user', () => {
    const h = getHistogram('nobody');
    assert.equal(h.total, 0);
    for (const c of TAXONOMY) {
      assert.equal(h.counts[c], 0);
      assert.equal(h.distribution[c], 0);
    }
  });

  it('distribution normalizes to sum 1.0', () => {
    recordClassification('u', 'chat');
    recordClassification('u', 'chat');
    recordClassification('u', 'open_qa');
    const h = getHistogram('u');
    assert.ok(Math.abs(h.distribution.chat - 2 / 3) < 1e-9);
    assert.ok(Math.abs(h.distribution.open_qa - 1 / 3) < 1e-9);
    const sum = Object.values(h.distribution).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1.0) < 1e-9);
  });

  it('includes counts AND total AND distribution fields', () => {
    recordClassification('u', 'chat');
    const h = getHistogram('u');
    assert.ok('counts' in h);
    assert.ok('total' in h);
    assert.ok('distribution' in h);
  });
});

// ── distance ──────────────────────────────────────────────────

describe('distance', () => {
  it('two empty histograms have distance 0', () => {
    assert.equal(distance(getHistogram('a'), getHistogram('b')), 0);
  });

  it('identical histograms have distance 0', () => {
    recordClassification('a', 'chat');
    recordClassification('a', 'chat');
    recordClassification('b', 'chat');
    recordClassification('b', 'chat');
    assert.equal(distance(getHistogram('a'), getHistogram('b')), 0);
  });

  it('fully-disjoint histograms have distance 1', () => {
    recordClassification('a', 'chat');
    recordClassification('b', 'open_qa');
    const d = distance(getHistogram('a'), getHistogram('b'));
    assert.ok(Math.abs(d - 1.0) < 1e-9);
  });

  it('partial overlap is between 0 and 1', () => {
    recordClassification('a', 'chat');
    recordClassification('a', 'open_qa');
    recordClassification('b', 'chat');
    const d = distance(getHistogram('a'), getHistogram('b'));
    assert.ok(d > 0 && d < 1, `expected partial distance in (0, 1), got ${d}`);
  });

  it('handles null/missing histograms (treats as empty)', () => {
    assert.equal(distance(null, null), 0);
    assert.equal(distance(undefined, undefined), 0);
  });
});

// ── clearUser + _reset ─────────────────────────────────────────

describe('clearUser', () => {
  it('removes a single user histogram, leaves others intact', () => {
    recordClassification('a', 'chat');
    recordClassification('b', 'open_qa');
    clearUser('a');
    assert.equal(getHistogram('a').total, 0);
    assert.equal(getHistogram('b').total, 1);
  });
});

describe('_reset', () => {
  it('clears the entire registry', () => {
    recordClassification('a', 'chat');
    recordClassification('b', 'open_qa');
    _reset();
    assert.equal(getHistogram('a').total, 0);
    assert.equal(getHistogram('b').total, 0);
  });
});

// ── classify (LLM) ─────────────────────────────────────────────

describe('classify', () => {
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

  it('returns "other" with confidence 0 when openai missing', async () => {
    const out = await classify({ request: 'hi' });
    assert.equal(out.category, 'other');
    assert.equal(out.confidence, 0);
  });

  it('returns "other" for missing/non-string request', async () => {
    const out = await classify({ openai: fakeOpenAI('{}'), request: null });
    assert.equal(out.category, 'other');
  });

  it('parses valid LLM response', async () => {
    const openai = fakeOpenAI(JSON.stringify({
      category: 'open_qa',
      confidence: 0.85,
      reasoning: 'standalone question',
    }));
    const out = await classify({ openai, request: 'What is the capital of France?' });
    assert.equal(out.category, 'open_qa');
    assert.equal(out.confidence, 0.85);
    assert.equal(out.reasoning, 'standalone question');
  });

  it('clamps confidence to [0, 1]', async () => {
    const openai = fakeOpenAI(JSON.stringify({
      category: 'chat',
      confidence: 1.5,
    }));
    const out = await classify({ openai, request: 'hi' });
    assert.equal(out.confidence, 1);
  });

  it('unknown category falls back to "other"', async () => {
    const openai = fakeOpenAI(JSON.stringify({ category: 'made-up', confidence: 0.5 }));
    const out = await classify({ openai, request: 'hi' });
    assert.equal(out.category, 'other');
  });

  it('non-numeric confidence defaults to 0.5', async () => {
    const openai = fakeOpenAI(JSON.stringify({ category: 'chat', confidence: 'high' }));
    const out = await classify({ openai, request: 'hi' });
    assert.equal(out.confidence, 0.5);
  });

  it('reasoning truncated to 200 chars + coerced to string', async () => {
    const openai = fakeOpenAI(JSON.stringify({
      category: 'chat',
      reasoning: 'r'.repeat(500),
    }));
    const out = await classify({ openai, request: 'hi' });
    assert.equal(out.reasoning.length, 200);
  });

  it('updates user histogram when userId provided', async () => {
    const openai = fakeOpenAI(JSON.stringify({ category: 'chat', confidence: 0.9 }));
    await classify({ openai, request: 'hi', userId: 'u-1' });
    await classify({ openai, request: 'hi', userId: 'u-1' });
    assert.equal(getHistogram('u-1').counts.chat, 2);
  });

  it('does NOT update histogram when userId missing', async () => {
    const openai = fakeOpenAI(JSON.stringify({ category: 'chat', confidence: 0.9 }));
    await classify({ openai, request: 'hi' });
    // No histograms should exist.
    assert.equal(getHistogram('any-user').total, 0);
  });

  it('fails open: catches LLM error and returns "other"', async () => {
    const muted = console.warn;
    console.warn = () => {};
    try {
      const openai = {
        chat: { completions: { create: async () => { throw new Error('llm down'); } } },
      };
      const out = await classify({ openai, request: 'hi' });
      assert.equal(out.category, 'other');
      assert.equal(out.confidence, 0);
      assert.match(out.reasoning, /llm down/);
    } finally {
      console.warn = muted;
    }
  });

  it('caps request to 4000 chars before sending to LLM', async () => {
    let captured;
    const openai = {
      chat: { completions: { create: async (req) => {
        captured = req;
        return { choices: [{ message: { content: '{}' } }] };
      }}},
    };
    await classify({ openai, request: 'a'.repeat(10_000) });
    const userMsg = captured.messages.find(m => m.role === 'user').content;
    assert.ok(userMsg.length <= 4000);
  });

  it('uses temperature=0.0 and json_object response_format', async () => {
    let captured;
    const openai = {
      chat: { completions: { create: async (req) => {
        captured = req;
        return { choices: [{ message: { content: '{}' } }] };
      }}},
    };
    await classify({ openai, request: 'hi' });
    assert.equal(captured.temperature, 0.0);
    assert.equal(captured.response_format.type, 'json_object');
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/agents/prompt-taxonomy');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, [
      'CLASSIFIER_SYSTEM',
      'DESCRIPTIONS',
      'TAXONOMY',
      '_reset',
      'classify',
      'clearUser',
      'distance',
      'getHistogram',
      'recordClassification',
    ]);
  });
});
