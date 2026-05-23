'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHeliconeProxy } = require('../src/orchestration/helicone-proxy');

test('exports createHeliconeProxy', () => {
  assert.equal(typeof createHeliconeProxy, 'function');
});

test('proxy is disabled when HELICONE_API_KEY is missing', () => {
  const proxy = createHeliconeProxy({ env: {} });
  assert.equal(proxy.enabled, false);
  assert.equal(proxy.apiKey, null);
});

test('proxy is enabled when HELICONE_API_KEY is set', () => {
  const proxy = createHeliconeProxy({ env: { HELICONE_API_KEY: 'sk-helicone-secret-key' } });
  assert.equal(proxy.enabled, true);
  assert.match(proxy.apiKey, /^sk-helic/, 'apiKey field shows a redacted prefix only');
  assert.ok(!proxy.apiKey.includes('secret-key'), 'must not leak full key');
});

test('wrapHeaders is identity when proxy is disabled', () => {
  const proxy = createHeliconeProxy({ env: {} });
  const headers = { authorization: 'Bearer x', 'content-type': 'application/json' };
  const wrapped = proxy.wrapHeaders(headers);
  assert.deepEqual(wrapped, headers);
  assert.equal(wrapped['Helicone-Auth'], undefined);
});

test('wrapHeaders injects Helicone auth + property when enabled', () => {
  const proxy = createHeliconeProxy({ env: { HELICONE_API_KEY: 'sk-h-test' } });
  const wrapped = proxy.wrapHeaders({ authorization: 'Bearer orig' });
  assert.equal(wrapped.authorization, 'Bearer orig', 'must preserve original headers');
  assert.equal(wrapped['Helicone-Auth'], 'Bearer sk-h-test');
  assert.equal(wrapped['Helicone-Property-App'], 'siragpt');
});

test('wrapHeaders handles no-args call without throwing', () => {
  const proxy = createHeliconeProxy({ env: { HELICONE_API_KEY: 'sk' } });
  const wrapped = proxy.wrapHeaders();
  assert.equal(wrapped['Helicone-Auth'], 'Bearer sk');
  assert.equal(wrapped['Helicone-Property-App'], 'siragpt');
});

test('wrapBaseUrl returns the original URL when proxy is disabled', () => {
  const proxy = createHeliconeProxy({ env: {} });
  assert.equal(proxy.wrapBaseUrl('openai', 'https://api.openai.com/v1'), 'https://api.openai.com/v1');
});

test('wrapBaseUrl rewrites the OpenAI base URL when enabled', () => {
  const proxy = createHeliconeProxy({ env: { HELICONE_API_KEY: 'sk' } });
  assert.equal(proxy.wrapBaseUrl('openai', 'https://api.openai.com/v1'), 'https://oai.helicone.ai/v1');
});

test('wrapBaseUrl uses HELICONE_BASE_URL override when present', () => {
  const proxy = createHeliconeProxy({
    env: { HELICONE_API_KEY: 'sk', HELICONE_BASE_URL: 'https://custom.helicone.local' },
  });
  assert.equal(proxy.wrapBaseUrl('openai', 'https://api.openai.com/v1'), 'https://custom.helicone.local/v1');
});

test('wrapBaseUrl leaves non-openai providers untouched even when enabled', () => {
  const proxy = createHeliconeProxy({ env: { HELICONE_API_KEY: 'sk' } });
  assert.equal(
    proxy.wrapBaseUrl('anthropic', 'https://api.anthropic.com/v1'),
    'https://api.anthropic.com/v1'
  );
  assert.equal(
    proxy.wrapBaseUrl('groq', 'https://api.groq.com/openai/v1'),
    'https://api.groq.com/openai/v1'
  );
});

test('wrapHeaders never mutates the input headers object', () => {
  const proxy = createHeliconeProxy({ env: { HELICONE_API_KEY: 'sk' } });
  const input = { authorization: 'Bearer x' };
  const copy = { ...input };
  proxy.wrapHeaders(input);
  assert.deepEqual(input, copy, 'wrapHeaders must return a fresh object');
});
