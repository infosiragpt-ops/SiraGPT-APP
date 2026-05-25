'use strict';

// Unit tests for the Cerebras (Free IA) provider adapter.
//
// These tests stub the OpenAI constructor so we don't actually hit the
// network, and exercise the env-driven config resolution + descriptor
// shape that /api/ai/models depends on.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getCerebrasConfig,
  isFreeIaConfigured,
  createCerebrasClient,
  createInstrumentedCerebrasClient,
  buildFreeIaModelDescriptor,
  getFreeIaPricing,
  inferModelFamily,
  runWithMetrics,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_DISPLAY_NAME,
  PROVIDER_NAME,
} = require('../src/services/ai/cerebras-client');

test('getCerebrasConfig: returns disabled when no API key is set', () => {
  const cfg = getCerebrasConfig({ env: {} });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.reason, 'no_api_key');
  // Defaults are still surfaced so the descriptor can render in the picker
  // (it just gets `enabled:false`).
  assert.equal(cfg.model, DEFAULT_MODEL);
  assert.equal(cfg.displayName, DEFAULT_DISPLAY_NAME);
  assert.equal(cfg.provider, PROVIDER_NAME);
});

test('getCerebrasConfig: enabled with API key — uses defaults for base/model/name', () => {
  const cfg = getCerebrasConfig({ env: { CEREBRAS_API_KEY: 'csk-abc' } });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.reason, 'ok');
  assert.equal(cfg.apiKey, 'csk-abc');
  assert.equal(cfg.baseURL, DEFAULT_BASE_URL);
  assert.equal(cfg.model, 'llama-3.1-8b');
  assert.equal(cfg.displayName, 'Free IA');
  assert.equal(cfg.provider, 'Cerebras');
});

