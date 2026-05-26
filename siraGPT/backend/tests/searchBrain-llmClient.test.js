/**
 * Tests for services/searchBrain/llmClient.js — OpenRouter-compatible
 * one-shot LLM helper used by the SearchBrain decomposer + reranker.
 *
 * We inject a mock 'openai' module via require-cache so no real HTTP
 * call is made. The module re-instantiates the client when called via
 * getClient(); we use __resetClient() between tests to flush.
 */

'use strict';

const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const { describe, it, before, after, beforeEach } = require('node:test');

const OPENAI_PATH = require.resolve('openai');
const LLM_PATH = require.resolve('../src/services/searchBrain/llmClient');

let lastConstructorOpts = null;
let nextChatResponse = null;
let nextChatThrows = null;

class FakeOpenAI {
  constructor(opts) {
    lastConstructorOpts = opts;
    this.chat = {
      completions: {
        create: async (req) => {
          this.lastRequest = req;
          if (nextChatThrows) throw nextChatThrows;
          return nextChatResponse;
        },
      },
    };
  }
}

let origOpenAICache;
let origLLMCache;

function installMocks() {
  origOpenAICache = require.cache[OPENAI_PATH];
  origLLMCache = require.cache[LLM_PATH];
  const m = new Module(OPENAI_PATH);
  m.filename = OPENAI_PATH;
  m.loaded = true;
  m.exports = FakeOpenAI;
  m.paths = Module._nodeModulePaths(path.dirname(OPENAI_PATH));
  require.cache[OPENAI_PATH] = m;
  delete require.cache[LLM_PATH];
}

function restoreMocks() {
  if (origOpenAICache) require.cache[OPENAI_PATH] = origOpenAICache;
  else delete require.cache[OPENAI_PATH];
  if (origLLMCache) require.cache[LLM_PATH] = origLLMCache;
  else delete require.cache[LLM_PATH];
}

let llm;

before(() => {
  installMocks();
  llm = require('../src/services/searchBrain/llmClient');
});

after(() => {
  restoreMocks();
});

beforeEach(() => {
  llm.__resetClient();
  lastConstructorOpts = null;
  nextChatResponse = null;
  nextChatThrows = null;
});

function setEnv(vars) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

// ── getClient ─────────────────────────────────────────────────────

describe('getClient', () => {
  it('returns null when neither OPENROUTER_API_KEY nor OPENAI_API_KEY is set', () => {
    const restore = setEnv({ OPENROUTER_API_KEY: undefined, OPENAI_API_KEY: undefined });
    try {
      assert.equal(llm.getClient(), null);
    } finally { restore(); }
  });

  it('builds an OpenRouter client when OPENROUTER_API_KEY is set', () => {
    const restore = setEnv({
      OPENROUTER_API_KEY: 'or-test',
      OPENAI_API_KEY: undefined,
      OPENROUTER_REFERER: undefined,
    });
    try {
      const c = llm.getClient();
      assert.ok(c instanceof FakeOpenAI);
      assert.equal(lastConstructorOpts.apiKey, 'or-test');
      assert.equal(lastConstructorOpts.baseURL, 'https://openrouter.ai/api/v1');
      assert.equal(lastConstructorOpts.defaultHeaders['HTTP-Referer'], 'https://siragpt.io');
      assert.equal(lastConstructorOpts.defaultHeaders['X-Title'], 'siraGPT-SearchBrain');
    } finally { restore(); }
  });

  it('honours OPENROUTER_REFERER override', () => {
    const restore = setEnv({
      OPENROUTER_API_KEY: 'or-test',
      OPENROUTER_REFERER: 'https://custom.example',
    });
    try {
      llm.getClient();
      assert.equal(lastConstructorOpts.defaultHeaders['HTTP-Referer'], 'https://custom.example');
    } finally { restore(); }
  });

  it('builds an OpenAI client (no baseURL/headers) when only OPENAI_API_KEY is set', () => {
    const restore = setEnv({
      OPENROUTER_API_KEY: undefined,
      OPENAI_API_KEY: 'sk-test',
    });
    try {
      llm.getClient();
      assert.equal(lastConstructorOpts.apiKey, 'sk-test');
      assert.equal(lastConstructorOpts.baseURL, undefined);
      assert.equal(lastConstructorOpts.defaultHeaders, undefined);
    } finally { restore(); }
  });

  it('OPENROUTER_API_KEY takes precedence over OPENAI_API_KEY', () => {
    const restore = setEnv({
      OPENROUTER_API_KEY: 'or-wins',
      OPENAI_API_KEY: 'oa-loses',
    });
    try {
      llm.getClient();
      assert.equal(lastConstructorOpts.apiKey, 'or-wins');
      assert.equal(lastConstructorOpts.baseURL, 'https://openrouter.ai/api/v1');
    } finally { restore(); }
  });

  it('caches the client — second call returns the same instance', () => {
    const restore = setEnv({ OPENROUTER_API_KEY: 'or-test', OPENAI_API_KEY: undefined });
    try {
      const a = llm.getClient();
      const b = llm.getClient();
      assert.strictEqual(a, b);
    } finally { restore(); }
  });

  it('__resetClient flushes the cache (next getClient rebuilds)', () => {
    const restore = setEnv({ OPENROUTER_API_KEY: 'k1', OPENAI_API_KEY: undefined });
    try {
      const a = llm.getClient();
      llm.__resetClient();
      const b = llm.getClient();
      assert.notStrictEqual(a, b);
    } finally { restore(); }
  });
});

// ── getDefaultModel ───────────────────────────────────────────────

