'use strict';

/**
 * Sira Rápido / Sira Pro keep answering when DeepSeek direct is out of
 * credit: a 402/401/403 on chat.completions.create is retried ONCE on the
 * OpenRouter client with the OpenRouter slug; transient errors are not.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mod = require('../src/services/ai/deepseek-billing-failover');

function client(create) { return { chat: { completions: { create } } }; }
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const quiet = { warn() {} };

test.beforeEach(() => mod.resetForTests());

test('a 402 Insufficient Balance on DeepSeek direct is retried on OpenRouter with the mapped slug (stream option kept)', async () => {
  const calls = { direct: [], or: [] };
  const direct = client(async (body, opts) => { calls.direct.push({ body, opts }); throw httpError(402, '402 Insufficient Balance'); });
  const openrouter = client(async (body, opts) => { calls.or.push({ body, opts }); return { id: 'or-1', model: body.model }; });
  const wrapped = mod.wrapDeepSeekClient(direct, { fallbackClientFactory: () => openrouter, env: {}, log: quiet });
  const out = await wrapped.chat.completions.create({ model: 'deepseek-v4-pro', messages: [], stream: true }, { signal: 'sig' });
  assert.equal(out.id, 'or-1'); assert.equal(out.model, 'deepseek/deepseek-v4-pro');
  assert.equal(calls.direct.length, 1); assert.equal(calls.or.length, 1);
  assert.equal(calls.or[0].body.stream, true); assert.equal(calls.or[0].opts.signal, 'sig');
  assert.equal(mod.snapshot().memoised, true);
  // memoised: the next call skips the dead round-trip
  await wrapped.chat.completions.create({ model: 'deepseek-v4-flash', messages: [] });
  assert.equal(calls.direct.length, 1, 'no second DeepSeek call while memoised');
  assert.equal(calls.or[1].body.model, 'deepseek/deepseek-v4-flash');
  assert.equal(calls.or[1].opts, undefined, 'options omitted when the caller omitted them');
});

test('transient errors (5xx, timeout, 429) are NOT failed over here; success passes through untouched', async () => {
  const openrouterCalls = [];
  const openrouter = client(async (body) => { openrouterCalls.push(body); return {}; });
  const direct500 = mod.wrapDeepSeekClient(client(async () => { throw httpError(503, 'upstream'); }), { fallbackClientFactory: () => openrouter, env: {}, log: quiet });
  await assert.rejects(() => direct500.chat.completions.create({ model: 'deepseek-v4-pro' }), /upstream/);
  const direct429 = mod.wrapDeepSeekClient(client(async () => { throw httpError(429, 'rate limit'); }), { fallbackClientFactory: () => openrouter, env: {}, log: quiet });
  await assert.rejects(() => direct429.chat.completions.create({ model: 'deepseek-v4-pro' }), /rate limit/);
  assert.equal(openrouterCalls.length, 0);
  assert.equal(mod.snapshot().memoised, false);
  const ok = mod.wrapDeepSeekClient(client(async (body) => ({ echo: body.model })), { fallbackClientFactory: () => openrouter, env: {}, log: quiet });
  assert.deepEqual(await ok.chat.completions.create({ model: 'deepseek-v4-pro' }), { echo: 'deepseek-v4-pro' });
});

test('when OpenRouter is unavailable the original DeepSeek error surfaces; memo expires after the TTL', async () => {
  const wrapped = mod.wrapDeepSeekClient(client(async () => { throw httpError(402, '402 Insufficient Balance'); }), { fallbackClientFactory: () => { throw new Error('Conexión OpenRouter no disponible'); }, env: {}, log: quiet });
  await assert.rejects(() => wrapped.chat.completions.create({ model: 'deepseek-v4-pro' }), /Insufficient Balance/);
  assert.equal(mod.snapshot().memoised, true);
  // TTL of 1s → after it, DeepSeek direct is probed again
  mod.resetForTests();
  let directCalls = 0;
  const w2 = mod.wrapDeepSeekClient(client(async () => { directCalls += 1; throw httpError(402, 'Insufficient Balance'); }), { fallbackClientFactory: () => client(async () => ({ ok: true })), env: { SIRAGPT_DEEPSEEK_BILLING_MEMO_MS: '1000' }, log: quiet });
  await w2.chat.completions.create({ model: 'deepseek-v4-pro' });
  await w2.chat.completions.create({ model: 'deepseek-v4-pro' });
  assert.equal(directCalls, 1, 'memoised within the TTL');
  await new Promise((r) => setTimeout(r, 1100));
  await w2.chat.completions.create({ model: 'deepseek-v4-pro' });
  assert.equal(directCalls, 2, 'probed again after the TTL');
});

test('classification and slug mapping', () => {
  assert.equal(mod.isBillingOrAuthError(httpError(402, 'x')), true);
  assert.equal(mod.isBillingOrAuthError({ message: 'Incorrect API key provided' }), true);
  assert.equal(mod.isBillingOrAuthError({ message: 'insufficient_quota' }), true);
  assert.equal(mod.isBillingOrAuthError(httpError(429, 'rate limit exceeded')), false);
  assert.equal(mod.isBillingOrAuthError(httpError(500, 'boom')), false);
  assert.equal(mod.isBillingOrAuthError(null), false);
  assert.equal(mod.toOpenRouterSlug('deepseek-v4-pro'), 'deepseek/deepseek-v4-pro');
  assert.equal(mod.toOpenRouterSlug('deepseek/deepseek-v4-flash'), 'deepseek/deepseek-v4-flash');
  assert.equal(mod.toOpenRouterSlug(''), 'deepseek/deepseek-v4-flash');
});

test('ai.js wraps the DeepSeek client with the OpenRouter fallback factory', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
  assert.match(src, /require\('\.\.\/services\/ai\/deepseek-billing-failover'\)/);
  assert.match(src, /return wrapDeepSeekClient\(new OpenAI\(\{\n\s+apiKey: process\.env\.DEEPSEEK_API_KEY,\n\s+baseURL: "https:\/\/api\.deepseek\.com",\n\s+\}\), \{\n\s+fallbackClientFactory: \(\) => createProviderClient\('OpenRouter'\),/);
});