test('getCerebrasConfig: overrides via env (CEREBRAS_BASE_URL, FREE_IA_MODEL_ID, FREE_IA_DISPLAY_NAME)', () => {
  const cfg = getCerebrasConfig({
    env: {
      CEREBRAS_API_KEY: 'csk-xyz',
      CEREBRAS_BASE_URL: 'https://example.test/v1/',
      FREE_IA_MODEL_ID: 'llama-3.1-70b',
      FREE_IA_DISPLAY_NAME: 'Gema4 31B',
    },
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.baseURL, 'https://example.test/v1');
  assert.equal(cfg.model, 'llama-3.1-70b');
  assert.equal(cfg.displayName, 'Gema4 31B');
});

test('getCerebrasConfig: invalid base URL is reported (enabled:false, reason:invalid_base_url)', () => {
  const cfg = getCerebrasConfig({
    env: { CEREBRAS_API_KEY: 'csk-abc', CEREBRAS_BASE_URL: 'not a url' },
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.reason, 'invalid_base_url');
});

test('getCerebrasConfig: ignores blank/whitespace env values', () => {
  const cfg = getCerebrasConfig({
    env: {
      CEREBRAS_API_KEY: '   csk-trimmed   ',
      CEREBRAS_BASE_URL: '',
      FREE_IA_MODEL_ID: '   ',
    },
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.apiKey, 'csk-trimmed');
  assert.equal(cfg.baseURL, DEFAULT_BASE_URL);
  assert.equal(cfg.model, DEFAULT_MODEL);
});

test('isFreeIaConfigured: matches enabled flag', () => {
  assert.equal(isFreeIaConfigured({ env: {} }), false);
  assert.equal(isFreeIaConfigured({ env: { CEREBRAS_API_KEY: 'csk-abc' } }), true);
});

test('createCerebrasClient: returns null when Cerebras is not configured', () => {
  const client = createCerebrasClient({ env: {} });
  assert.equal(client, null);
});

test('createCerebrasClient: instantiates OpenAI ctor with Cerebras apiKey + baseURL', () => {
  const calls = [];
  class FakeOpenAI {
    constructor(args) {
      calls.push(args);
      this.args = args;
    }
  }
  const client = createCerebrasClient({
    env: { CEREBRAS_API_KEY: 'csk-real-key' },
    OpenAICtor: FakeOpenAI,
  });
  assert.ok(client instanceof FakeOpenAI);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].apiKey, 'csk-real-key');
  assert.equal(calls[0].baseURL, DEFAULT_BASE_URL);
});

test('buildFreeIaModelDescriptor: shape matches what /api/ai/models expects', () => {
  const desc = buildFreeIaModelDescriptor({ env: { CEREBRAS_API_KEY: 'csk-abc' } });
  assert.equal(desc.name, 'llama-3.1-8b');
  assert.equal(desc.displayName, 'Free IA');
  assert.equal(desc.provider, 'Cerebras');
  assert.equal(desc.type, 'TEXT');
  assert.equal(desc.virtual, true);
  assert.equal(desc.enabled, true);
  assert.match(desc.id, /^__virtual_/);
  assert.match(desc.id, /llama_3_1_8b/);
});

test('buildFreeIaModelDescriptor: enabled:false when Cerebras key missing — descriptor still well-formed', () => {
  const desc = buildFreeIaModelDescriptor({ env: {} });
  assert.equal(desc.enabled, false);
  assert.equal(desc.name, 'llama-3.1-8b');
  assert.equal(desc.provider, 'Cerebras');
});

test('runWithMetrics: records success on a fulfilled call', async () => {
  const calls = { success: 0, errors: 0, lastCode: null };
  const stub = {
    recordUpstreamSuccess: () => { calls.success += 1; },
    recordUpstreamError: ({ code }) => { calls.errors += 1; calls.lastCode = code; },
  };
  const out = await runWithMetrics(async () => 'ok', { metrics: stub });
  assert.equal(out, 'ok');
  assert.equal(calls.success, 1);
  assert.equal(calls.errors, 0);
});

test('runWithMetrics: records error AND re-throws the original error', async () => {
  const calls = { success: 0, errors: 0, lastCode: null };
  const stub = {
    recordUpstreamSuccess: () => { calls.success += 1; },
    recordUpstreamError: ({ code }) => { calls.errors += 1; calls.lastCode = code; },
  };
  const err = new Error('boom');
  err.status = 503;
  await assert.rejects(
    () => runWithMetrics(async () => { throw err; }, { metrics: stub }),
    /boom/,
  );
  assert.equal(calls.success, 0);
  assert.equal(calls.errors, 1);
  assert.equal(calls.lastCode, 503);
});

test('runWithMetrics: forwards err.message to recordUpstreamError', async () => {
  const captured = [];
  const stub = {
    recordUpstreamSuccess: () => {},
    recordUpstreamError: (opts) => { captured.push(opts); },
  };
  const err = new Error('upstream is having a bad day');
  err.status = 503;
  await assert.rejects(
    () => runWithMetrics(async () => { throw err; }, { metrics: stub }),
    /bad day/,
  );
  assert.equal(captured.length, 1);
  assert.equal(captured[0].code, 503);
  assert.equal(captured[0].message, 'upstream is having a bad day');
});

test('runWithMetrics: extracts error code from .code / .status / .statusCode / .name', async () => {
  const codes = [];
  const stub = {
    recordUpstreamSuccess: () => {},
    recordUpstreamError: ({ code }) => { codes.push(code); },
  };
  await assert.rejects(() => runWithMetrics(async () => { const e = new Error(); e.code = 'ETIMEDOUT'; throw e; }, { metrics: stub }));
  await assert.rejects(() => runWithMetrics(async () => { const e = new Error(); e.status = 429; throw e; }, { metrics: stub }));
  await assert.rejects(() => runWithMetrics(async () => { const e = new Error(); e.statusCode = 502; throw e; }, { metrics: stub }));
  await assert.rejects(() => runWithMetrics(async () => { const e = new TypeError('bad'); throw e; }, { metrics: stub }));
  assert.deepEqual(codes, ['ETIMEDOUT', 429, 502, 'TypeError']);
});

test('runWithMetrics: missing metrics module is non-fatal (call still succeeds)', async () => {
  const out = await runWithMetrics(async () => 42, { metrics: null });
  assert.equal(out, 42);
});

test('createInstrumentedCerebrasClient: returns null when Cerebras is not configured', () => {
  const client = createInstrumentedCerebrasClient({ env: {} });
  assert.equal(client, null);
});

test('createInstrumentedCerebrasClient: wraps chat.completions.create to record metrics', async () => {
  const innerCalls = [];
  const recorded = { success: 0, errors: 0 };
  class FakeOpenAI {
    constructor(args) {
      this.args = args;
      this.chat = {
        completions: {
          create: async (...passed) => {
            innerCalls.push(passed);
            return { id: 'chatcmpl_test', choices: [{ message: { content: 'ok' } }] };
          },
        },
      };
    }
  }
  const metricsStub = {
    recordUpstreamSuccess: () => { recorded.success += 1; },
    recordUpstreamError: () => { recorded.errors += 1; },
  };
  const client = createInstrumentedCerebrasClient({
    env: { CEREBRAS_API_KEY: 'csk-instr' },
    OpenAICtor: FakeOpenAI,
    metrics: metricsStub,
  });
  assert.ok(client);
  const result = await client.chat.completions.create({ model: 'llama-3.1-8b', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.id, 'chatcmpl_test');
  assert.equal(innerCalls.length, 1);
  assert.equal(recorded.success, 1);
  assert.equal(recorded.errors, 0);
});

test('getFreeIaPricing: stable shape { priceUsd:0, isFree:true, badge:"Gratis" }', () => {
  const p = getFreeIaPricing();
  assert.equal(p.priceUsd, 0);
  assert.equal(p.isFree, true);
  assert.equal(p.perRequest, true);
  assert.equal(p.currency, 'USD');
  assert.equal(p.badge, 'Gratis');
});

test('inferModelFamily: extracts the major.minor llama family', () => {
  assert.equal(inferModelFamily('llama-3.1-8b'), 'llama-3.1');
  assert.equal(inferModelFamily('llama-3.1-70b'), 'llama-3.1');
  assert.equal(inferModelFamily('llama-3.3-70b'), 'llama-3.3');
  assert.equal(inferModelFamily('llama3.1-8b'), 'llama-3.1');
});

test('inferModelFamily: cerebras-prefixed models map to "cerebras" bucket', () => {
  assert.equal(inferModelFamily('cerebras:custom-thing'), 'cerebras');
  assert.equal(inferModelFamily('cerebras-experimental'), 'cerebras');
});

test('inferModelFamily: returns "unknown" for empty / unrecognised ids', () => {
  assert.equal(inferModelFamily(''), 'unknown');
  assert.equal(inferModelFamily(null), 'unknown');
  assert.equal(inferModelFamily('gpt-5'), 'unknown');
  assert.equal(inferModelFamily('mystery-model'), 'unknown');
});

test('buildFreeIaModelDescriptor: includes pricing block + family', () => {
  const desc = buildFreeIaModelDescriptor({ env: { CEREBRAS_API_KEY: 'csk-pricing' } });
  assert.ok(desc.pricing);
  assert.equal(desc.pricing.priceUsd, 0);
  assert.equal(desc.pricing.isFree, true);
  assert.equal(desc.pricing.badge, 'Gratis');
  assert.equal(desc.family, 'llama-3.1', 'descriptor should expose the model family for picker grouping');
});

test('integration: instrumented client → real metrics module captures error+message', async () => {
  const realMetrics = require('../src/services/free-ia-metrics');
  realMetrics.reset();
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async () => {
            const e = new Error('Cerebras 503 — service unavailable');
            e.status = 503;
            throw e;
          },
        },
      };
    }
  }
  const client = createInstrumentedCerebrasClient({
    env: { CEREBRAS_API_KEY: 'csk-integ' },
    OpenAICtor: FakeOpenAI,
    // no metrics arg → uses the real module via lazy require
  });
  await assert.rejects(
    () => client.chat.completions.create({ model: 'llama-3.1-8b', messages: [] }),
    /service unavailable/,
  );
  const s = realMetrics.snapshot();
  assert.equal(s.upstream.errors, 1);
  assert.equal(s.upstream.lastErrorCode, '503');
  assert.equal(s.upstream.lastErrorMessage, 'Cerebras 503 — service unavailable');
  assert.equal(s.upstream.errorsByCode['503'], 1);
  realMetrics.reset();
});

test('createInstrumentedCerebrasClient: records error AND re-throws when upstream fails', async () => {
  const recorded = { success: 0, errors: 0 };
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async () => { const e = new Error('upstream 503'); e.status = 503; throw e; },
        },
      };
    }
  }
  const metricsStub = {
    recordUpstreamSuccess: () => { recorded.success += 1; },
    recordUpstreamError: ({ code }) => { recorded.errors += 1; recorded.lastCode = code; },
  };
  const client = createInstrumentedCerebrasClient({
    env: { CEREBRAS_API_KEY: 'csk-err' },
    OpenAICtor: FakeOpenAI,
    metrics: metricsStub,
  });
  await assert.rejects(
    () => client.chat.completions.create({ model: 'llama-3.1-8b', messages: [] }),
    /upstream 503/,
  );
  assert.equal(recorded.success, 0);
  assert.equal(recorded.errors, 1);
  assert.equal(recorded.lastCode, 503);
});
