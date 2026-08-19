'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { estimate, classify, COMMON_WEAK } = require('../src/services/auth/password-strength');

describe('estimate — score buckets', () => {
  test('empty / null → 0 + empty issue', () => {
    const r = estimate('');
    assert.equal(r.score, 0);
    assert.deepEqual(r.issues, ['empty']);
  });

  test('common password → score 0', () => {
    const r = estimate('123456');
    assert.equal(r.score, 0);
    assert.ok(r.issues.includes('common_password'));
  });

  test('short single-class → score ≤ 1', () => {
    const r = estimate('abcde');
    assert.ok(r.score <= 1);
    assert.ok(r.issues.includes('too_short') || r.issues.includes('single_character_class'));
  });

  test('long random-ish multi-class → score 3 or 4', () => {
    const r = estimate('Tr0ub4dor&3xampl3-Pa55');
    assert.ok(r.score >= 3, `score=${r.score} entropy=${r.entropyBits}`);
  });

  test('keyboard sequence caps score at 2', () => {
    // Long but with 'qwerty' inside.
    const r = estimate('qwerty1234567890ABCDEFGHIJK');
    assert.ok(r.score <= 2, `score=${r.score}`);
    assert.ok(r.issues.includes('keyboard_or_alpha_sequence'));
  });

  test('repeating chars caps score at 2', () => {
    const r = estimate('AAAAAAAAAA111111$$$$$');
    assert.ok(r.score <= 2);
    assert.ok(r.issues.includes('repeating_chars'));
  });
});

describe('classes detection', () => {
  test('all four classes detected', () => {
    const r = estimate('Aa1!Aa1!');
    assert.equal(r.classes.lower, true);
    assert.equal(r.classes.upper, true);
    assert.equal(r.classes.digit, true);
    assert.equal(r.classes.symbol, true);
  });

  test('single-class flagged', () => {
    const r = estimate('abcdefghijkl');
    assert.ok(r.issues.includes('single_character_class'));
  });
});

describe('entropy', () => {
  test('grows with length', () => {
    const a = estimate('Aa1!Aa').entropyBits;
    const b = estimate('Aa1!Aa1!Aa1!Aa1!').entropyBits;
    assert.ok(b > a);
  });

  test('higher pool → higher entropy at same length', () => {
    const lowerOnly = estimate('abcdefghijkl').entropyBits;
    const mixed = estimate('Aa1!Bb2@Cc3#').entropyBits;
    assert.ok(mixed > lowerOnly);
  });
});

describe('classify', () => {
  test('returns same score as estimate', () => {
    assert.equal(classify('Tr0ub4dor&3'), estimate('Tr0ub4dor&3').score);
  });
});

describe('COMMON_WEAK export', () => {
  test('contains the obvious classics', () => {
    for (const w of ['password', '123456', 'qwerty', 'admin']) {
      assert.equal(COMMON_WEAK.has(w), true);
    }
  });
});

describe('non-string input', () => {
  test('null / number → score 0', () => {
    assert.equal(estimate(null).score, 0);
    assert.equal(estimate(42).score, 0);
  });
});

describe('suggestions are actionable', () => {
  test('weak password gets suggestions', () => {
    const r = estimate('abc');
    assert.ok(r.suggestions.length >= 1);
  });
});
