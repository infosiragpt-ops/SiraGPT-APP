'use strict';

/**
 * password-strength — light zxcvbn-style estimator. Pairs with the
 * scrypt password-hash module (#79): we hash regardless of strength,
 * but a UI can refuse weak inputs up-front. No dictionary lookups —
 * we cover the obvious failure modes (length, single class, common
 * words, sequences, repeats) and leave linguistic heuristics to a
 * dedicated library when needed.
 *
 * score: 0 = trivial, 1 = weak, 2 = fair, 3 = strong, 4 = excellent.
 *
 * Public API:
 *   estimate(password)
 *     → { score, entropyBits, classes, issues, suggestions }
 *   classify(password)            → integer score
 *   COMMON_WEAK                   → exported set of weakest passwords
 */

const COMMON_WEAK = new Set([
  '123456', '12345678', '123456789', 'qwerty', 'password', '111111',
  '1234567', 'abc123', 'password1', 'iloveyou', 'admin', 'welcome',
  'monkey', '1q2w3e4r', 'letmein', 'football', 'baseball', 'starwars',
  'siragpt', 'sira',
]);

const SEQUENCES = ['abcdefghijklmnopqrstuvwxyz', '0123456789', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

function classBits(text) {
  let pool = 0;
  if (/[a-z]/.test(text)) pool += 26;
  if (/[A-Z]/.test(text)) pool += 26;
  if (/\d/.test(text)) pool += 10;
  if (/[^A-Za-z0-9]/.test(text)) pool += 33; // common symbol set
  return pool;
}

function classesPresent(text) {
  return {
    lower: /[a-z]/.test(text),
    upper: /[A-Z]/.test(text),
    digit: /\d/.test(text),
    symbol: /[^A-Za-z0-9]/.test(text),
  };
}

function hasRepeats(text) {
  return /(.)\1{2,}/.test(text);
}

function hasSequence(text, len = 4) {
  const lower = text.toLowerCase();
  for (const seq of SEQUENCES) {
    for (let i = 0; i + len <= seq.length; i++) {
      if (lower.includes(seq.slice(i, i + len))) return true;
      // Reverse direction.
      const rev = seq.slice(i, i + len).split('').reverse().join('');
      if (lower.includes(rev)) return true;
    }
  }
  return false;
}

function isCommon(text) {
  return COMMON_WEAK.has(String(text).toLowerCase());
}

function entropyBitsOf(text) {
  if (!text) return 0;
  const pool = classBits(text);
  if (pool === 0) return 0;
  return text.length * Math.log2(pool);
}

function estimate(password) {
  const text = typeof password === 'string' ? password : '';
  const issues = [];
  const suggestions = [];
  const classes = classesPresent(text);

  if (!text) {
    return { score: 0, entropyBits: 0, classes, issues: ['empty'], suggestions: ['use a non-empty password'] };
  }
  if (isCommon(text)) {
    issues.push('common_password');
    suggestions.push('avoid passwords from leaked-credential lists');
  }
  if (text.length < 8) { issues.push('too_short'); suggestions.push('use ≥ 12 characters'); }
  if (hasRepeats(text)) { issues.push('repeating_chars'); suggestions.push('avoid runs like "aaaa"'); }
  if (hasSequence(text)) { issues.push('keyboard_or_alpha_sequence'); suggestions.push('avoid "abcd", "1234", "qwerty"'); }
  const classCount = Object.values(classes).filter(Boolean).length;
  if (classCount < 2) { issues.push('single_character_class'); suggestions.push('mix lowercase, uppercase, digits, symbols'); }

  const entropy = entropyBitsOf(text);
  let score;
  if (issues.includes('common_password') || entropy < 25) score = 0;
  else if (entropy < 50) score = 1;
  else if (entropy < 75) score = 2;
  else if (entropy < 100) score = 3;
  else score = 4;
  // Cap at 2 if there are pattern issues even on long passwords.
  if (score > 2 && (issues.includes('repeating_chars') || issues.includes('keyboard_or_alpha_sequence'))) {
    score = 2;
  }

  return { score, entropyBits: Math.round(entropy * 10) / 10, classes, issues, suggestions };
}

function classify(password) {
  return estimate(password).score;
}

module.exports = {
  estimate,
  classify,
  COMMON_WEAK,
  SEQUENCES,
};
