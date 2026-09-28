'use strict';

/**
 * Item 2 (prod 2026-09-28): `[billing-failover] Anthropic:claude-fable-5-1
 * sin saldo (400) → xAI:grok-4.7` and xAI answered 403 «used all available
 * credits» → user error. The fallback must skip unfunded/rejected providers,
 * walk DeepSeek → Cerebras → Gemini → Groq → Mistral → OpenRouter and, when
 * the fallback is dry too, try the next one (max 2 hops).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const billing = require('../src/services/ai/billing-failover');
const keyHealth = require('../src/utils/provider-key-health');

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

const ROWS = [
  { id: 'm1', name: 'claude-fable-5-1', displayName: 'Claude Fable 5.1', provider: 'Anthropic', type: 'TEXT', isActive: true },
  { id: 'm2', name: 'grok-4.7', displayName: 'Grok 4.7', provider: 'xAI', type: 'TEXT', isActive: true },
  { id: 'm3', name: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', provider: 'DeepSeek', type: 'TEXT', isActive: true },
  { id: 'm4', name: 'gpt-oss-120b', displayName: 'GPT OSS 120B', provider: 'Cerebras', type: 'TEXT', isActive: true },
  { id: 'm5', name: 'gemini-3.8-pro', displayName: 'Gemini 3.8 Pro', provider: 'Gemini', type: 'TEXT', isActive: true },
  { id: 'm6', name: 'gpt-6-sol', displayName: 'GPT-6 Sol', provider: 'OpenAI', type: 'TEXT', isActive: true },
];

function deps({ notReady = [], rejected = [] } = {}) {
  return {
    prisma: { aiModel: { findMany: async () => ROWS } },
    catalog: { curateVisibleTextModels: (list) => list },
    inference: { resolveGenerateProvider: (p) => p, providerConnectionReady: (p) => !notReady.includes(p) },
    keyHealth: { isRejected: (p) => rejected.includes(String(p).toLowerCase()) },
    capabilities: { resolveModelCapabilities: () => ({ supportsImages: false }) },
  };
}

test.beforeEach(() => billing.__resetForTests());

test('isBillingError recognises the three prod shapes of 2026-09-27/28 and keeps rate limits out', () => {
  const yes = [
    httpError(429, 'You have no credits remaining. Add credits to continue.'),
    httpError(400, 'Your credit balance is too low to access the Anthropic API.'),
    httpError(403, 'You have used all available credits. Please purchase more to continue.', { code: 'permission_denied' }),
    httpError(403, 'Your team has reached its spending limit for this month.'),
    httpError(429, 'insufficient_quota', { code: 'insufficient_quota' }),
    httpError(402, 'Payment Required'),
  ];
  const no = [
    httpError(429, 'Rate limit reached for requests. Please try again in 20s.'),
    httpError(429, 'Too many requests'),
    httpError(401, 'Incorrect API key provided'),
    httpError(403, 'Forbidden: this model is not enabled for your account'),
    httpError(500, 'Internal server error'),
  ];
  for (const err of yes) assert.equal(billing.isBillingError(err), true, err.message);
  for (const err of no) assert.equal(billing.isBillingError(err), false, err.message);
});

test('markOutOfCredit also marks the current key rejected for billing so every ladder skips it', () => {
  const env = { XAI_API_KEY: 'xai-dry', SIRAGPT_BILLING_FAILOVER_MEMO_MS: '60000' };
  billing.markOutOfCredit('xAI', httpError(403, 'You have used all available credits'), env);
  assert.equal(billing.isOutOfCredit('xAI', env), true);
  assert.equal(keyHealth.isRejected('xai', 'xai-dry'), true, 'provider-key-health memo set');
  assert.equal(keyHealth.rejectionReason('xai', 'xai-dry'), 'billing');
  assert.equal(keyHealth.snapshot().xai.reason, 'billing');
  assert.equal(keyHealth.isRejected('xai', 'xai-new'), false, 'a new key re-arms the provider');
  assert.equal(billing.isUnfunded('xAI', env), true);
  assert.equal(billing.isUnfunded('DeepSeek', { DEEPSEEK_API_KEY: 'ds-ok' }), false);
  // Without a key in env nothing is memoised in key health (fake envs in tests).
  billing.markOutOfCredit('Meta', httpError(402, 'Insufficient Balance'), {});
  assert.equal(keyHealth.snapshot().meta, undefined);
});

test('pickFailoverModel walks the funded ladder and skips out-of-credit, key-rejected and excluded providers', async () => {
  const env = { XAI_API_KEY: 'xai-dry', DEEPSEEK_API_KEY: 'ds-ok', CEREBRAS_API_KEY: 'cb-ok', GEMINI_API_KEY: 'g-ok' };
  // Anthropic dry → DeepSeek first, never xAI (rank 7 in the ladder).
  const first = await billing.pickFailoverModel({ fromProvider: 'Anthropic', fromModel: 'claude-fable-5-1', env, deps: deps() });
  assert.equal(first.provider, 'DeepSeek');
  assert.equal(first.model, 'deepseek-v4-pro');

  // The prod incident: xAI answered 403 «used all credits» → memo → next hop
  // must not pick it, and DeepSeek (already tried) is excluded explicitly.
  billing.markOutOfCredit('xAI', httpError(403, 'You have used all available credits'), env);
  const second = await billing.pickFailoverModel({
    fromProvider: 'Anthropic', fromModel: 'claude-fable-5-1', env, deps: deps(), excludeProviders: ['DeepSeek'],
  });
  assert.equal(second.provider, 'Cerebras');
  assert.equal(second.fromLabel, 'Claude Fable 5.1', 'the notice still names the model the user chose');

  // Key-health rejection (auth or billing) is honoured through deps.keyHealth;
  // with OpenAI dry too (the prod night), only Gemini is left.
  const envDry = { ...env, OPENAI_API_KEY: 'oa-dry' };
  billing.markOutOfCredit('OpenAI', httpError(429, 'You have no credits remaining'), envDry);
  const third = await billing.pickFailoverModel({
    fromProvider: 'Anthropic', fromModel: 'claude-fable-5-1', env: envDry, deps: deps({ rejected: ['deepseek', 'cerebras'] }),
  });
  assert.equal(third.provider, 'Gemini');

  // Everything funded is gone → null, never xAI/OpenAI when they are dry.
  const none = await billing.pickFailoverModel({
    fromProvider: 'Anthropic', fromModel: 'claude-fable-5-1', env: envDry,
    deps: deps({ rejected: ['deepseek', 'cerebras', 'gemini'] }),
  });
  assert.equal(none, null);
});

test('source contract: generateStream allows two billing hops, excludes tried providers and keeps the Spanish notice', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'ai-service.js'), 'utf8');
  assert.match(src, /const MAX_BILLING_FAILOVER_HOPS = 2;/);
  assert.match(src, /billingFailoverHops < MAX_BILLING_FAILOVER_HOPS && m === modelChain\.length - 1/);
  assert.match(src, /billingFailoverTried\.add\(currentProvider\);/);
  assert.match(src, /excludeProviders: \[\.\.\.billingFailoverTried\]/);
  assert.match(src, /billingFailoverHops \+= 1;/);
  // The user-facing note keeps the ORIGINAL model as «from» across hops.
  assert.match(src, /fromProvider: billingFailover \? billingFailover\.from\.provider : currentProvider/);
  // A picked model never fails over (#902); only internal unpinned requests
  // walk the ladder, skipping rungs already memoised as unfunded.
  assert.match(src, /const failoverAllowed = !pinnedUser && !isPinnedLocalGenerate\(provider, model\);/);
  assert.match(src, /if \(!failoverAllowed\) continue;/);
  assert.match(src, /!skipUnfunded && attempt <= MAX_ATTEMPTS_PER_MODEL/);
  assert.doesNotMatch(src, /if \(pinnedUser\) continue;/);
  // Every failing rung feeds the memo; the picked model's error carries its cause.
  assert.match(src, /billingFailoverMod\.recordProviderFailure\(currentProvider, lastError, failoverReason\)/);
  assert.match(src, /billingFailoverMod\.annotateProviderFailure\(lastError, \{/);
  assert.equal(billing.buildNotice({ fromLabel: 'Claude Fable 5.1', toLabel: 'DeepSeek V4 Pro' }),
    'Claude Fable 5.1 no está disponible ahora (el proveedor no tiene saldo); respondí con DeepSeek V4 Pro.');
});
