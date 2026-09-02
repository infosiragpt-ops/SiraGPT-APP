import test from 'node:test';
import assert from 'node:assert/strict';

const aiService = require(`${process.cwd()}/backend/src/services/ai-service`);

const VISION_ENV_KEYS = [
  'OPENAI_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY',
  'MODEL_API_KEY', 'META_API_KEY', 'LLAMA_API_KEY', 'VISION_MODEL', 'GEMINI_VISION_MODEL',
];

function withVisionEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of VISION_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of VISION_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('routes image turns away from text-only DeepSeek models', () => {
  assert.equal(aiService.__test.modelSupportsVision('DeepSeek', 'deepseek-v4-flash'), false);

  // Gemini is the preferred detour; OpenAI is the last resort (its key was
  // answering 401 in production while the retired gpt-4o-mini id 404'd).
  withVisionEnv({ GEMINI_API_KEY: 'g-test', OPENAI_API_KEY: 'test-key' }, () => {
    const runtime = aiService.__test.selectVisionRuntime('DeepSeek', 'deepseek-v4-flash');
    assert.equal(runtime.provider, 'Gemini');
    assert.equal(runtime.model, 'gemini-3.5-flash');
    assert.equal(runtime.switched, true);
    assert.deepEqual(runtime.fallbacks, [{ provider: 'OpenAI', model: 'gpt-5.6-sol' }]);
  });
  withVisionEnv({ OPENAI_API_KEY: 'test-key', VISION_MODEL: 'gpt-4o' }, () => {
    const runtime = aiService.__test.selectVisionRuntime('DeepSeek', 'deepseek-v4-flash');
    assert.equal(runtime.provider, 'OpenAI');
    assert.equal(runtime.model, 'gpt-4o');
    assert.equal(runtime.switched, true);
  });
});

test('multimodal first-party models keep their image turns (Muse Spark, Grok 4.x)', () => {
  assert.equal(aiService.__test.modelSupportsVision('Meta', 'muse-spark-1.2-contributor'), true);
  assert.equal(aiService.__test.modelSupportsVision('xAI', 'grok-4.5'), true);
  const runtime = aiService.__test.selectVisionRuntime('Meta', 'muse-spark-1.2-contributor');
  assert.equal(runtime.switched, false);
  assert.equal(runtime.model, 'muse-spark-1.2-contributor');
});

test('keeps a known OpenAI vision model on the selected runtime', () => {
  const runtime = aiService.__test.selectVisionRuntime('OpenAI', 'gpt-4o-mini');

  assert.equal(runtime.provider, 'OpenAI');
  assert.equal(runtime.model, 'gpt-4o-mini');
  assert.equal(runtime.switched, false);
});

test('routes Anthropic chat selections through the native Anthropic API', () => {
  assert.equal(aiService.__test.normalizeChatProvider('Anthropic', 'claude-sonnet-4.5'), 'Anthropic');
  assert.equal(aiService.__test.providerForModel('claude-sonnet-4.5'), 'Anthropic');
  assert.equal(
    aiService.__test.normalizeModelForProvider('Anthropic', 'anthropic/claude-sonnet-4.5'),
    'claude-sonnet-4.5',
  );
  assert.equal(
    aiService.__test.normalizeModelForProvider('OpenRouter', 'anthropic/claude-3.5-sonnet'),
    'anthropic/claude-3.5-sonnet',
  );
});
