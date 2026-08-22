'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  FLASH,
  PRO,
  isNativeDeepSeekClient,
  isOpenRouterClient,
  resolveNativeDeepSeekModel,
  canCallNativeDeepSeek,
  proFallbackModel,
} = require('./native-llm');

describe('native-llm', () => {
  it('maps DeepSeek Flash slugs to the native flash id', () => {
    assert.equal(resolveNativeDeepSeekModel('deepseek-v4-flash'), FLASH);
    assert.equal(resolveNativeDeepSeekModel('deepseek/deepseek-v4-flash'), FLASH);
  });

  it('maps DeepSeek Pro slugs to the native pro id', () => {
    assert.equal(resolveNativeDeepSeekModel('deepseek-v4-pro'), PRO);
    assert.equal(resolveNativeDeepSeekModel('deepseek/deepseek-v4-pro'), PRO);
  });

  it('never treats an OpenRouter client as native DeepSeek', () => {
    const or = { baseURL: 'https://openrouter.ai/api/v1' };
    assert.equal(isOpenRouterClient(or), true);
    assert.equal(isNativeDeepSeekClient(or), false);
    assert.equal(canCallNativeDeepSeek({ client: or, env: {} }), false);
    assert.equal(canCallNativeDeepSeek({
      client: or,
      env: { DEEPSEEK_API_KEY: 'sk-test-real-looking' },
    }), true);
  });

  it('falls back only to native DeepSeek Pro', () => {
    assert.equal(proFallbackModel(FLASH), PRO);
    assert.equal(proFallbackModel(PRO), null);
  });
});
