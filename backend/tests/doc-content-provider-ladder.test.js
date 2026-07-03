'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { resolveContentClient, hasAnyContentKey } = require('../src/services/document-pipeline/content/llm-client');

test('ladder picks Cerebras (gpt-oss-120b) when only CEREBRAS_API_KEY is live', () => {
  const env = { CEREBRAS_API_KEY: 'k', FREE_IA_MODEL_ID: 'gpt-oss-120b' };
  const r = resolveContentClient({ env });
  assert.equal(r.provider, 'Cerebras');
  assert.equal(r.model, 'gpt-oss-120b');
  assert.ok(r.client);
});

test('ladder falls through a DEAD OpenAI key to the next live provider', () => {
  // OpenAI present but no live check — the ladder order is Cerebras first, so
  // when both exist Cerebras wins; when only OpenRouter+OpenAI exist, OpenRouter wins.
  const env = { OPENROUTER_API_KEY: 'or', OPENAI_API_KEY: 'oai-dead' };
  const r = resolveContentClient({ env });
  assert.equal(r.provider, 'OpenRouter');
  assert.equal(r.model, 'openai/gpt-4o-mini');
});

test('OpenAI is used only when it is the sole configured provider', () => {
  const r = resolveContentClient({ env: { OPENAI_API_KEY: 'oai' } });
  assert.equal(r.provider, 'OpenAI');
});

test('DOC_CONTENT_PROVIDER forces the head of the ladder when its key exists', () => {
  const env = { CEREBRAS_API_KEY: 'c', OPENROUTER_API_KEY: 'or', DOC_CONTENT_PROVIDER: 'OpenRouter' };
  assert.equal(resolveContentClient({ env }).provider, 'OpenRouter');
});

test('returns null when NO provider key is configured (degraded/fallback mode)', () => {
  assert.equal(resolveContentClient({ env: {} }), null);
  assert.equal(hasAnyContentKey({}), false);
  assert.equal(hasAnyContentKey({ CEREBRAS_API_KEY: 'k' }), true);
});

test('per-deployment model overrides are honoured', () => {
  const env = { CEREBRAS_API_KEY: 'c', DOC_CONTENT_CEREBRAS_MODEL: 'zai-glm-4.7' };
  assert.equal(resolveContentClient({ env }).model, 'zai-glm-4.7');
});
