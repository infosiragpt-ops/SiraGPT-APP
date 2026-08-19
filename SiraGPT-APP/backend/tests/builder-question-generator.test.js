'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { generateNextQuestion, coerceCard, summariseAnswers } = require('../src/services/builder/question-generator');
const { questionForDimension } = require('../src/services/builder/questions');
const { QuestionCardSchema } = require('../src/services/builder/contracts');

const noLlm = { isLlmAvailable: () => false };
const fakeLlm = (json) => ({ isLlmAvailable: () => true, completeJson: async () => json });

test('falls back to the static bank when no LLM is available', async () => {
  const card = await generateNextQuestion({ answers: {} }, 'purpose', { llm: noLlm });
  assert.deepEqual(card, questionForDimension('purpose'));
})

test('returns a dynamic, contextual card when the LLM yields a valid one', async () => {
  const llm = fakeLlm({
    id: 'q-x', dimension: 'platform',
    prompt: 'Mencionaste una tienda — ¿dónde la usarán tus clientes?',
    type: 'chips', options: ['web', 'mobile', 'desktop'], allowFreeText: false,
  });
  const card = await generateNextQuestion({ answers: { purpose: 'una tienda' } }, 'platform', { llm });
  assert.equal(card.dimension, 'platform');
  assert.match(card.prompt, /tienda|usar/i);
  assert.ok(card.options.includes('desktop'));
  assert.equal(QuestionCardSchema.safeParse(card).success, true);
});

test('forces the target dimension even if the LLM returns another', async () => {
  const llm = fakeLlm({ prompt: '¿Qué estilo?', dimension: 'purpose', type: 'chips', options: ['moderno'], allowFreeText: true });
  const card = await generateNextQuestion({ answers: {} }, 'style', { llm });
  assert.equal(card.dimension, 'style');
});

test('falls back when the LLM returns nothing parseable', async () => {
  const card = await generateNextQuestion({ answers: {} }, 'audience', { llm: fakeLlm(null) });
  assert.deepEqual(card, questionForDimension('audience'));
});

test('falls back when the LLM throws', async () => {
  const llm = { isLlmAvailable: () => true, completeJson: async () => { throw new Error('x'); } };
  const card = await generateNextQuestion({ answers: {} }, 'coreFeatures', { llm });
  assert.deepEqual(card, questionForDimension('coreFeatures'));
});

test('coerceCard: invalid type → fallback type; missing prompt → null', () => {
  const coerced = coerceCard({ prompt: 'hola', type: 'radio', options: ['a'] }, 'style');
  assert.equal(coerced.type, questionForDimension('style').type);
  assert.equal(coerceCard({ type: 'text' }, 'purpose'), null);
});

test('summariseAnswers compiles a readable context block', () => {
  const text = summariseAnswers({ answers: { purpose: 'vender', coreFeatures: ['pagos', 'chat'] } });
  assert.match(text, /purpose: vender/);
  assert.match(text, /coreFeatures: pagos, chat/);
  assert.equal(summariseAnswers({ answers: {} }), '(aún sin respuestas)');
});

test('unknown dimension rejects', async () => {
  await assert.rejects(() => generateNextQuestion({ answers: {} }, 'budget', { llm: noLlm }), /unknown dimension/);
});
