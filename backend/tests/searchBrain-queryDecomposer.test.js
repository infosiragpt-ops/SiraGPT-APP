/**
 * Tests for services/searchBrain/queryDecomposer.js — Phase 1 of WebGLM:
 * raw query → 3-5 bilingual sub-queries.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  decomposeQuery,
  DECOMPOSER_SYSTEM,
  INTERNAL,
} = require('../src/services/searchBrain/queryDecomposer');

// ── DECOMPOSER_SYSTEM ──────────────────────────────────────────

describe('DECOMPOSER_SYSTEM', () => {
  it('describes the STRICT JSON output format', () => {
    assert.match(DECOMPOSER_SYSTEM, /STRICT JSON/);
    assert.match(DECOMPOSER_SYSTEM, /"subqueries"/);
    assert.match(DECOMPOSER_SYSTEM, /"language"/);
    assert.match(DECOMPOSER_SYSTEM, /"rationale"/);
  });

  it('mentions bilingual ES + EN coverage', () => {
    assert.match(DECOMPOSER_SYSTEM, /at least one of each/);
  });

  it('specifies 3-5 sub-queries range', () => {
    assert.match(DECOMPOSER_SYSTEM, /3 to 5 sub-queries/);
  });

  it('keeps named entities intact', () => {
    assert.match(DECOMPOSER_SYSTEM, /Keep named entities.*intact/);
  });
});

// ── INTERNAL.parseJson ─────────────────────────────────────────

describe('INTERNAL.parseJson', () => {
  it('returns null for non-string input', () => {
    assert.equal(INTERNAL.parseJson(null), null);
    assert.equal(INTERNAL.parseJson(undefined), null);
    assert.equal(INTERNAL.parseJson(42), null);
  });

  it('parses bare JSON', () => {
    assert.deepEqual(INTERNAL.parseJson('{"a":1}'), { a: 1 });
  });

  it('strips ```json fences', () => {
    assert.deepEqual(INTERNAL.parseJson('```json\n{"a":2}\n```'), { a: 2 });
  });

  it('strips bare ``` fences', () => {
    assert.deepEqual(INTERNAL.parseJson('```\n{"a":3}\n```'), { a: 3 });
  });

  it('handles leading/trailing whitespace', () => {
    assert.deepEqual(INTERNAL.parseJson('   {"x":1}   '), { x: 1 });
  });

  it('returns null on malformed JSON', () => {
    assert.equal(INTERNAL.parseJson('not json {'), null);
  });
});

// ── INTERNAL.detectLanguage ────────────────────────────────────

describe('INTERNAL.detectLanguage', () => {
  it('returns hint "es" or "en" verbatim', () => {
    assert.equal(INTERNAL.detectLanguage('hello', 'es'), 'es');
    assert.equal(INTERNAL.detectLanguage('hola', 'en'), 'en');
  });

  it('detects Spanish from accents/ñ/¿/¡', () => {
    assert.equal(INTERNAL.detectLanguage('¿cómo está?'), 'es');
    assert.equal(INTERNAL.detectLanguage('niño con mañana'), 'es');
    assert.equal(INTERNAL.detectLanguage('¡buenas tardes!'), 'es');
  });

  it('defaults to "en" when no Spanish markers and no hint', () => {
    assert.equal(INTERNAL.detectLanguage('how are you'), 'en');
    assert.equal(INTERNAL.detectLanguage('quick brown fox'), 'en');
  });

  it('ignores invalid hint values', () => {
    assert.equal(INTERNAL.detectLanguage('how are you', 'auto'), 'en');
    assert.equal(INTERNAL.detectLanguage('cómo estás', 'fr'), 'es');
  });
});

// ── INTERNAL.validateSubqueries ────────────────────────────────

describe('INTERNAL.validateSubqueries', () => {
  it('returns [] for null/missing subqueries field', () => {
    assert.deepEqual(INTERNAL.validateSubqueries(null), []);
    assert.deepEqual(INTERNAL.validateSubqueries({}), []);
  });

  it('returns [] for non-array subqueries', () => {
    assert.deepEqual(INTERNAL.validateSubqueries({ subqueries: 'not-array' }), []);
  });

  it('keeps valid es + en entries', () => {
    const out = INTERNAL.validateSubqueries({
      subqueries: [
        { text: 'machine learning', language: 'en', rationale: 'broad' },
        { text: 'aprendizaje automático', language: 'es' },
      ],
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].language, 'en');
    assert.equal(out[1].language, 'es');
  });

  it('drops entries with missing text', () => {
    const out = INTERNAL.validateSubqueries({
      subqueries: [
        { text: 'valid', language: 'en' },
        { language: 'en' },
        { text: '', language: 'en' },
      ],
    });
    assert.equal(out.length, 1);
  });

  it('drops entries with invalid language', () => {
    const out = INTERNAL.validateSubqueries({
      subqueries: [
        { text: 'valid', language: 'en' },
        { text: 'invalid', language: 'fr' },
        { text: 'no-lang', language: null },
      ],
    });
    assert.equal(out.length, 1);
  });

  it('drops null/non-object entries', () => {
    const out = INTERNAL.validateSubqueries({
      subqueries: [
        { text: 'ok', language: 'en' },
        null,
        'not-object',
      ],
    });
    assert.equal(out.length, 1);
  });

  it('trims whitespace from text', () => {
    const out = INTERNAL.validateSubqueries({
      subqueries: [{ text: '  trimmed  ', language: 'en' }],
    });
    assert.equal(out[0].text, 'trimmed');
  });

  it('truncates rationale to 200 chars', () => {
    const out = INTERNAL.validateSubqueries({
      subqueries: [{ text: 'ok', language: 'en', rationale: 'r'.repeat(500) }],
    });
    assert.equal(out[0].rationale.length, 200);
  });

  it('omits rationale field when not a string', () => {
    const out = INTERNAL.validateSubqueries({
      subqueries: [{ text: 'ok', language: 'en', rationale: 42 }],
    });
    assert.equal(out[0].rationale, undefined);
  });

  it('caps to 6 entries (internal validation limit)', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ text: `q${i}`, language: 'en' }));
    const out = INTERNAL.validateSubqueries({ subqueries: many });
    assert.equal(out.length, 6);
  });
});

// ── decomposeQuery ──────────────────────────────────────────────

describe('decomposeQuery · primitives', () => {
  it('returns [] for empty query', async () => {
    assert.deepEqual(await decomposeQuery({ query: '' }), []);
    assert.deepEqual(await decomposeQuery({ query: '   ' }), []);
    assert.deepEqual(await decomposeQuery({ query: null }), []);
  });

  it('returns single-item fallback when callLLM not provided', async () => {
    const out = await decomposeQuery({ query: 'how to sort arrays' });
    assert.equal(out.length, 1);
    assert.equal(out[0].text, 'how to sort arrays');
    assert.equal(out[0].language, 'en');
  });

  it('language hint propagates to fallback', async () => {
    const out = await decomposeQuery({ query: 'pregunta', language: 'es' });
    assert.equal(out[0].language, 'es');
  });

  it('auto-detects Spanish in fallback when no hint', async () => {
    const out = await decomposeQuery({ query: '¿cómo está esto?' });
    assert.equal(out[0].language, 'es');
  });
});

describe('decomposeQuery · LLM path', () => {
  it('uses LLM-returned subqueries when valid', async () => {
    const callLLM = async () => ({
      content: JSON.stringify({
        subqueries: [
          { text: 'machine learning algorithms', language: 'en' },
          { text: 'algoritmos de aprendizaje', language: 'es' },
          { text: 'neural network training', language: 'en' },
        ],
      }),
    });
    const out = await decomposeQuery({ query: 'ML', callLLM });
    assert.equal(out.length, 3);
    assert.equal(out[0].text, 'machine learning algorithms');
  });

  it('caps to maxSubQueries (default 5)', async () => {
    const callLLM = async () => ({
      content: JSON.stringify({
        subqueries: Array.from({ length: 10 }, (_, i) => ({
          text: `q${i}`, language: i % 2 === 0 ? 'en' : 'es',
        })),
      }),
    });
    const out = await decomposeQuery({ query: 'x', callLLM });
    assert.equal(out.length, 5);
  });

  it('honours custom maxSubQueries', async () => {
    const callLLM = async () => ({
      content: JSON.stringify({
        subqueries: Array.from({ length: 6 }, (_, i) => ({
          text: `q${i}`, language: 'en',
        })),
      }),
    });
    const out = await decomposeQuery({ query: 'x', callLLM, maxSubQueries: 3 });
    assert.equal(out.length, 3);
  });

  it('falls back to single-item when LLM returns empty subqueries', async () => {
    const callLLM = async () => ({
      content: JSON.stringify({ subqueries: [] }),
    });
    const out = await decomposeQuery({ query: 'fallback test', callLLM });
    assert.equal(out.length, 1);
    assert.equal(out[0].text, 'fallback test');
  });

  it('falls back when LLM returns malformed JSON', async () => {
    const callLLM = async () => ({ content: 'not json' });
    const out = await decomposeQuery({ query: 'q', callLLM });
    assert.equal(out.length, 1);
    assert.equal(out[0].text, 'q');
  });

  it('falls back when callLLM throws', async () => {
    const callLLM = async () => { throw new Error('llm down'); };
    const out = await decomposeQuery({ query: 'q', callLLM });
    assert.equal(out.length, 1);
    assert.equal(out[0].text, 'q');
  });

  it('truncates query to 1500 chars in the LLM user message', async () => {
    let captured;
    const callLLM = async (args) => {
      captured = args;
      return { content: JSON.stringify({ subqueries: [{ text: 'r', language: 'en' }] }) };
    };
    const longQuery = 'q'.repeat(5000);
    await decomposeQuery({ query: longQuery, callLLM });
    // The query portion in user message capped at 1500 chars.
    const userMsg = captured.user;
    assert.match(userMsg, /ORIGINAL QUERY/);
    const qPortion = userMsg.match(/ORIGINAL QUERY:\n(.+)\n\nProduce/s)[1];
    assert.ok(qPortion.length <= 1500);
  });

  it('sends temperature=0.2 + maxTokens=500', async () => {
    let captured;
    const callLLM = async (args) => {
      captured = args;
      return { content: JSON.stringify({ subqueries: [{ text: 'r', language: 'en' }] }) };
    };
    await decomposeQuery({ query: 'q', callLLM });
    assert.equal(captured.temperature, 0.2);
    assert.equal(captured.maxTokens, 500);
  });

  it('uses DECOMPOSER_SYSTEM as system prompt', async () => {
    let captured;
    const callLLM = async (args) => {
      captured = args;
      return { content: JSON.stringify({ subqueries: [{ text: 'r', language: 'en' }] }) };
    };
    await decomposeQuery({ query: 'q', callLLM });
    assert.equal(captured.system, DECOMPOSER_SYSTEM);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/searchBrain/queryDecomposer');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['DECOMPOSER_SYSTEM', 'INTERNAL', 'decomposeQuery']);
  });
});
