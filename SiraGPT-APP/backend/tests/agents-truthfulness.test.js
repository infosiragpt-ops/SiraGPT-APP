/**
 * Tests for services/agents/truthfulness.js — hallucination detector.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  check,
  extractClaims,
  fuzzyGround,
  llmVerify,
  CLAIM_EXTRACT_SYSTEM,
  LLM_VERIFY_SYSTEM,
} = require('../src/services/agents/truthfulness');

// ── system prompts ───────────────────────────────────────────────

describe('CLAIM_EXTRACT_SYSTEM', () => {
  it('mentions STRICT JSON', () => {
    assert.match(CLAIM_EXTRACT_SYSTEM, /STRICT JSON/);
  });

  it('describes what counts as a "claim" (atomic, checkable)', () => {
    assert.match(CLAIM_EXTRACT_SYSTEM, /atomic factual/i);
    assert.match(CLAIM_EXTRACT_SYSTEM, /Opinions.*are NOT claims/);
  });

  it('caps claims at 10', () => {
    assert.match(CLAIM_EXTRACT_SYSTEM, /at most 10 claims/);
  });
});

describe('LLM_VERIFY_SYSTEM', () => {
  it('requires "supported" boolean + confidence + evidence', () => {
    assert.match(LLM_VERIFY_SYSTEM, /"supported".*"confidence".*"evidence"/s);
  });

  it('emphasizes direct support OR clear implication', () => {
    assert.match(LLM_VERIFY_SYSTEM, /directly states or clearly implies/);
  });

  it('caps evidence at 200 chars', () => {
    assert.match(LLM_VERIFY_SYSTEM, /evidence under 200 chars/);
  });
});

// ── fuzzyGround ────────────────────────────────────────────────

describe('fuzzyGround', () => {
  it('returns null when normalised claim < 6 chars', () => {
    assert.equal(fuzzyGround('a', [{ text: 'the earth is round' }]), null);
  });

  it('returns null when claim has no content words after stopword filter', () => {
    // "the is are" → all stopwords, content words = [].
    assert.equal(fuzzyGround('the is are', [{ text: 'anything' }]), null);
  });

  it('matches when ≥60% of content words appear in chunk', () => {
    const out = fuzzyGround('Python is a programming language', [
      { text: 'Python is a popular programming language for data science.' },
    ]);
    assert.ok(out);
    assert.equal(out.matchType, 'fuzzy');
    assert.ok(out.confidence >= 0.6);
  });

  it('does NOT match when < 60% words present', () => {
    const out = fuzzyGround('Earth orbits the Sun once per year', [
      { text: 'Earth rotates on its axis.' },
    ]);
    assert.equal(out, null);
  });

  it('normalises case + punctuation (gpt-4 ≈ GPT 4)', () => {
    const out = fuzzyGround('GPT-4o-mini is fast', [
      { text: 'The gpt 4o mini model is fast for many tasks.' },
    ]);
    assert.ok(out);
  });

  it('matchedSource populated when chunk has .source', () => {
    const out = fuzzyGround('Earth orbits Sun once yearly', [
      { text: 'Earth orbits the Sun once a year approximately.', source: 'astronomy.md' },
    ]);
    assert.equal(out.matchedSource, 'astronomy.md');
  });

  it('plain-string chunks (no .text/.source) work', () => {
    const out = fuzzyGround('Python is a programming language', [
      'Python is a popular programming language with many uses.',
    ]);
    assert.ok(out);
    assert.equal(out.matchedSource, null);
  });

  it('skips empty / null chunks', () => {
    const out = fuzzyGround('Python is a programming language', [
      null,
      { text: '' },
      { text: 'Python is a popular programming language for data work.' },
    ]);
    assert.ok(out);
  });

  it('returns null when no chunks supplied', () => {
    assert.equal(fuzzyGround('something specific here yes', []), null);
  });
});

// ── extractClaims ──────────────────────────────────────────────

describe('extractClaims', () => {
  function fakeOpenAI(content) {
    return {
      chat: { completions: { create: async () => ({ choices: [{ message: { content } }] }) } },
    };
  }

  it('returns [] when openai missing', async () => {
    const out = await extractClaims({ response: 'x' });
    assert.deepEqual(out, []);
  });

  it('returns [] when response is empty/null', async () => {
    assert.deepEqual(await extractClaims({ openai: fakeOpenAI('{}'), response: null }), []);
    assert.deepEqual(await extractClaims({ openai: fakeOpenAI('{}'), response: '' }), []);
  });

  it('parses {"claims": [...]} into the array', async () => {
    const openai = fakeOpenAI(JSON.stringify({
      claims: ['Earth orbits the Sun', 'Python was created in 1991'],
    }));
    const out = await extractClaims({ openai, response: 'r' });
    assert.deepEqual(out, ['Earth orbits the Sun', 'Python was created in 1991']);
  });

  it('truncates each claim to 300 chars', async () => {
    const openai = fakeOpenAI(JSON.stringify({ claims: ['c'.repeat(800)] }));
    const out = await extractClaims({ openai, response: 'r' });
    assert.equal(out[0].length, 300);
  });

  it('caps to 10 claims', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `claim ${i + 1}`);
    const openai = fakeOpenAI(JSON.stringify({ claims: many }));
    const out = await extractClaims({ openai, response: 'r' });
    assert.equal(out.length, 10);
  });

  it('filters empty/falsy claims', async () => {
    const openai = fakeOpenAI(JSON.stringify({ claims: ['good claim', '', null, 'another'] }));
    const out = await extractClaims({ openai, response: 'r' });
    // null → "null" (truthy, length=4). Empty → dropped.
    assert.ok(out.length >= 2);
    assert.ok(out.includes('good claim'));
    assert.ok(out.includes('another'));
  });

  it('returns [] when LLM emits malformed JSON (fail open)', async () => {
    const _origWarn = console.warn;
    console.warn = () => {};
    try {
      const openai = fakeOpenAI('not json');
      const out = await extractClaims({ openai, response: 'r' });
      assert.deepEqual(out, []);
    } finally {
      console.warn = _origWarn;
    }
  });

  it('returns [] on LLM thrown error', async () => {
    const _origWarn = console.warn;
    console.warn = () => {};
    try {
      const openai = {
        chat: { completions: { create: async () => { throw new Error('boom'); } } },
      };
      const out = await extractClaims({ openai, response: 'r' });
      assert.deepEqual(out, []);
    } finally {
      console.warn = _origWarn;
    }
  });

  it('non-string response is JSON-stringified before sending', async () => {
    let captured;
    const openai = {
      chat: { completions: { create: async (req) => {
        captured = req;
        return { choices: [{ message: { content: '{"claims":[]}' } }] };
      }}},
    };
    await extractClaims({ openai, response: { foo: 'bar', n: 42 } });
    const userMsg = captured.messages.find(m => m.role === 'user').content;
    assert.match(userMsg, /"foo":"bar"/);
    assert.match(userMsg, /"n":42/);
  });
});

// ── llmVerify ──────────────────────────────────────────────────

describe('llmVerify', () => {
  it('returns unsupported when openai missing', async () => {
    const out = await llmVerify({ claim: 'x', contextChunks: [] });
    assert.deepEqual(out, { supported: false, confidence: 0, evidence: '' });
  });

  it('parses {supported, confidence, evidence}', async () => {
    const openai = {
      chat: { completions: { create: async () => ({
        choices: [{ message: { content: JSON.stringify({
          supported: true, confidence: 0.85, evidence: 'directly stated',
        }) } }],
      })}},
    };
    const out = await llmVerify({ openai, claim: 'x', contextChunks: [] });
    assert.equal(out.supported, true);
    assert.equal(out.confidence, 0.85);
    assert.equal(out.evidence, 'directly stated');
  });

  it('clamps confidence to [0, 1]', async () => {
    const openai = {
      chat: { completions: { create: async () => ({
        choices: [{ message: { content: JSON.stringify({ supported: true, confidence: 1.5 }) } }],
      })}},
    };
    const out = await llmVerify({ openai, claim: 'x', contextChunks: [] });
    assert.equal(out.confidence, 1);
  });

  it('non-numeric confidence defaults to 0.5', async () => {
    const openai = {
      chat: { completions: { create: async () => ({
        choices: [{ message: { content: JSON.stringify({ supported: true, confidence: 'high' }) } }],
      })}},
    };
    const out = await llmVerify({ openai, claim: 'x', contextChunks: [] });
    assert.equal(out.confidence, 0.5);
  });

  it('evidence truncated to 200 chars + coerced to string', async () => {
    const openai = {
      chat: { completions: { create: async () => ({
        choices: [{ message: { content: JSON.stringify({
          supported: true, evidence: 'e'.repeat(500),
        }) } }],
      })}},
    };
    const out = await llmVerify({ openai, claim: 'x', contextChunks: [] });
    assert.equal(out.evidence.length, 200);
  });

  it('fails open on LLM error', async () => {
    const _origWarn = console.warn;
    console.warn = () => {};
    try {
      const openai = {
        chat: { completions: { create: async () => { throw new Error('boom'); } } },
      };
      const out = await llmVerify({ openai, claim: 'x', contextChunks: [] });
      assert.equal(out.supported, false);
    } finally {
      console.warn = _origWarn;
    }
  });
});

// ── check (full pipeline) ──────────────────────────────────────

describe('check', () => {
  it('returns trivial result when no claims extracted', async () => {
    const out = await check({
      openai: null,  // → extractClaims returns []
      response: 'opinion only',
      contextChunks: [],
    });
    assert.deepEqual(out.claims, []);
    assert.equal(out.unfoundedCount, 0);
    assert.equal(out.score, 1);
    assert.match(out.summary, /no checkable claims/);
  });

  it('marks claim grounded when fuzzy match succeeds', async () => {
    // Skip the LLM extraction by faking openai's response.
    const openai = {
      chat: { completions: { create: async () => ({
        choices: [{ message: { content: JSON.stringify({
          claims: ['Python is a programming language'],
        }) } }],
      })}},
    };
    const out = await check({
      openai,
      response: 'r',
      contextChunks: [{ text: 'Python is a popular programming language.', source: 'docs.md' }],
    });
    assert.equal(out.claims.length, 1);
    assert.equal(out.claims[0].grounded, true);
    assert.equal(out.claims[0].matchType, 'fuzzy');
    assert.equal(out.unfoundedCount, 0);
    assert.equal(out.score, 1);
  });

  it('marks claim ungrounded when no fuzzy + no chunks (skips LLM)', async () => {
    let llmCalls = 0;
    const openai = {
      chat: { completions: { create: async (req) => {
        llmCalls++;
        // First call is claim extraction.
        if (req.messages[0].content.includes('extract')) {
          return { choices: [{ message: { content: JSON.stringify({
            claims: ['Earth is flat'],
          })}}]};
        }
        return { choices: [{ message: { content: '{}' } }] };
      }}},
    };
    const out = await check({
      openai, response: 'r', contextChunks: [],  // no chunks
    });
    assert.equal(out.claims[0].grounded, false);
    assert.equal(out.claims[0].matchType, 'none');
    assert.equal(out.unfoundedCount, 1);
    // Only the claim-extraction call ran. No fallback verification.
    assert.equal(llmCalls, 1);
  });

  it('uses LLM fallback when fuzzy misses and llmFallback=true', async () => {
    const openai = {
      chat: { completions: { create: async (req) => {
        if (req.messages[0].content.toLowerCase().includes('extract')) {
          return { choices: [{ message: { content: JSON.stringify({
            claims: ['Python supports duck typing'],
          })}}]};
        }
        // LLM verify call: claim is supported per context.
        return { choices: [{ message: { content: JSON.stringify({
          supported: true, confidence: 0.9, evidence: 'duck typing mention',
        })}}]};
      }}},
    };
    const out = await check({
      openai, response: 'r',
      contextChunks: [{ text: 'Implicit interface conformance is common in Python.' }],
      llmFallback: true,
    });
    assert.equal(out.claims[0].grounded, true);
    assert.equal(out.claims[0].matchType, 'llm');
  });

  it('llmFallback=false skips the LLM verify pass', async () => {
    let llmCalls = 0;
    const openai = {
      chat: { completions: { create: async (req) => {
        llmCalls++;
        if (req.messages[0].content.toLowerCase().includes('extract')) {
          return { choices: [{ message: { content: JSON.stringify({
            claims: ['Python supports duck typing'],
          })}}]};
        }
        return { choices: [{ message: { content: '{}' } }] };
      }}},
    };
    await check({
      openai, response: 'r',
      contextChunks: [{ text: 'unrelated text here' }],
      llmFallback: false,
    });
    assert.equal(llmCalls, 1, 'only claim-extraction should run');
  });

  it('score = 1 - (unfounded / total)', async () => {
    const openai = {
      chat: { completions: { create: async (req) => {
        if (req.messages[0].content.toLowerCase().includes('extract')) {
          return { choices: [{ message: { content: JSON.stringify({
            claims: ['Earth orbits Sun', 'Earth is flat', 'Python is a snake species'],
          })}}]};
        }
        // LLM fallback: never supports.
        return { choices: [{ message: { content: JSON.stringify({
          supported: false, confidence: 0.8,
        })}}]};
      }}},
    };
    const out = await check({
      openai, response: 'r',
      contextChunks: [{ text: 'Earth orbits the Sun in space.' }],
    });
    // 1 grounded fuzzy, 2 unfounded → score = 1 - 2/3 ≈ 0.333.
    assert.equal(out.unfoundedCount, 2);
    assert.ok(Math.abs(out.score - 1/3) < 1e-9);
  });

  it('summary uses singular phrasing for grounded results', async () => {
    const openai = {
      chat: { completions: { create: async () => ({
        choices: [{ message: { content: JSON.stringify({
          claims: ['Python is a programming language'],
        }) } }],
      })}},
    };
    const out = await check({
      openai, response: 'r',
      contextChunks: [{ text: 'Python is a popular programming language for many tasks.' }],
    });
    assert.match(out.summary, /all 1 claims grounded/);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/agents/truthfulness');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, [
      'CLAIM_EXTRACT_SYSTEM', 'LLM_VERIFY_SYSTEM',
      'check', 'extractClaims', 'fuzzyGround', 'llmVerify',
    ]);
  });
});
