import test from 'node:test';
import assert from 'node:assert/strict';

const aiService = require(`${process.cwd()}/backend/src/services/ai-service`);

test('routes image turns away from text-only DeepSeek models', () => {
  assert.equal(aiService.__test.modelSupportsVision('DeepSeek', 'deepseek-v4-flash'), false);

  const previousOpenAIKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  try {
    const runtime = aiService.__test.selectVisionRuntime('DeepSeek', 'deepseek-v4-flash');
    assert.equal(runtime.provider, 'OpenAI');
    assert.equal(runtime.model, process.env.VISION_MODEL || 'gpt-4o-mini');
    assert.equal(runtime.switched, true);
  } finally {
    if (previousOpenAIKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAIKey;
    }
  }
});

test('keeps a known OpenAI vision model on the selected runtime', () => {
  const runtime = aiService.__test.selectVisionRuntime('OpenAI', 'gpt-4o-mini');

  assert.equal(runtime.provider, 'OpenAI');
  assert.equal(runtime.model, 'gpt-4o-mini');
  assert.equal(runtime.switched, false);
});

test('routes Anthropic chat selections through the OpenRouter transport', () => {
  assert.equal(aiService.__test.normalizeChatProvider('Anthropic', 'claude-sonnet-4.5'), 'OpenRouter');
  assert.equal(aiService.__test.providerForModel('claude-sonnet-4.5'), 'OpenRouter');
  assert.equal(
    aiService.__test.normalizeModelForProvider('OpenRouter', 'claude-sonnet-4.5'),
    'anthropic/claude-sonnet-4.5',
  );
  assert.equal(
    aiService.__test.normalizeModelForProvider('OpenRouter', 'anthropic/claude-3.5-sonnet'),
    'anthropic/claude-3.5-sonnet',
  );
});
