const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const router = require('../src/routes/agent-batch');
const { resolveBatchModel, FLASH, PRO, FALLBACK_MODELS } = router.INTERNAL;

describe('agent-batch model tiering', () => {
  test('FLASH/PRO constants point at DeepSeek tiers', () => {
    assert.match(FLASH, /deepseek-v4-flash/);
    assert.match(PRO, /deepseek-v4-pro/);
  });

  test('empty/undefined model resolves to FLASH (cheap default)', () => {
    assert.equal(resolveBatchModel(undefined), FLASH);
    assert.equal(resolveBatchModel(''), FLASH);
    assert.equal(resolveBatchModel(null), FLASH);
  });

  test('deepseek ids resolve to the right tier', () => {
    assert.equal(resolveBatchModel('deepseek-v4-pro'), PRO);
    assert.equal(resolveBatchModel('DeepSeek-V4-Pro'), PRO);
    assert.equal(resolveBatchModel('openrouter/deepseek/deepseek-reasoner'), PRO);
    assert.equal(resolveBatchModel('deepseek-v4-flash'), FLASH);
    assert.equal(resolveBatchModel('deepseek/deepseek-chat'), FLASH);
    // Bare unknown ids fail-closed to the cheap FLASH tier (drift posture).
    assert.equal(resolveBatchModel('gibberish'), FLASH);
  });

  test('non-DeepSeek models are rejected with model_forbidden by default', () => {
    for (const raw of ['gpt-4o', 'claude-sonnet-4-20250514', 'openai/gpt-5.5', 'gemini-2.5-flash']) {
      assert.throws(() => resolveBatchModel(raw), (err) => {
        assert.equal(err.code, 'model_forbidden');
        assert.equal(err.status, 400);
        return true;
      });
    }
  });
});

// The escape-hatch env is read at module load; use a subprocess-style reload
// instead of mutating the already-loaded module above.
describe('agent-batch escape hatch (fresh module load)', () => {
  const path = require('path');
  const { pathToFileURL } = require('url');

  function freshLoad() {
    delete require.cache[require.resolve('../src/routes/agent-batch')];
    return require('../src/routes/agent-batch').INTERNAL;
  }

  test('allowlisted fallback model passes through untouched', () => {
    process.env.AGENT_BATCH_FALLBACK_MODELS = 'gpt-4o, claude-sonnet-4';
    const mod = freshLoad();
    assert.deepEqual(mod.FALLBACK_MODELS, ['gpt-4o', 'claude-sonnet-4']);
    assert.equal(mod.resolveBatchModel('gpt-4o'), 'gpt-4o');
    assert.equal(mod.resolveBatchModel('Claude-Sonnet-4'), 'claude-sonnet-4');
    // Non-listed non-DeepSeek ids still rejected.
    assert.throws(() => mod.resolveBatchModel('gemini-2.5-flash'), /model_forbidden|forbidden/i);
    delete process.env.AGENT_BATCH_FALLBACK_MODELS;
  });

  test('no env configured → empty allowlist → absolute rejection stays', () => {
    delete process.env.AGENT_BATCH_FALLBACK_MODELS;
    const mod = freshLoad();
    assert.deepEqual(mod.FALLBACK_MODELS, []);
    assert.throws(() => mod.resolveBatchModel('gpt-4o'), (err) => err.code === 'model_forbidden');
  });

  test('INTERNAL exposes resolveBatchModel for tests', () => {
    const mod = freshLoad();
    assert.equal(typeof mod.resolveBatchModel, 'function');
    assert.equal(mod.resolveBatchModel('deepseek-v4-pro'), 'deepseek-v4-pro');
    assert.equal(mod.resolveBatchModel(undefined), mod.FLASH);
  });
});
