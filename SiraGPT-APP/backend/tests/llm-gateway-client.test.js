'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  getGatewayConfig,
  isGatewayEnabled,
  shouldUseGatewayForRequest,
  createGatewayClient,
  callWithGatewayOrDirect,
  _internal,
} = require('../src/services/ai/llm-gateway-client');

const BASE_ENV = Object.freeze({});

test('getGatewayConfig disables when LLM_GATEWAY_URL missing', () => {
  const cfg = getGatewayConfig({ env: { LLM_GATEWAY_KEY: 'x' } });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.reason, 'no_url');
});

test('getGatewayConfig disables when LLM_GATEWAY_KEY missing', () => {
  const cfg = getGatewayConfig({ env: { LLM_GATEWAY_URL: 'https://gw.example.com/v1' } });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.reason, 'no_key');
});

test('getGatewayConfig disables on invalid URL without throwing', () => {
  const cfg = getGatewayConfig({ env: { LLM_GATEWAY_URL: 'not a url', LLM_GATEWAY_KEY: 'k' } });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.reason, 'invalid_url');
});

test('getGatewayConfig enables and strips trailing slash', () => {
  const cfg = getGatewayConfig({
    env: { LLM_GATEWAY_URL: 'https://gw.example.com/v1/', LLM_GATEWAY_KEY: 'sk_x' },
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.url, 'https://gw.example.com/v1');
  assert.equal(cfg.key, 'sk_x');
  assert.equal(cfg.timeoutMs, 60_000);
  assert.equal(cfg.maxRetries, 2);
  assert.equal(cfg.forceForAll, false);
});

test('getGatewayConfig honors LLM_GATEWAY_FORCE=1', () => {
  const cfg = getGatewayConfig({
    env: { LLM_GATEWAY_URL: 'https://gw.example.com/v1', LLM_GATEWAY_KEY: 'k', LLM_GATEWAY_FORCE: '1' },
  });
  assert.equal(cfg.forceForAll, true);
});

test('isGatewayEnabled mirrors config.enabled', () => {
  assert.equal(isGatewayEnabled({ env: BASE_ENV }), false);
  assert.equal(
    isGatewayEnabled({ env: { LLM_GATEWAY_URL: 'https://x.test/v1', LLM_GATEWAY_KEY: 'k' } }),
    true,
  );
});

test('shouldUseGatewayForRequest requires header opt-in by default', () => {
  const env = { LLM_GATEWAY_URL: 'https://x.test/v1', LLM_GATEWAY_KEY: 'k' };
  assert.equal(shouldUseGatewayForRequest({ headers: {} }, { env }), false);
  assert.equal(
    shouldUseGatewayForRequest({ headers: { 'x-sira-gateway': '1' } }, { env }),
    true,
  );
});

test('shouldUseGatewayForRequest forces on with LLM_GATEWAY_FORCE=1', () => {
  const env = {
    LLM_GATEWAY_URL: 'https://x.test/v1',
    LLM_GATEWAY_KEY: 'k',
    LLM_GATEWAY_FORCE: '1',
  };
  assert.equal(shouldUseGatewayForRequest({ headers: {} }, { env }), true);
});

test('shouldUseGatewayForRequest is false when gateway disabled', () => {
  assert.equal(
    shouldUseGatewayForRequest({ headers: { 'x-sira-gateway': '1' } }, { env: BASE_ENV }),
    false,
  );
});

test('createGatewayClient returns null when disabled', () => {
  assert.equal(createGatewayClient({ env: BASE_ENV }), null);
});

test('createGatewayClient returns OpenAI-shaped client when enabled', () => {
  const client = createGatewayClient({
    env: { LLM_GATEWAY_URL: 'https://gw.test/v1', LLM_GATEWAY_KEY: 'k' },
  });
  assert.ok(client, 'client returned');
  // Minimal duck-type — we don't want to depend on the OpenAI SDK's internal
  // shape, but every version exposes baseURL on the instance.
  assert.equal(typeof client, 'object');
});

test('callWithGatewayOrDirect uses direct when gateway disabled', async () => {
  let directCalls = 0;
  const result = await callWithGatewayOrDirect({
    req: { headers: { 'x-sira-gateway': '1' } },
    legacy: () => ({ id: 'legacy' }),
    attempt: async (client, meta) => {
      directCalls += 1;
      return { client, meta };
    },
    env: BASE_ENV,
  });
  assert.equal(directCalls, 1);
  assert.equal(result.via, 'direct');
  assert.equal(result.fallback, false);
  assert.deepEqual(result.result.client, { id: 'legacy' });
});

test('callWithGatewayOrDirect routes through gateway with header opt-in', async () => {
  const env = { LLM_GATEWAY_URL: 'https://gw.test/v1', LLM_GATEWAY_KEY: 'k' };
  const calls = [];
  const result = await callWithGatewayOrDirect({
    req: { headers: { 'x-sira-gateway': '1' } },
    legacy: () => ({ id: 'legacy' }),
    attempt: async (_client, meta) => {
      calls.push(meta.via);
      return { ok: true };
    },
    env,
  });
  assert.deepEqual(calls, ['gateway']);
  assert.equal(result.via, 'gateway');
  assert.equal(result.fallback, false);
});

test('callWithGatewayOrDirect falls back on transient gateway error', async () => {
  const env = { LLM_GATEWAY_URL: 'https://gw.test/v1', LLM_GATEWAY_KEY: 'k' };
  const calls = [];
  const events = [];
  const result = await callWithGatewayOrDirect({
    req: { headers: { 'x-sira-gateway': '1' } },
    legacy: () => ({ id: 'legacy' }),
    attempt: async (_client, meta) => {
      calls.push(meta.via);
      if (meta.via === 'gateway') {
        const err = new Error('gateway 502');
        err.status = 502;
        throw err;
      }
      return { ok: true, via: 'direct' };
    },
    onEvent: (e) => events.push(e.type),
    env,
  });
  assert.deepEqual(calls, ['gateway', 'direct']);
  assert.equal(result.via, 'direct');
  assert.equal(result.fallback, true);
  assert.ok(events.includes('gateway.error.fallback'));
});

test('callWithGatewayOrDirect rethrows non-retryable gateway error', async () => {
  const env = { LLM_GATEWAY_URL: 'https://gw.test/v1', LLM_GATEWAY_KEY: 'k' };
  await assert.rejects(
    callWithGatewayOrDirect({
      req: { headers: { 'x-sira-gateway': '1' } },
      legacy: () => ({ id: 'legacy' }),
      attempt: async (_client, meta) => {
        if (meta.via === 'gateway') {
          const err = new Error('bad request');
          err.status = 400;
          throw err;
        }
        return { ok: true };
      },
      env,
    }),
    /bad request/,
  );
});

test('callWithGatewayOrDirect rejects on missing attempt/legacy', async () => {
  await assert.rejects(
    callWithGatewayOrDirect({ legacy: () => ({}) }),
    /attempt/,
  );
  await assert.rejects(
    callWithGatewayOrDirect({ attempt: async () => ({}) }),
    /legacy/,
  );
});

test('isGatewayFallbackable classifies transient + terminal errors', () => {
  const { isGatewayFallbackable } = _internal;
  assert.equal(isGatewayFallbackable({ status: 500 }), true);
  assert.equal(isGatewayFallbackable({ status: 502 }), true);
  assert.equal(isGatewayFallbackable({ status: 429 }), true);
  assert.equal(isGatewayFallbackable({ status: 408 }), true);
  assert.equal(isGatewayFallbackable({ status: 400 }), false);
  assert.equal(isGatewayFallbackable({ status: 401 }), false);
  assert.equal(isGatewayFallbackable({ status: 403 }), false);
  assert.equal(isGatewayFallbackable({ message: 'fetch failed: socket hang up' }), true);
  assert.equal(isGatewayFallbackable({ code: 'ETIMEDOUT' }), true);
  assert.equal(isGatewayFallbackable(null), false);
});
