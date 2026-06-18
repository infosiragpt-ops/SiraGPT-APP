const test = require('node:test');
const assert = require('node:assert/strict');

const directAnswerNormalizer = require('../src/services/direct-answer-normalizer');

test('normalizes French language name to Spanish when explicitly requested', () => {
  const normalized = directAnswerNormalizer.normalizeDirectAnswer({
    prompt: "¿En qué idioma está 'Bonjour le monde'? Responde el idioma en español.",
    response: 'francais',
  });

  assert.equal(normalized, 'frances');
});

test('does not replace when direct language answer is already Spanish', () => {
  const normalized = directAnswerNormalizer.normalizeDirectAnswer({
    prompt: "¿En qué idioma está 'Bonjour le monde'? Responde el idioma en español.",
    response: 'frances',
  });

  assert.equal(normalized, '');
});
