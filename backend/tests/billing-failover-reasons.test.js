'use strict';

/**
 * billing-failover: failure reasons, per-minute memo window, key-health
 * reasons, reason-specific notices, transparent pinned-model errors and the
 * last-resort rungs for internal (unpinned) requests.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const billing = require('../src/services/ai/billing-failover');
const keyHealth = require('../src/utils/provider-key-health');
const { CircuitBreakerError } = require('../src/services/circuit-breaker');

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

test.beforeEach(() => billing.__resetForTests());
test.after(() => billing.__resetForTests());

test('failoverReasonFor: billing, auth, forbidden, breaker, unconfigured and memo skips; throttles and aborts are not reasons', () => {
  const cases = [
    [httpError(403, 'You have used all available credits. Please purchase more to continue.'), 'billing'],
    [httpError(400, 'Your credit balance is too low to access the Anthropic API.'), 'billing'],
    [httpError(402, 'Payment Required'), 'billing'],
    [httpError(429, 'You have no credits remaining. Add credits to continue.'), 'billing'],
    [httpError(429, 'Rate limit reached for requests'), null],
    [httpError(429, 'Resource has been exhausted (e.g. check quota).'), null],
    [httpError(401, 'Incorrect API key provided'), 'auth'],
    [{ message: 'API key not valid. Please pass a valid API key.' }, 'auth'],
    [httpError(403, 'Forbidden: this model is not enabled for your account'), 'forbidden'],
    [new CircuitBreakerError('xAI:grok-4.7', 'OPEN', new Date()), 'breaker'],
    [Object.assign(new Error('Conexión no disponible'), { code: 'PROVIDER_CONNECTION_UNAVAILABLE', status: 503 }), 'unconfigured'],
    [billing.unfundedMemoError('Anthropic'), 'unfunded_memo'],
    [Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }), null],
    [new Error('client aborted'), null],
    [httpError(500, 'Internal server error'), null],
    // OpenRouter reservation larger than the balance: the account still has
    // credit (a tiny allowance is an empty account).
    [httpError(402, 'You requested up to 8192 tokens, but can only afford 5000. To increase, visit https://openrouter.ai/settings/credits'), null],
    [httpError(402, 'This request requires more credits, or fewer max_tokens.'), null],
    [httpError(402, 'You requested up to 2048 tokens, but can only afford 12.'), 'billing'],
    // Real OpenRouter text carries both phrases: the amount decides.
    [httpError(402, 'This request requires more credits, or fewer max_tokens. You requested up to 8192 tokens, but can only afford 12.'), 'billing'],
    [null, null],
  ];
  for (const [err, expected] of cases) {
    assert.equal(billing.failoverReasonFor(err), expected, err ? err.message : 'null');
  }
  const memo = billing.unfundedMemoError('xAI');
  assert.equal(memo.code, billing.UNFUNDED_MEMO_CODE);
  assert.equal(memo.status, 402);
  assert.equal(memo.provider, 'xAI');
});

test('per-minute quota windows get a short memo; explicit credit wording keeps the 10-minute «sin saldo»', () => {
  const perMinute = httpError(429, 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10. Please retry in 29s.');
  assert.equal(billing.isShortQuotaWindow(perMinute), true);
  const ms = billing.quotaWindowMs(perMinute, {});
  assert.ok(ms >= 30_000 && ms <= 120_000, `window ${ms}`);

  // The real Gemini text also says «billing details»: still a per-minute window.
  const gemini = httpError(429, 'You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generate_content_free_tier_requests, limit: 10\nPlease retry in 58.2s.');
  assert.equal(billing.isShortQuotaWindow(gemini), true);
  assert.equal(billing.quotaWindowMs(gemini, {}), 58_200);

  const credit = httpError(400, 'Your credit balance is too low to access the Anthropic API.');
  assert.equal(billing.isShortQuotaWindow(credit), false);
  assert.equal(billing.quotaWindowMs(credit, {}), billing.DEFAULT_MEMO_MS);
  const openaiQuota = httpError(429, 'You exceeded your current quota, please check your plan and billing details.', { code: 'insufficient_quota' });
  assert.equal(billing.quotaWindowMs(openaiQuota, {}), billing.DEFAULT_MEMO_MS);

  // A retry-after header alone is a window; the hint is clamped to [30 s, 120 s].
  const header = httpError(429, 'Quota exceeded', { headers: new Headers({ 'retry-after': '500' }) });
  assert.equal(billing.quotaWindowMs(header, {}), 120_000);
  assert.equal(billing.retryAfterMs(httpError(429, 'Please try again in 1.5s')), 1_500);

  // markOutOfCredit applies the window to both memos. A per-minute window
  // is 'rate_limit': the ladders skip the provider, the picker does not show
  // «Sin saldo».
  const env = { GEMINI_API_KEY: 'g-key' };
  billing.markOutOfCredit('Gemini', perMinute, env);
  assert.equal(billing.isOutOfCredit('Gemini', env), false, 'a per-minute window is not «Sin saldo»');
  assert.equal(billing.outOfCreditCause('Gemini', env), 'rate_limit');
  assert.equal(billing.isUnfunded('Gemini', env), true, 'the ladders still skip it for the window');
  assert.equal(billing.unfundedReason('Gemini', env), 'rate_limit');
  assert.equal(billing.snapshot().gemini.cause, 'rate_limit');
  assert.ok(billing.snapshot().gemini.expiresInMs <= 120_000);
  assert.ok(keyHealth.snapshot().gemini.expiresInMs <= 120_000);
  const wait = billing.memoRetryAfterSeconds('Gemini', env);
  assert.ok(wait >= 29 && wait <= 30, `wait ${wait}`);
  billing.markOutOfCredit('Anthropic', credit, { ANTHROPIC_API_KEY: 'a-key' });
  assert.equal(billing.isOutOfCredit('Anthropic', { ANTHROPIC_API_KEY: 'a-key' }), true);
  assert.equal(billing.outOfCreditCause('Anthropic', { ANTHROPIC_API_KEY: 'a-key' }), 'billing');
  assert.ok(billing.snapshot().anthropic.expiresInMs > 120_000);
  // An explicit ttl still wins.
  billing.markOutOfCredit('xAI', credit, { XAI_API_KEY: 'x-key' }, { ttlMs: 5_000 });
  assert.ok(billing.snapshot().xai.expiresInMs <= 5_000);
});

test('unfundedReason: memo → billing, 401 key health → auth, a generic 403 memo never blocks chat', () => {
  const env = { OPENAI_API_KEY: 'oa-key', ANTHROPIC_API_KEY: 'an-key', XAI_API_KEY: 'x-key' };
  assert.equal(billing.unfundedReason('OpenAI', env), null);

  // Files/embeddings memoise a generic 403 in key health: not an unfunded chat provider.
  keyHealth.markRejected('openai', 'oa-key', httpError(403, 'Forbidden'), env);
  assert.equal(billing.unfundedReason('OpenAI', env), null);
  assert.equal(billing.isUnfunded('OpenAI', env), true, 'isUnfunded keeps its broader meaning');

  keyHealth.markRejected('anthropic', 'an-key', httpError(401, 'invalid x-api-key'), env);
  assert.equal(billing.unfundedReason('Anthropic', env), 'auth');
  assert.equal(billing.unfundedReason('Anthropic', { ...env, ANTHROPIC_API_KEY: 'rotated' }), null, 'a new key re-arms');

  billing.markOutOfCredit('xAI', httpError(403, 'You have used all available credits'), env);
  assert.equal(billing.unfundedReason('xAI', env), 'billing');

  // A billing rejection recorded only in key health counts too.
  keyHealth.markRejected('gemini', 'g-key', httpError(429, 'no credits'), env, { reason: 'billing' });
  assert.equal(billing.unfundedReason('Gemini', { GEMINI_API_KEY: 'g-key' }), 'billing');
});

test('recordProviderFailure: billing → memo + key health, auth → key health only, others are not recorded', () => {
  const env = { XAI_API_KEY: 'x-key', ANTHROPIC_API_KEY: 'an-key', OPENAI_API_KEY: 'oa-key' };
  assert.equal(billing.recordProviderFailure('xAI', httpError(403, 'You have used all available credits'), undefined, env), 'billing');
  assert.equal(billing.isOutOfCredit('xAI', env), true);
  assert.equal(keyHealth.rejectionReason('xai', 'x-key'), 'billing');

  assert.equal(billing.recordProviderFailure('Anthropic', httpError(401, 'invalid x-api-key'), undefined, env), 'auth');
  assert.equal(billing.isOutOfCredit('Anthropic', env), false, 'a rejected key is not «sin saldo»');
  assert.equal(keyHealth.rejectionReason('anthropic', 'an-key'), 'auth');
  assert.equal(keyHealth.rejectionStatus('anthropic', 'an-key'), 401);

  // Breakers, 403s, missing connections and memo skips leave no trace.
  assert.equal(billing.recordProviderFailure('OpenAI', new CircuitBreakerError('OpenAI:gpt', 'OPEN', new Date()), undefined, env), null);
  assert.equal(billing.recordProviderFailure('OpenAI', httpError(403, 'Forbidden: model not enabled'), undefined, env), null);
  assert.equal(billing.recordProviderFailure('OpenAI', billing.unfundedMemoError('OpenAI'), undefined, env), null);
  assert.equal(keyHealth.isRejected('openai', 'oa-key'), false);
  assert.equal(billing.isOutOfCredit('OpenAI', env), false);

  // No key → no key-health entry; local/custom providers are never recorded.
  assert.equal(billing.recordProviderFailure('Groq', httpError(401, 'Invalid API Key'), undefined, {}), null);
  assert.equal(billing.recordProviderFailure('Custom', httpError(402, 'Payment Required'), undefined, env), null);
  assert.equal(billing.isOutOfCredit('Custom', env), false);
  // Never throws.
  assert.doesNotThrow(() => billing.recordProviderFailure(null, null));
});

test('noteProviderAnswered: an answer clears a stale «sin saldo» / per-minute memo, never an auth rejection', () => {
  const env = { ANTHROPIC_API_KEY: 'an-key', GEMINI_API_KEY: 'g-key', OPENAI_API_KEY: 'oa-key' };
  billing.markOutOfCredit('Anthropic', httpError(400, 'Your credit balance is too low'), env);
  assert.equal(billing.noteProviderAnswered('Anthropic', env), true);
  assert.equal(billing.isOutOfCredit('Anthropic', env), false);
  assert.equal(keyHealth.isRejected('anthropic', 'an-key'), false, 'its billing key-health entry goes too');

  billing.markOutOfCredit('Gemini', httpError(429, 'Quota exceeded for metric: x. Please retry in 29s.'), env);
  assert.equal(billing.noteProviderAnswered('Gemini', env), true);
  assert.equal(billing.outOfCreditCause('Gemini', env), null);

  // Nothing memoised → no-op (no cache churn); an auth rejection stays.
  keyHealth.markRejected('openai', 'oa-key', httpError(401, 'Incorrect API key provided'), env, { reason: 'auth' });
  assert.equal(billing.noteProviderAnswered('OpenAI', env), false);
  assert.equal(keyHealth.rejectionReason('openai', 'oa-key'), 'auth');
  assert.doesNotThrow(() => billing.noteProviderAnswered(null));
});

test('annotateProviderFailure: an OPEN breaker over a memoised provider reports the memo cause', () => {
  const { CircuitBreakerError: CBE } = require('../src/services/circuit-breaker');
  const env = { OPENAI_API_KEY: 'oa-key', GEMINI_API_KEY: 'g-key', XAI_API_KEY: 'x-key' };
  billing.markOutOfCredit('OpenAI', httpError(429, 'You exceeded your current quota', { code: 'insufficient_quota' }), env);
  const dry = billing.annotateProviderFailure(new CBE('OpenAI:gpt-6-sol', 'OPEN', new Date()), { provider: 'OpenAI', model: 'gpt-6-sol', env });
  assert.equal(dry.siraFailureReason, 'billing');

  billing.markOutOfCredit('Gemini', httpError(429, 'Quota exceeded for metric: x. Please retry in 40s.'), env);
  const limited = billing.annotateProviderFailure(new CBE('Gemini:gemini-3.8-flash', 'OPEN', new Date()), { provider: 'Gemini', model: 'gemini-3.8-flash', env });
  assert.equal(limited.siraFailureReason, 'rate_limit');
  assert.ok(limited.siraRetryAfterSeconds >= 39 && limited.siraRetryAfterSeconds <= 40, `wait ${limited.siraRetryAfterSeconds}`);

  const down = billing.annotateProviderFailure(new CBE('xAI:grok-4.7', 'OPEN', new Date()), { provider: 'xAI', model: 'grok-4.7', env });
  assert.equal(down.siraFailureReason, 'breaker', 'no memo: the provider is not responding');
});

test('publicModelLabel: known display names only — the catalog by exact id, never a legacy alias or a raw id', () => {
  assert.equal(billing.publicModelLabel('deepseek-v4-flash', 'DeepSeek'), 'DeepSeek V4 Flash');
  assert.equal(billing.publicModelLabel('gpt-4o-mini', 'OpenAI'), 'GPT-4o Mini');
  assert.equal(billing.publicModelLabel('gemini-2.5-flash', 'Gemini'), 'Gemini 2.5 Flash');
  assert.equal(billing.publicModelLabel('gpt-5', 'OpenAI'), '', 'gpt-5 is only an alias of GPT 5.5');
  assert.equal(billing.publicModelLabel('gpt-oss-120b', 'Cerebras'), '');
  assert.equal(billing.publicModelLabel('', 'OpenAI'), '');
});

test('buildNotice names the real cause; the default stays byte-identical', () => {
  assert.equal(
    billing.buildNotice({ fromLabel: 'Claude Fable 5.1', toLabel: 'DeepSeek V4 Pro' }),
    'Claude Fable 5.1 no está disponible ahora (el proveedor no tiene saldo); respondí con DeepSeek V4 Pro.',
  );
  const expected = {
    billing: 'el proveedor no tiene saldo',
    unfunded_memo: 'el proveedor no tiene saldo',
    auth: 'el proveedor rechazó la conexión',
    breaker: 'el proveedor no está respondiendo',
    forbidden: 'el proveedor no permite este modelo ahora',
    unconfigured: 'su conexión no está configurada',
    rate_limit: 'el proveedor alcanzó su límite de solicitudes por minuto',
    unavailable: 'el proveedor no está respondiendo',
  };
  for (const [reason, cause] of Object.entries(expected)) {
    assert.equal(
      billing.buildNotice({ fromLabel: 'Grok 4.7', toLabel: 'DeepSeek V4 Flash', reason }),
      `Grok 4.7 no está disponible ahora (${cause}); respondí con DeepSeek V4 Flash.`,
    );
  }
});

test('pinned-model transparency: cause, provider, display name and wait seconds; Spanish copy without raw ids', () => {
  const perMinute = billing.annotateProviderFailure(
    httpError(429, 'Quota exceeded for metric: requests per minute. Please retry in 29.3s.'),
    { provider: 'Gemini', model: 'gemini-3.8-flash' },
  );
  assert.equal(perMinute.siraFailureReason, 'rate_limit', 'a per-minute window is a limit, not «sin saldo»');
  assert.equal(perMinute.siraProvider, 'Gemini');
  assert.equal(perMinute.siraRetryAfterSeconds, 30);
  assert.equal(perMinute.siraModelLabel, undefined, 'no display name without the catalog row — never the raw id');

  const flash = billing.annotateProviderFailure(httpError(402, 'Insufficient Balance'), { provider: 'DeepSeek', model: 'deepseek-v4-flash' });
  assert.equal(flash.siraFailureReason, 'billing');
  assert.equal(flash.siraModelLabel, 'DeepSeek V4 Flash');

  assert.equal(billing.failureCauseFor(httpError(401, 'Incorrect API key provided')), 'auth');
  assert.equal(billing.failureCauseFor(new CircuitBreakerError('x', 'OPEN', new Date())), 'breaker');
  assert.equal(billing.failureCauseFor(httpError(429, 'Rate limit reached for requests')), 'rate_limit');
  assert.equal(billing.failureCauseFor(httpError(503, 'Service unavailable')), 'unavailable');
  assert.equal(billing.failureCauseFor(billing.unfundedMemoError('xAI')), 'billing');
  assert.equal(billing.failureCauseFor(httpError(400, 'Unknown parameter: reasoning')), null);
  assert.equal(billing.failureCauseFor(Object.assign(new Error('aborted'), { name: 'AbortError' })), null);
  // An explicit reason (our first-byte timeout) wins; annotating twice keeps the first cause.
  const timeout = billing.annotateProviderFailure(new Error('Request was aborted.'), { provider: 'xAI', reason: 'unavailable' });
  assert.equal(timeout.siraFailureReason, 'unavailable');
  billing.annotateProviderFailure(timeout, { reason: 'billing' });
  assert.equal(timeout.siraFailureReason, 'unavailable');

  const messages = {
    billing: /DeepSeek V4 Flash no pudo responder: su proveedor no tiene saldo ahora\. No cambié de modelo/,
    auth: /rechazó la clave de conexión\. No cambié de modelo/,
    breaker: /no está respondiendo ahora/,
    unavailable: /no está respondiendo ahora/,
    forbidden: /no permite usar este modelo ahora/,
    unconfigured: /su conexión no está configurada/,
  };
  for (const [reason, re] of Object.entries(messages)) {
    const text = billing.buildFailureMessage({ modelLabel: 'DeepSeek V4 Flash', reason });
    assert.match(text, re, reason);
    assert.doesNotMatch(text, /OpenRouter|deepseek-v4|sk-/, reason);
  }
  assert.match(
    billing.buildFailureMessage({ modelLabel: 'Grok 4.7', reason: 'rate_limit', retryAfterSeconds: 29 }),
    /^Grok 4\.7 no pudo responder: su proveedor alcanzó el límite de solicitudes por minuto\. Espera 29 s y vuelve a intentarlo\. No cambié de modelo\.$/,
  );
  assert.match(billing.buildFailureMessage({ reason: 'billing' }), /^El modelo elegido no pudo responder/);
  assert.equal(billing.buildFailureMessage({ reason: null }), null);
});

test('a reservation larger than the balance is its own cause: annotated and worded, never «reconecta el proveedor»', () => {
  const err = billing.annotateProviderFailure(
    httpError(402, 'This request requires more credits, or fewer max_tokens. You requested up to 16384 tokens, but can only afford 5000.'),
    { provider: 'OpenRouter', model: 'deepseek/deepseek-v4-pro' },
  );
  assert.equal(err.siraFailureReason, 'reservation');
  assert.equal(billing.isOutOfCredit('OpenRouter'), false, 'the account still has credit');
  const text = billing.buildFailureMessage({ modelLabel: 'DeepSeek V4 Pro', reason: 'reservation' });
  assert.match(text, /^DeepSeek V4 Pro no pudo responder: su proveedor no tiene saldo suficiente para una respuesta de este tamaño\. No cambié de modelo/);
  assert.doesNotMatch(text, /OpenRouter|reconecta|Ajustes/);
  // A near-empty account (can only afford 12) is plain «sin saldo».
  const dry = billing.annotateProviderFailure(
    httpError(402, 'This request requires more credits, or fewer max_tokens. You requested up to 16384 tokens, but can only afford 12.'),
    { provider: 'OpenRouter', model: 'deepseek/deepseek-v4-pro' },
  );
  assert.equal(dry.siraFailureReason, 'billing');
});

function lastResortDeps({ findManyThrows = false, rows = [], rejected = [], notReady = [] } = {}) {
  return {
    prisma: { aiModel: { findMany: async () => { if (findManyThrows) throw new Error('db down'); return rows; } } },
    catalog: { curateVisibleTextModels: (list) => list },
    inference: { resolveGenerateProvider: (p) => p, providerConnectionReady: (p) => !notReady.includes(p) },
    keyHealth: { isRejected: (p) => rejected.includes(String(p).toLowerCase()) },
    capabilities: { resolveModelCapabilities: () => ({ supportsImages: false }) },
  };
}

test('last resort for internal requests: DeepSeek V4 Flash, then its second transport, Gemini for images; kill switch and no keys → null', async () => {
  const env = { DEEPSEEK_API_KEY: 'ds-key', OPENROUTER_API_KEY: 'or-key', GEMINI_API_KEY: 'g-key' };
  const base = { fromProvider: 'xAI', fromModel: 'grok-4.7' };

  const dbDown = await billing.pickFailoverModel({ ...base, env, deps: lastResortDeps({ findManyThrows: true }) });
  assert.deepEqual(
    { provider: dbDown.provider, model: dbDown.model, label: dbDown.label },
    { provider: 'DeepSeek', model: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  );

  // No funded candidate in the picker list either.
  const emptyList = await billing.pickFailoverModel({ ...base, env, deps: lastResortDeps({ rows: [] }) });
  assert.equal(emptyList.model, 'deepseek-v4-flash');

  const noDirect = await billing.pickFailoverModel({ ...base, env, excludeProviders: ['DeepSeek'], deps: lastResortDeps({ findManyThrows: true }) });
  assert.equal(noDirect.provider, 'OpenRouter');
  assert.equal(noDirect.model, 'deepseek/deepseek-v4-flash');
  assert.equal(noDirect.label, 'DeepSeek V4 Flash', 'the user sees the model, never the transport');

  const vision = await billing.pickFailoverModel({ ...base, env, needsVision: true, deps: lastResortDeps({ findManyThrows: true }) });
  assert.equal(vision.provider, 'Gemini');
  assert.equal(vision.model, 'gemini-2.5-flash');

  // Unfunded / rejected / not ready rungs are skipped.
  billing.markOutOfCredit('DeepSeek', httpError(402, 'Insufficient Balance'), env);
  const skipDry = await billing.pickFailoverModel({ ...base, env, deps: lastResortDeps({ findManyThrows: true, rejected: ['openrouter'] }) });
  assert.equal(skipDry.provider, 'Gemini', 'DeepSeek dry and its second transport rejected → Gemini');
  assert.equal(skipDry.fromLabel, '', 'no display name without the picker row — never the raw id');
  assert.equal(
    await billing.pickFailoverModel({ ...base, env, deps: lastResortDeps({ findManyThrows: true, rejected: ['openrouter', 'gemini'] }) }),
    null,
  );
  billing.__resetForTests();
  const notReady = await billing.pickFailoverModel({ ...base, env, deps: lastResortDeps({ findManyThrows: true, notReady: ['DeepSeek', 'OpenRouter', 'Gemini'] }) });
  assert.equal(notReady, null);

  assert.equal(await billing.pickFailoverModel({ ...base, env: {}, deps: lastResortDeps({ findManyThrows: true }) }), null, 'no keys → null');
  assert.equal(
    await billing.pickFailoverModel({ ...base, env: { ...env, SIRAGPT_BILLING_FAILOVER_LAST_RESORT: '0' }, deps: lastResortDeps({ findManyThrows: true }) }),
    null,
    'kill switch',
  );
  assert.equal(
    await billing.pickFailoverModel({ ...base, env: { ...env, SIRAGPT_BILLING_FAILOVER: '0' }, deps: lastResortDeps({ findManyThrows: true }) }),
    null,
    'global kill switch',
  );
});

test('providerOrder is exported and honours SIRAGPT_BILLING_FAILOVER_ORDER', () => {
  assert.equal(billing.providerOrder({})[0], 'deepseek');
  assert.deepEqual(billing.providerOrder({ SIRAGPT_BILLING_FAILOVER_ORDER: 'Grok, Google' }), ['xai', 'gemini']);
});
