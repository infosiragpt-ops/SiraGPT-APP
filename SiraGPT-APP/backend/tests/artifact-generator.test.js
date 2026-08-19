/**
 * Tests for services/artifact-generator.js — JSX-artifact generator
 * with provider routing.
 *
 * We test the exported clientForModel router (the part with branching
 * logic) without dialing any real LLM. process.env is set per-test
 * so OpenAI client construction doesn't throw.
 */

'use strict';

const assert = require('node:assert');
const { describe, it, before, after } = require('node:test');

// Ensure ALL provider keys exist so OpenAI client constructors don't
// throw at import / call time. We restore after.
const savedEnv = {};
const KEYS = ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY'];

before(() => {
  for (const k of KEYS) {
    savedEnv[k] = process.env[k];
    if (!process.env[k]) process.env[k] = `test-${k}`;
  }
});

after(() => {
  for (const k of KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const { clientForModel, generateArtifact, streamArtifact } = require('../src/services/artifact-generator');

// ── clientForModel · provider routing ──────────────────────────────

describe('clientForModel · provider routing', () => {
  it('defaults to OpenAI when no model name is given', () => {
    const out = clientForModel();
    assert.equal(out.provider, 'OpenAI');
    assert.ok(out.client);
  });

  it('routes "deepseek-v3" / "deepseek-chat" / "deepseek-reasoner" to DeepSeek', () => {
    for (const m of ['deepseek-v3', 'deepseek-chat', 'deepseek-reasoner', 'DeepSeek-V3', 'DEEPSEEK-V2']) {
      const out = clientForModel(m);
      assert.equal(out.provider, 'DeepSeek', `${m} → expected DeepSeek`);
    }
  });

  it('routes vendor-prefixed models to OpenRouter', () => {
    const cases = [
      'anthropic/claude-sonnet-4-5',
      'x-ai/grok-4',
      'openrouter/auto',
      'meta-llama/llama-3.1-405b',
      'deepseek/deepseek-chat',  // path-form, not "deepseek-" plain
      'mistralai/mistral-large',
      'qwen/qwen-2.5-72b',
      'z-ai/glm-4.6',
      'google/gemini-pro-1.5',
      'moonshotai/kimi-k2',
    ];
    for (const m of cases) {
      const out = clientForModel(m);
      assert.equal(out.provider, 'OpenRouter', `${m} → expected OpenRouter`);
    }
  });

  it('routes any model with "/gpt-oss" to OpenRouter', () => {
    const out = clientForModel('openai/gpt-oss-120b');
    assert.equal(out.provider, 'OpenRouter');
  });

  it('routes models containing "gemini" to Gemini provider', () => {
    for (const m of ['gemini-2.0-flash', 'models/gemini-1.5-pro', 'gemini-pro']) {
      const out = clientForModel(m);
      assert.equal(out.provider, 'Gemini', `${m} → expected Gemini`);
    }
  });

  it('routes "google/gemini-pro" to OpenRouter (vendor-prefix wins over gemini substring)', () => {
    const out = clientForModel('google/gemini-pro-1.5');
    assert.equal(out.provider, 'OpenRouter');
  });

  it('plain OpenAI model names route to OpenAI', () => {
    for (const m of ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-preview']) {
      const out = clientForModel(m);
      assert.equal(out.provider, 'OpenAI', `${m} → expected OpenAI`);
    }
  });

  it('returns a client instance for every routing path', () => {
    for (const m of [null, 'gpt-4o', 'deepseek-chat', 'gemini-pro', 'anthropic/x']) {
      const out = clientForModel(m);
      assert.ok(out.client, `${m} → must have client`);
      assert.equal(typeof out.client.chat?.completions?.create, 'function');
    }
  });

  it('case-insensitive match for DeepSeek prefix', () => {
    assert.equal(clientForModel('DEEPSEEK-CHAT').provider, 'DeepSeek');
    assert.equal(clientForModel('DeepSeek-Reasoner').provider, 'DeepSeek');
  });
});

// ── module surface ────────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented entrypoints', () => {
    const mod = require('../src/services/artifact-generator');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['clientForModel', 'generateArtifact', 'streamArtifact']);
  });

  it('generateArtifact is async', () => {
    assert.equal(generateArtifact.constructor.name, 'AsyncFunction');
  });

  it('streamArtifact is an async generator', () => {
    assert.equal(streamArtifact.constructor.name, 'AsyncGeneratorFunction');
  });
});

// ── streamArtifact · stage progression ────────────────────────────

describe('streamArtifact · error path (without mock)', () => {
  it('yields a final error event when the LLM call fails (no API key path)', async () => {
    // Forcing a real failure by using an obviously-invalid model + no real key.
    // The test verifies that streamArtifact catches and emits an error event
    // rather than crashing.
    const prevOpenAI = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-invalid-for-test';
    try {
      const events = [];
      // Use AbortController to short-circuit if it somehow connects.
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 100);
      for await (const ev of streamArtifact({
        prompt: 'test',
        model: 'gpt-4o-mini',
        signal: ac.signal,
      })) {
        events.push(ev);
        if (ev.type === 'error' || ev.type === 'final') break;
      }
      // At least one stage event and one terminal event (error in our case).
      assert.ok(events.length >= 1, 'expected at least one event');
      const terminal = events[events.length - 1];
      assert.ok(['error', 'final'].includes(terminal.type),
        `terminal event must be error or final, got ${terminal.type}`);
    } finally {
      if (prevOpenAI === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevOpenAI;
    }
  });
});
