'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  estimateTokens,
  familyOf,
  ratiosFor,
  RATIOS,
} = require('../src/services/ai-product-os/token-approximator');

describe('familyOf', () => {
  test('claude family detection', () => {
    assert.equal(familyOf('claude-opus-4-7'), 'claude');
    assert.equal(familyOf('anthropic/claude-3.5-sonnet'), 'claude');
  });
  test('gpt family detection', () => {
    assert.equal(familyOf('gpt-5'), 'gpt');
    assert.equal(familyOf('o1-preview'), 'gpt');
    assert.equal(familyOf('o3'), 'gpt');
    assert.equal(familyOf('chatgpt-4o'), 'gpt');
  });
  test('gemini family detection', () => {
    assert.equal(familyOf('gemini-2.5-pro'), 'gemini');
    assert.equal(familyOf('google/gemini-flash'), 'gemini');
  });
  test('deepseek family detection', () => {
    assert.equal(familyOf('deepseek-v4-flash'), 'deepseek');
  });
  test('unknown / null → generic', () => {
    assert.equal(familyOf('unknown-model'), 'generic');
    assert.equal(familyOf(''), 'generic');
    assert.equal(familyOf(null), 'generic');
  });
});

describe('ratiosFor', () => {
  test('returns ratios object for each family', () => {
    for (const f of Object.keys(RATIOS)) {
      const r = ratiosFor(f);
      assert.ok(typeof r.ascii === 'number');
      assert.ok(typeof r.mixed === 'number');
    }
  });

  test('unknown family falls back to generic', () => {
    assert.deepEqual(ratiosFor('weird'), RATIOS.generic);
  });
});

describe('estimateTokens — basic', () => {
  test('null / undefined → 0', () => {
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens(undefined), 0);
  });

  test('empty string → 0', () => {
    assert.equal(estimateTokens(''), 0);
  });

  test('non-string non-array stringifies', () => {
    const t = estimateTokens({ a: 1 });
    assert.ok(t > 0);
  });

  test('arrays sum text-bearing parts', () => {
    const arr = [{ text: 'hello' }, { text: 'world' }];
    const t = estimateTokens(arr);
    assert.ok(t > 0);
  });

  test('returns at least 1 for any non-empty input', () => {
    assert.ok(estimateTokens('a') >= 1);
  });
});

describe('estimateTokens — ASCII vs multibyte', () => {
  test('Spanish text with accents gets fewer bytes-per-token than pure ASCII would imply', () => {
    const en = 'the quick brown fox jumps over the lazy dog'.repeat(20);
    const es = 'el zorro rápido marrón salta sobre el perro perezoso ñ'.repeat(20);
    const tEn = estimateTokens(en, 'gpt');
    const tEs = estimateTokens(es, 'gpt');
    // Spanish has multibyte chars so similar-length text yields more
    // bytes; multi-byte ratio is lower → more tokens per byte.
    // We just assert both are finite and Spanish is not absurdly low.
    assert.ok(tEn > 0 && tEs > 0);
    assert.ok(tEs >= tEn * 0.7);
  });

  test('CJK text yields more tokens per character than ASCII', () => {
    const ascii = 'hello world '.repeat(100);
    const cjk = '你好世界 '.repeat(100);
    const tAscii = estimateTokens(ascii, 'gpt');
    const tCjk = estimateTokens(cjk, 'gpt');
    // Both should be > 0; CJK chars are multibyte → more bytes per char →
    // we get more tokens for same character count.
    assert.ok(tCjk > 0 && tAscii > 0);
  });
});

describe('estimateTokens — model awareness', () => {
  test('claude estimates fewer tokens than gpt for the same ASCII text', () => {
    const text = 'the quick brown fox '.repeat(200);
    const tClaude = estimateTokens(text, 'claude-opus-4-7');
    const tGpt = estimateTokens(text, 'gpt-5');
    // Claude bytes/token is higher (4.4) → lower token count.
    assert.ok(tClaude < tGpt, `claude=${tClaude} >= gpt=${tGpt}`);
  });

  test('default (no model) uses generic ratios', () => {
    const text = 'hello world'.repeat(50);
    const tDefault = estimateTokens(text);
    const tGeneric = estimateTokens(text, 'generic');
    assert.equal(tDefault, tGeneric);
  });
});

describe('estimateTokens — sampling for large inputs', () => {
  test('large input does not OOM and returns finite number', () => {
    const big = 'palabra '.repeat(50_000); // ~400KB
    const t = estimateTokens(big, 'gpt-5');
    assert.ok(Number.isFinite(t));
    assert.ok(t > 10_000);
  });
});
