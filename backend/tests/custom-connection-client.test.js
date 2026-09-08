'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_LOCAL_BASE_URL,
  createCustomConnectionClient,
  resolveCustomConnectionConfig,
} = require('../src/services/ai/custom-connection-client');

test('resolveCustomConnectionConfig uses admin CUSTOM_BASE_URL', () => {
  const cfg = resolveCustomConnectionConfig({
    CUSTOM_BASE_URL: 'http://127.0.0.1:11434/v1',
    CUSTOM_API_KEY: 'ollama',
  });
  assert.equal(cfg.baseURL, 'http://127.0.0.1:11434/v1');
  assert.equal(cfg.apiKey, 'ollama');
});

test('createCustomConnectionClient never points at OpenAI when Custom is selected', () => {
  const created = [];
  function FakeOpenAI(opts) {
    created.push(opts);
    return opts;
  }
  const client = createCustomConnectionClient({
    CUSTOM_BASE_URL: 'http://localhost:11434/v1',
    CUSTOM_API_KEY: 'local',
  }, FakeOpenAI);
  assert.equal(client.baseURL, 'http://localhost:11434/v1');
  assert.equal(client.apiKey, 'local');
  assert.equal(created.length, 1);
  assert.doesNotMatch(String(created[0].baseURL || ''), /openai\.com/);
});

test('createCustomConnectionClient defaults to local Ollama, not Flash/OpenAI', () => {
  const client = createCustomConnectionClient({}, function FakeOpenAI(opts) { return opts; });
  assert.equal(client.baseURL, DEFAULT_LOCAL_BASE_URL);
});