describe('getDefaultModel', () => {
  it('honours SEARCH_BRAIN_MODEL first', () => {
    const restore = setEnv({
      SEARCH_BRAIN_MODEL: 'custom/specific',
      SMALL_MODEL: 'should-not-win',
      OPENROUTER_API_KEY: 'x',
    });
    try {
      assert.equal(llm.getDefaultModel(), 'custom/specific');
    } finally { restore(); }
  });

  it('falls back to SMALL_MODEL when SEARCH_BRAIN_MODEL absent', () => {
    const restore = setEnv({
      SEARCH_BRAIN_MODEL: undefined,
      SMALL_MODEL: 'small-x',
      OPENROUTER_API_KEY: 'x',
    });
    try {
      assert.equal(llm.getDefaultModel(), 'small-x');
    } finally { restore(); }
  });

  it('defaults to moonshotai/kimi-k2.6 when OpenRouter and no overrides', () => {
    const restore = setEnv({
      SEARCH_BRAIN_MODEL: undefined,
      SMALL_MODEL: undefined,
      OPENROUTER_API_KEY: 'x',
    });
    try {
      assert.equal(llm.getDefaultModel(), 'moonshotai/kimi-k2.6');
    } finally { restore(); }
  });

  it('defaults to gpt-4o-mini for plain OpenAI', () => {
    const restore = setEnv({
      SEARCH_BRAIN_MODEL: undefined,
      SMALL_MODEL: undefined,
      OPENROUTER_API_KEY: undefined,
      OPENAI_API_KEY: 'sk-x',
    });
    try {
      assert.equal(llm.getDefaultModel(), 'gpt-4o-mini');
    } finally { restore(); }
  });
});

// ── callLLM ───────────────────────────────────────────────────────

describe('callLLM', () => {
  it('returns null when no API key is configured (graceful fallback)', async () => {
    const restore = setEnv({ OPENROUTER_API_KEY: undefined, OPENAI_API_KEY: undefined });
    try {
      const out = await llm.callLLM({ system: 's', user: 'u' });
      assert.equal(out, null);
    } finally { restore(); }
  });

  it('returns { content } from the LLM response', async () => {
    const restore = setEnv({ OPENROUTER_API_KEY: 'x', OPENAI_API_KEY: undefined });
    nextChatResponse = { choices: [{ message: { content: 'hello from llm' } }] };
    try {
      const out = await llm.callLLM({ system: 's', user: 'u' });
      assert.deepEqual(out, { content: 'hello from llm' });
    } finally { restore(); }
  });

  it('returns null when content is missing or non-string', async () => {
    const restore = setEnv({ OPENROUTER_API_KEY: 'x', OPENAI_API_KEY: undefined });
    try {
      nextChatResponse = { choices: [{ message: { content: null } }] };
      assert.equal(await llm.callLLM({ system: 's', user: 'u' }), null);
      nextChatResponse = { choices: [{ message: { content: 42 } }] };
      assert.equal(await llm.callLLM({ system: 's', user: 'u' }), null);
      nextChatResponse = { choices: [] };
      assert.equal(await llm.callLLM({ system: 's', user: 'u' }), null);
      nextChatResponse = {};
      assert.equal(await llm.callLLM({ system: 's', user: 'u' }), null);
    } finally { restore(); }
  });

  it('returns null on a thrown error (no network propagation)', async () => {
    const restore = setEnv({ OPENROUTER_API_KEY: 'x', OPENAI_API_KEY: undefined });
    nextChatThrows = new Error('connection reset');
    try {
      const out = await llm.callLLM({ system: 's', user: 'u' });
      assert.equal(out, null);
    } finally { restore(); }
  });

  it('passes through temperature and maxTokens with defaults', async () => {
    const restore = setEnv({ OPENROUTER_API_KEY: 'x', OPENAI_API_KEY: undefined });
    nextChatResponse = { choices: [{ message: { content: 'ok' } }] };
    try {
      await llm.callLLM({ system: 's', user: 'u' });
      const client = llm.getClient();
      assert.equal(client.lastRequest.temperature, 0.2);
      assert.equal(client.lastRequest.max_tokens, 600);
    } finally { restore(); }
  });

  it('honours custom temperature, maxTokens, model overrides', async () => {
    const restore = setEnv({ OPENROUTER_API_KEY: 'x', OPENAI_API_KEY: undefined });
    nextChatResponse = { choices: [{ message: { content: 'ok' } }] };
    try {
      await llm.callLLM({
        system: 'sys',
        user: 'usr',
        temperature: 0.9,
        maxTokens: 1234,
        model: 'my/custom-model',
      });
      const client = llm.getClient();
      assert.equal(client.lastRequest.temperature, 0.9);
      assert.equal(client.lastRequest.max_tokens, 1234);
      assert.equal(client.lastRequest.model, 'my/custom-model');
    } finally { restore(); }
  });

  it('shapes messages as [system, user] in that order', async () => {
    const restore = setEnv({ OPENROUTER_API_KEY: 'x', OPENAI_API_KEY: undefined });
    nextChatResponse = { choices: [{ message: { content: 'ok' } }] };
    try {
      await llm.callLLM({ system: 'SYS', user: 'USR' });
      const client = llm.getClient();
      assert.deepEqual(client.lastRequest.messages, [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'USR' },
      ]);
    } finally { restore(); }
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports exactly { callLLM, getClient, getDefaultModel, __resetClient }', () => {
    const keys = Object.keys(llm).sort();
    assert.deepEqual(keys, ['__resetClient', 'callLLM', 'getClient', 'getDefaultModel']);
  });
});
