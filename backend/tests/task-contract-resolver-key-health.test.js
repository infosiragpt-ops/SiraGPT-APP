'use strict';

/**
 * Item 3 (prod 2026-09-28): `[task-contract-resolver] LLM resolve failed: 429
 * You have no credits remaining` on every request. The resolver must pick a
 * provider whose key is healthy (OpenAI → DeepSeek → Cerebras → Gemini via
 * provider-key-health + billing-failover), stay non-fatal, and log a failure
 * once per reason per 10 min instead of once per request.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const resolver = require('../src/services/agents/task-contract-resolver');
const billing = require('../src/services/ai/billing-failover');
const keyHealth = require('../src/utils/provider-key-health');

const ENV = { OPENAI_API_KEY: 'sk-live-oa', DEEPSEEK_API_KEY: 'ds-live', CEREBRAS_API_KEY: 'cb-live', GEMINI_API_KEY: 'g-live' };

function fakeClient(baseURL, onCall, { throws = null } = {}) {
  return {
    baseURL,
    chat: { completions: { create: async (opts) => { onCall(opts); if (throws) throw throws; return { choices: [{ message: { content: '{}' } }] }; } } },
  };
}

function captureConsole() {
  const out = { warn: [], debug: [] };
  const orig = { warn: console.warn, debug: console.debug };
  console.warn = (...a) => out.warn.push(a.join(' '));
  console.debug = (...a) => out.debug.push(a.join(' '));
  return { out, restore: () => { console.warn = orig.warn; console.debug = orig.debug; } };
}

test.beforeEach(() => { billing.__resetForTests(); keyHealth.clear(); resolver.__resetResolverForTests(); });

test('pickResolverRuntime: healthy OpenAI keeps the legacy behaviour (native honoured, side channel for foreign clients)', () => {
  const built = [];
  const createClient = (target) => { built.push(target.provider); return fakeClient(target.baseURL, () => {}); };
  const native = fakeClient('https://api.openai.com/v1', () => {});
  const keep = resolver.pickResolverRuntime({ openai: native, model: 'gpt-4o-mini', env: ENV, deps: { createClient } });
  assert.equal(keep.client, native);
  assert.equal(keep.model, 'gpt-4o-mini');
  assert.deepEqual(built, []);

  const router = fakeClient('https://openrouter.ai/api/v1', () => {});
  const side = resolver.pickResolverRuntime({ openai: router, model: 'gpt-4o-mini', env: ENV, deps: { createClient } });
  assert.deepEqual(built, ['OpenAI']);
  assert.notEqual(side.client, router);
  assert.equal(side.provider, 'OpenAI');

  // Native caller without an env key is still honoured (a per-user key).
  const noKey = resolver.pickResolverRuntime({ openai: native, model: 'gpt-4o-mini', env: {}, deps: { createClient } });
  assert.equal(noKey.client, native);

  // Placeholder CI keys never build a side channel.
  const ci = resolver.pickResolverRuntime({ openai: router, model: 'gpt-4o-mini', env: { OPENAI_API_KEY: 'sk-ci-dummy-openai-key-not-used-in-smoke-test', GEMINI_API_KEY: 'ci-dummy-gemini-key' }, deps: { createClient } });
  assert.equal(ci.client, router, 'legacy: keep the caller client');
  assert.deepEqual(built, ['OpenAI']);
});

test('pickResolverRuntime: an unfunded/rejected OpenAI key falls to DeepSeek → Cerebras → Gemini, or skips the LLM', () => {
  const built = [];
  const createClient = (target) => { built.push(target.provider); return fakeClient(target.baseURL, () => {}); };
  const native = fakeClient('https://api.openai.com/v1', () => {});

  billing.markOutOfCredit('OpenAI', Object.assign(new Error('You have no credits remaining'), { status: 429 }), ENV);
  const ds = resolver.pickResolverRuntime({ openai: native, model: 'gpt-4o-mini', env: ENV, deps: { createClient } });
  assert.equal(ds.provider, 'DeepSeek');
  assert.equal(ds.model, 'deepseek-v4-flash');
  assert.notEqual(ds.client, native, 'the dead native client is not used');

  keyHealth.markRejected('deepseek', 'ds-live', { status: 401 });
  const cb = resolver.pickResolverRuntime({ openai: native, model: 'gpt-4o-mini', env: { ...ENV, AGENT_TASK_CEREBRAS_MODEL: 'llama-3.3-70b' }, deps: { createClient } });
  assert.equal(cb.provider, 'Cerebras');
  assert.equal(cb.model, 'llama-3.3-70b');

  keyHealth.markRejected('cerebras', 'cb-live', { status: 403 });
  const gm = resolver.pickResolverRuntime({ openai: native, model: 'gpt-4o-mini', env: ENV, deps: { createClient } });
  assert.equal(gm.provider, 'Gemini');

  keyHealth.markRejected('gemini', 'g-live', { status: 401 });
  const none = resolver.pickResolverRuntime({ openai: native, model: 'gpt-4o-mini', env: ENV, deps: { createClient } });
  assert.equal(none.client, null);
  assert.match(none.skipped, /OpenAI:unfunded/);
  assert.match(none.skipped, /DeepSeek:key_rejected/);
  assert.deepEqual(built, ['DeepSeek', 'Cerebras', 'Gemini']);
});

test('resolveTaskContract: a 429 «no credits» marks OpenAI unfunded, the next request never calls it, and stays non-fatal', async () => {
  const cap = captureConsole();
  try {
    const openaiCalls = [];
    const dsCalls = [];
    const dry = Object.assign(new Error('429 You have no credits remaining. Add credits to continue.'), { status: 429 });
    const native = fakeClient('https://api.openai.com/v1', (o) => openaiCalls.push(o), { throws: dry });
    const createClient = (target) => fakeClient(target.baseURL, (o) => (target.provider === 'DeepSeek' ? dsCalls.push(o) : null));
    const fallback = ({ goal }) => ({ goal, intent: 'g', _fallback: true });

    const first = await resolver.resolveTaskContract({ goal: 'analiza el pdf', openai: native, fileIds: [], fallback, env: ENV, deps: { createClient } });
    assert.equal(first.source, 'fallback', 'non-fatal: heuristic contract');
    assert.equal(openaiCalls.length, 1);
    assert.equal(billing.isOutOfCredit('OpenAI', ENV), true, 'billing memo set from the resolver failure');
    assert.equal(keyHealth.rejectionReason('openai', 'sk-live-oa'), 'billing');

    const second = await resolver.resolveTaskContract({ goal: 'resume el docx', openai: native, fileIds: [], fallback, env: ENV, deps: { createClient } });
    assert.equal(second.source, 'fallback');
    assert.equal(openaiCalls.length, 1, 'no second round-trip on the dead key');
    assert.equal(dsCalls.length, 1, 'DeepSeek side channel took over');
    assert.equal(dsCalls[0].model, 'deepseek-v4-flash');
    assert.equal(dsCalls[0].temperature, 0);

    // Logged once at WARN for this reason; not per request.
    const warns = cap.out.warn.filter((l) => l.includes('[task-contract-resolver] LLM resolve failed'));
    assert.equal(warns.length, 1);
    assert.match(warns[0], /OpenAI:gpt-4o-mini/);
    assert.doesNotMatch(warns.join('\n'), /sk-live/, 'never logs the key');
  } finally {
    cap.restore();
  }
});

test('logResolverFailureOnce: WARN once per reason, debug within the 10 min window, WARN again afterwards', () => {
  const cap = captureConsole();
  try {
    assert.equal(resolver.logResolverFailureOnce('r1', 'line', 1_000), true);
    assert.equal(resolver.logResolverFailureOnce('r1', 'line', 2_000), false);
    assert.equal(resolver.logResolverFailureOnce('r2', 'other', 2_000), true, 'a different reason logs');
    assert.equal(resolver.logResolverFailureOnce('r1', 'line', 1_000 + resolver.RESOLVER_LOG_DEBOUNCE_MS), true);
    assert.equal(resolver.RESOLVER_LOG_DEBOUNCE_MS, 10 * 60 * 1000);
    assert.equal(cap.out.warn.length, 3);
    assert.equal(cap.out.debug.length, 1);
  } finally {
    cap.restore();
  }
});
