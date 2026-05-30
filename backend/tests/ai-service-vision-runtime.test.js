'use strict';

// Regression coverage for image/vision routing.
//
// Bug: the chat route stripped uploaded images before calling
// ai-service.generateStream whenever the *selected* model was not natively
// vision-capable. That defeated selectVisionRuntime() — which can
// transparently route an image turn to a vision model (gpt-4o-mini /
// gemini-2.5-flash / openrouter) when a key exists — so a simple
// "transcribe this image" on the free text model silently dropped the
// image and the model claimed it couldn't see it.
//
// These tests pin the two helpers the fix relies on:
//   * modelSupportsVision(provider, model) — native capability check
//   * selectVisionRuntime(provider, model) — auto-route decision
// and that selectVisionRuntime is exposed on the service instance (the
// route calls aiService.selectVisionRuntime, not the __test bag).

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const service = require('../src/services/ai-service');

const VISION_KEYS = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'VISION_MODEL', 'GEMINI_VISION_MODEL', 'OPENROUTER_VISION_MODEL'];

describe('ai-service vision routing', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = {};
    for (const k of VISION_KEYS) savedEnv[k] = process.env[k];
    for (const k of VISION_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of VISION_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  test('selectVisionRuntime is exposed on the service instance', () => {
    assert.equal(typeof service.selectVisionRuntime, 'function');
    assert.equal(typeof service.modelSupportsVision, 'function');
    assert.equal(typeof service.__test.shouldAttachVisionContent, 'function');
  });

  describe('modelSupportsVision', () => {
    test('recognises native vision models', () => {
      assert.equal(service.modelSupportsVision('OpenAI', 'gpt-4o'), true);
      assert.equal(service.modelSupportsVision('OpenAI', 'gpt-4o-mini'), true);
      assert.equal(service.modelSupportsVision('OpenAI', 'gpt-4.1'), true);
      assert.equal(service.modelSupportsVision('Gemini', 'gemini-2.5-flash'), true);
      assert.equal(service.modelSupportsVision('OpenRouter', 'anthropic/claude-3.5-sonnet'), true);
      assert.equal(service.modelSupportsVision('OpenRouter', 'qwen/qwen2-vl-7b-instruct'), true);
    });

    test('rejects text-only models', () => {
      assert.equal(service.modelSupportsVision('OpenAI', 'gpt-3.5-turbo'), false);
      assert.equal(service.modelSupportsVision('DeepSeek', 'deepseek-chat'), false);
      assert.equal(service.modelSupportsVision('Cerebras', 'llama-3.1-8b'), false);
      assert.equal(service.modelSupportsVision('OpenRouter', 'openai/gpt-oss-120b'), false);
    });
  });

  describe('selectVisionRuntime', () => {
    test('passes a native vision model through unchanged', () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      const rt = service.selectVisionRuntime('OpenAI', 'gpt-4o');
      assert.equal(rt.switched, false);
      assert.equal(rt.provider, 'OpenAI');
      assert.equal(rt.model, 'gpt-4o');
    });

    test('auto-routes a text model to OpenAI gpt-4o-mini when OPENAI key is set', () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      const rt = service.selectVisionRuntime('Cerebras', 'llama-3.1-8b');
      assert.equal(rt.switched, true);
      assert.equal(rt.provider, 'OpenAI');
      assert.equal(rt.model, 'gpt-4o-mini');
    });

    test('honours the VISION_MODEL override', () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      process.env.VISION_MODEL = 'gpt-4o';
      const rt = service.selectVisionRuntime('OpenRouter', 'openai/gpt-oss-120b');
      assert.equal(rt.switched, true);
      assert.equal(rt.provider, 'OpenAI');
      assert.equal(rt.model, 'gpt-4o');
    });

    test('falls back to Gemini when only a Gemini key is present', () => {
      process.env.GEMINI_API_KEY = 'g-test';
      const rt = service.selectVisionRuntime('DeepSeek', 'deepseek-chat');
      assert.equal(rt.switched, true);
      assert.equal(rt.provider, 'Gemini');
      assert.equal(rt.model, 'gemini-2.5-flash');
    });

    test('falls back to OpenRouter when only an OpenRouter key is present', () => {
      process.env.OPENROUTER_API_KEY = 'or-test';
      const rt = service.selectVisionRuntime('DeepSeek', 'deepseek-chat');
      assert.equal(rt.switched, true);
      assert.equal(rt.provider, 'OpenRouter');
      assert.equal(rt.model, 'openai/gpt-4o-mini');
    });

    test('does not switch when no vision-provider key is available', () => {
      const rt = service.selectVisionRuntime('DeepSeek', 'deepseek-chat');
      assert.equal(rt.switched, false);
      assert.equal(rt.provider, 'DeepSeek');
      assert.equal(rt.model, 'deepseek-chat');
    });
  });

  describe('shouldAttachVisionContent', () => {
    test('keeps image payloads for native vision models even without switching', () => {
      const rt = service.selectVisionRuntime('OpenAI', 'gpt-4o');
      assert.equal(rt.switched, false);
      assert.equal(service.__test.shouldAttachVisionContent('OpenAI', 'gpt-4o', rt), true);
    });

    test('keeps image payloads when a text model can be routed to a vision runtime', () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      const rt = service.selectVisionRuntime('DeepSeek', 'deepseek-chat');
      assert.equal(rt.switched, true);
      assert.equal(service.__test.shouldAttachVisionContent('DeepSeek', 'deepseek-chat', rt), true);
    });

    test('does not attach image payloads when there is no native or fallback vision runtime', () => {
      const rt = service.selectVisionRuntime('DeepSeek', 'deepseek-chat');
      assert.equal(rt.switched, false);
      assert.equal(service.__test.shouldAttachVisionContent('DeepSeek', 'deepseek-chat', rt), false);
    });
  });
});
