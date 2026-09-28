'use strict';

/**
 * generateStream provider failures (owner policy, confirmed 2026-09-28):
 * - A model picked by the user never switches provider (nor walks the other
 *   vision runtimes on a provider-level failure). Its failure feeds the memo
 *   (no credit → «sin saldo», 401 → rejected key) and the user is told
 *   exactly what happened, in Spanish: which model and which cause, with the
 *   wait in seconds for a per-minute limit.
 * - A caller-side 4xx (no credit, rejected key, per-minute limit) never trips
 *   the breaker, so the cause stays true turn after turn.
 * - Internal requests without a picked model walk the #915 ladder. In
 *   production that path is dormant for the chat (every picker model is
 *   pinned, and the payload builder rejects an empty model id); the tests
 *   below default the id at the builder so it can still run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// Dormant-path harness: default an empty model id at the payload builder —
// before ai-service captures it — so the internal-request ladder can run.
const gateway = require('../src/services/ai-product-os/litellm-gateway');
const realBuildPayload = gateway.buildProviderChatPayload;
gateway.buildProviderChatPayload = (args = {}) => realBuildPayload({ ...args, model: args.model || 'internal-default' });

const billing = require('../src/services/ai/billing-failover');
const keyHealth = require('../src/utils/provider-key-health');
const { getBreaker, resetAll, STATES } = require('../src/services/circuit-breaker');

const ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'SIRA_ANTHROPIC_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'FALLBACK_MODELS', 'SIRAGPT_BILLING_FAILOVER',
  'MODEL_API_KEY', 'META_API_KEY', 'LLAMA_API_KEY',
];
let savedEnv = {};

test.beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  // Deterministic chain: no env fallbacks, no second DeepSeek transport.
  for (const k of ENV_KEYS) delete process.env[k];
  billing.__resetForTests();
  resetAll();
});

test.afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  billing.__resetForTests();
  resetAll();
});

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

function streamOf(text) {
  const parts = String(text).match(/.{1,6}/gs) || [];
  return {
    async *[Symbol.asyncIterator]() {
      for (const p of parts) yield { choices: [{ delta: { content: p } }] };
    },
  };
}

const TAIL = 'No cambié de modelo; elige otro en el selector o inténtalo más tarde.';

async function runGenerate({
  provider = 'Anthropic',
  model = 'claude-fable-5-1',
  primaryError,
  primaryCreate = null,
  pick = null,
  getClient = null,
  modelLabel = undefined,
  files = undefined,
  signal = undefined,
}) {
  const service = require('../src/services/ai-service');
  const originalGetClient = service.getClient;
  const originalPick = billing.pickFailoverModel;
  const originalPrepare = service.prepareImageForVision;
  const frames = [];
  const failovers = [];
  const failures = [];
  let pickCalls = 0;
  let primaryCalls = 0;
  const clientCalls = [];
  service.getClient = getClient || ((p) => { clientCalls.push(p); throw httpError(503, 'unexpected provider'); });
  service.prepareImageForVision = async () => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } });
  billing.pickFailoverModel = async (args) => { pickCalls++; return typeof pick === 'function' ? pick(args) : pick; };
  const primary = {
    chat: {
      completions: {
        create: async (...args) => {
          primaryCalls++;
          if (primaryCreate) return primaryCreate(...args);
          throw primaryError;
        },
      },
    },
  };
  try {
    const out = await service.generateStream({
      provider,
      model,
      client: primary,
      messages: [{ role: 'user', content: '¿Cuánto es 2 + 2?' }],
      res: { write: (chunk) => { frames.push(String(chunk)); return true; } },
      qualityGuard: false,
      skipDoneSentinel: true,
      onModelFailover: (info) => failovers.push(info),
      onProviderFailure: (info) => failures.push(info),
      ...(modelLabel !== undefined ? { modelLabel } : {}),
      ...(files ? { files } : {}),
      ...(signal ? { signal } : {}),
    });
    return { out, frames: frames.join('\n'), failovers, failures, pickCalls, primaryCalls, clientCalls };
  } finally {
    service.getClient = originalGetClient;
    service.prepareImageForVision = originalPrepare;
    billing.pickFailoverModel = originalPick;
  }
}

function errorFrame(frames) {
  for (const line of String(frames).split('\n')) {
    const m = /^data: (\{.*\})$/.exec(line.trim());
    if (!m) continue;
    try {
      const frame = JSON.parse(m[1]);
      if (frame && frame.type === 'error') return frame;
    } catch (_) { /* not JSON */ }
  }
  return null;
}

test('picked Claude with no credit: E_PROVIDER, no search for another model, «sin saldo» memo and the exact cause for the user', async () => {
  process.env.ANTHROPIC_API_KEY = 'an-test-key';
  const r = await runGenerate({
    primaryError: httpError(400, 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'),
    pick: { provider: 'xAI', model: 'grok-4.7', label: 'Grok 4.7', fromLabel: 'Claude Fable 5.1' },
    modelLabel: 'Claude Fable 5.1',
  });
  assert.equal(r.pickCalls, 0);
  assert.equal(r.primaryCalls, 1, 'a no-credit 400 is not retried');
  const expected = `Claude Fable 5.1 no pudo responder: su proveedor no tiene saldo ahora. ${TAIL}`;
  assert.equal(r.out, expected);
  const frame = errorFrame(r.frames);
  assert.equal(frame.code, 'E_PROVIDER');
  assert.equal(frame.message, expected);
  assert.doesNotMatch(r.frames, /model_failover|respondí con|credit balance|claude-fable/);
  assert.equal(r.failovers.length, 0);
  assert.equal(billing.isOutOfCredit('Anthropic'), true);
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].failureReason, 'billing');
  assert.equal(r.failures[0].failureProvider, 'Anthropic');
});

test('without the picker label the message still names the cause («El modelo elegido»), a known display name when there is one', async () => {
  process.env.ANTHROPIC_API_KEY = 'an-test-key';
  const r = await runGenerate({ primaryError: httpError(402, 'Insufficient credits') });
  assert.equal(r.out, `El modelo elegido no pudo responder: su proveedor no tiene saldo ahora. ${TAIL}`);

  process.env.DEEPSEEK_API_KEY = 'ds-test-key';
  const ds = await runGenerate({ provider: 'DeepSeek', model: 'deepseek-v4-flash', primaryError: httpError(402, 'Insufficient Balance') });
  assert.equal(ds.out, `DeepSeek V4 Flash no pudo responder: su proveedor no tiene saldo ahora. ${TAIL}`);
  assert.doesNotMatch(ds.frames, /deepseek-v4-flash|OpenRouter/);
});

test('picked model with a rejected key (401): key-health «auth», no failover, the user reads «rechazó la clave»', async () => {
  process.env.ANTHROPIC_API_KEY = 'an-dead-key';
  const r = await runGenerate({
    primaryError: httpError(401, 'invalid x-api-key'),
    pick: { provider: 'xAI', model: 'grok-4.7', label: 'Grok 4.7', fromLabel: 'Claude Fable 5.1' },
    modelLabel: 'Claude Fable 5.1',
  });
  assert.equal(r.pickCalls, 0);
  assert.equal(r.primaryCalls, 1);
  assert.equal(keyHealth.rejectionReason('anthropic', 'an-dead-key'), 'auth');
  assert.equal(billing.isOutOfCredit('Anthropic'), false);
  assert.equal(r.failures[0].failureReason, 'auth');
  const frame = errorFrame(r.frames);
  assert.equal(frame.code, 'E_PROVIDER');
  assert.equal(frame.message, `Claude Fable 5.1 no pudo responder: su proveedor rechazó la clave de conexión. ${TAIL}`);
});

test('modelLabel as a getter: called only on failure (never on the first-byte path), bounded when slow', async () => {
  process.env.ANTHROPIC_API_KEY = 'an-test-key';
  let calls = 0;
  const r = await runGenerate({
    primaryError: httpError(402, 'Insufficient credits'),
    modelLabel: () => { calls++; return Promise.resolve('Claude Fable 5.1'); },
  });
  assert.equal(calls, 1);
  assert.equal(r.out, `Claude Fable 5.1 no pudo responder: su proveedor no tiene saldo ahora. ${TAIL}`);

  let okCalls = 0;
  const ok = await runGenerate({
    primaryCreate: async () => streamOf('4'),
    modelLabel: () => { okCalls++; return 'Claude Fable 5.1'; },
  });
  assert.match(ok.out, /4/);
  assert.equal(okCalls, 0, 'a turn that answers never resolves the label');

  // A lookup that never settles cannot hold the error: generic subject.
  billing.__resetForTests();
  const started = Date.now();
  const slow = await runGenerate({
    primaryError: httpError(402, 'Insufficient credits'),
    modelLabel: () => new Promise(() => {}),
  });
  assert.ok(Date.now() - started < 3000);
  assert.equal(slow.out, `El modelo elegido no pudo responder: su proveedor no tiene saldo ahora. ${TAIL}`);
});

test('picked model already memoised «sin saldo» is still called (never skipped or swapped); its answer clears the memo', async () => {
  process.env.ANTHROPIC_API_KEY = 'an-test-key';
  billing.markOutOfCredit('Anthropic', httpError(402, 'Insufficient credits'));
  const r = await runGenerate({ primaryError: httpError(402, 'Insufficient credits'), pick: { provider: 'xAI', model: 'grok-4.7', label: 'Grok 4.7' } });
  assert.equal(r.primaryCalls, 1);
  assert.equal(r.pickCalls, 0);
  assert.equal(r.failures[0].failureReason, 'billing');
  assert.equal(billing.isOutOfCredit('Anthropic'), true);

  // A top-up: the picked model answers again → «Sin saldo» disappears at once.
  const ok = await runGenerate({ primaryCreate: async () => streamOf('2 + 2 = 4.') });
  assert.equal(ok.out, '2 + 2 = 4.');
  assert.equal(billing.isOutOfCredit('Anthropic'), false);
  assert.equal(keyHealth.isRejected('anthropic', 'an-test-key'), false);
});

test('picked model behind an OPEN breaker: no call, no memo, the user reads «no está respondiendo»', async () => {
  process.env.ANTHROPIC_API_KEY = 'an-test-key';
  const breaker = getBreaker('Anthropic:claude-fable-5-1', { failureThreshold: 5, resetTimeoutMs: 60_000 });
  breaker.state = STATES.OPEN;
  breaker.lastFailureAt = new Date();
  const r = await runGenerate({
    primaryError: httpError(500, 'must not be called'),
    pick: { provider: 'xAI', model: 'grok-4.7', label: 'Grok 4.7' },
    modelLabel: 'Claude Fable 5.1',
  });
  assert.equal(r.primaryCalls, 0);
  assert.equal(r.pickCalls, 0);
  assert.equal(billing.isOutOfCredit('Anthropic'), false);
  assert.equal(keyHealth.isRejected('anthropic', 'an-test-key'), false);
  assert.equal(r.failures[0].failureReason, 'breaker');
  assert.equal(errorFrame(r.frames).message, `Claude Fable 5.1 no pudo responder: su proveedor no está respondiendo ahora. ${TAIL}`);
});

test('six pinned no-credit / rejected-key / per-minute turns in a row: the breaker stays CLOSED and the cause stays true', async () => {
  process.env.OPENAI_API_KEY = 'oa-test-key';
  const quota = () => httpError(429, 'You exceeded your current quota, please check your plan and billing details.', { code: 'insufficient_quota', type: 'insufficient_quota' });
  for (let i = 1; i <= 6; i++) {
    const r = await runGenerate({ provider: 'OpenAI', model: 'gpt-6-sol', primaryError: quota() });
    assert.equal(r.primaryCalls, 1, `turn ${i}: the provider is called`);
    assert.equal(r.failures[0].failureReason, 'billing', `turn ${i}`);
  }
  assert.equal(getBreaker('OpenAI:gpt-6-sol').state, STATES.CLOSED);

  process.env.ANTHROPIC_API_KEY = 'an-test-key';
  for (let i = 1; i <= 6; i++) {
    const r = await runGenerate({ primaryError: httpError(402, 'Insufficient credits') });
    assert.equal(r.primaryCalls, 1, `402 turn ${i}`);
    assert.equal(r.failures[0].failureReason, 'billing');
  }
  process.env.XAI_API_KEY = 'xai-test-key';
  for (let i = 1; i <= 6; i++) {
    const r = await runGenerate({ provider: 'xAI', model: 'grok-4.7', primaryError: httpError(401, 'Incorrect API key provided') });
    assert.equal(r.primaryCalls, 1, `401 turn ${i}`);
    assert.equal(r.failures[0].failureReason, 'auth');
  }
  process.env.GEMINI_API_KEY = 'g-test-key';
  for (let i = 1; i <= 6; i++) {
    const r = await runGenerate({ provider: 'Gemini', model: 'gemini-3.8-flash', primaryError: httpError(429, 'Rate limit reached for requests. Please try again in 20s.') });
    assert.ok(r.primaryCalls >= 1, `429 turn ${i}`);
    assert.equal(r.failures[0].failureReason, 'rate_limit', `429 turn ${i}`);
    assert.equal(r.failures[0].retryAfterSeconds, 20);
  }
  for (const name of ['Anthropic:claude-fable-5-1', 'xAI:grok-4.7', 'Gemini:gemini-3.8-flash']) {
    assert.equal(getBreaker(name).state, STATES.CLOSED, name);
    assert.equal(getBreaker(name).failureCount, 0, name);
  }
});

test('the user Stop is neutral for the breaker: it neither counts nor drains earlier failures', async () => {
  process.env.ANTHROPIC_API_KEY = 'an-test-key';
  await runGenerate({ primaryError: httpError(503, 'Service unavailable') });
  const breaker = getBreaker('Anthropic:claude-fable-5-1');
  const before = breaker.failureCount;
  assert.ok(before >= 1, 'a 503 is a provider fault');
  const ctrl = new AbortController();
  await runGenerate({
    signal: ctrl.signal,
    primaryCreate: async () => { ctrl.abort(); throw Object.assign(new Error('Request was aborted.'), { name: 'AbortError' }); },
  });
  assert.equal(breaker.failureCount, before);
  assert.equal(breaker.state, STATES.CLOSED);
});

test('SiraGPT Mini / Custom never fail over and never feed the memo', async () => {
  const r = await runGenerate({
    provider: 'Custom',
    model: 'sira-mini',
    primaryError: httpError(402, 'Payment Required'),
    pick: { provider: 'DeepSeek', model: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  });
  assert.equal(r.pickCalls, 0);
  assert.equal(r.failovers.length, 0);
  assert.equal(billing.isOutOfCredit('Custom'), false);
});

test('429 «You have no credits remaining» is called exactly once (not retried as a rate limit)', async () => {
  process.env.ANTHROPIC_API_KEY = 'an-test-key';
  const r = await runGenerate({ primaryError: httpError(429, 'You have no credits remaining. Add credits to continue.') });
  assert.equal(r.primaryCalls, 1);
  assert.equal(billing.isOutOfCredit('Anthropic'), true);
  assert.equal(r.failures[0].failureReason, 'billing');
});

test('Gemini per-minute quota (real text): called once, short memo that is not «Sin saldo», the user reads the limit and the wait', async () => {
  process.env.GEMINI_API_KEY = 'g-test-key';
  const r = await runGenerate({
    provider: 'Gemini',
    model: 'gemini-3.8-flash',
    modelLabel: 'Gemini 3.8 Flash',
    primaryError: httpError(429, 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.8-flash\nPlease retry in 29s.'),
  });
  // «exceeded your current quota» is quota_exhausted for the gateway: a
  // retry 400 ms later cannot beat a 29 s window.
  assert.equal(r.primaryCalls, 1);
  assert.equal(billing.isOutOfCredit('Gemini'), false, 'the picker does not show «Sin saldo» for a per-minute window');
  assert.equal(billing.outOfCreditCause('Gemini'), 'rate_limit');
  assert.ok(billing.snapshot().gemini.expiresInMs <= 120_000, `memo ${billing.snapshot().gemini.expiresInMs}`);
  assert.equal(r.failures[0].failureReason, 'rate_limit');
  assert.equal(r.failures[0].retryAfterSeconds, 29);
  assert.equal(
    errorFrame(r.frames).message,
    'Gemini 3.8 Flash no pudo responder: su proveedor alcanzó el límite de solicitudes por minuto. Espera 29 s y vuelve a intentarlo. No cambié de modelo.',
  );
  assert.doesNotMatch(r.frames, /generativelanguage|free_tier/);
});

test('plain rate limit on a picked model: retried once, no memo, cause «rate_limit» with the provider wait', async () => {
  process.env.ANTHROPIC_API_KEY = 'an-test-key';
  const r = await runGenerate({ primaryError: httpError(429, 'Rate limit reached for requests. Please try again in 20s.') });
  assert.equal(r.primaryCalls, 2);
  assert.equal(r.pickCalls, 0);
  assert.equal(billing.isOutOfCredit('Anthropic'), false);
  assert.equal(r.failures[0].failureReason, 'rate_limit');
  assert.equal(r.failures[0].retryAfterSeconds, 20);
  assert.match(errorFrame(r.frames).message, /límite de solicitudes por minuto\. Espera 20 s y vuelve a intentarlo\. No cambié de modelo\.$/);
});

const IMAGE_FILES = [{ path: '/tmp/sira-test-image.png', mimeType: 'image/png', name: 'foto.png' }];

test('pinned image turn: a vision-capable pick with no credit keeps its provider — the other vision runtimes are not called', async () => {
  process.env.XAI_API_KEY = 'xai-test-key';
  process.env.GEMINI_API_KEY = 'g-test-key';
  const r = await runGenerate({
    provider: 'xAI',
    model: 'grok-4.7',
    modelLabel: 'Grok 4.7',
    files: IMAGE_FILES,
    primaryError: httpError(403, 'You have used all available credits. Please purchase more to continue.'),
  });
  assert.equal(r.primaryCalls, 1);
  assert.deepEqual(r.clientCalls, [], 'no vision fallback (Gemini / another Grok) was called');
  assert.equal(billing.isOutOfCredit('xAI'), true);
  assert.equal(r.failures[0].failureReason, 'billing');
  assert.equal(r.failures[0].failureProvider, 'xAI');
  assert.equal(errorFrame(r.frames).message, `Grok 4.7 no pudo responder: su proveedor no tiene saldo ahora. ${TAIL}`);
});

test('pinned image turn: an image-specific rejection still walks the other vision runtimes', async () => {
  process.env.XAI_API_KEY = 'xai-test-key';
  process.env.GEMINI_API_KEY = 'g-test-key';
  const seen = [];
  const r = await runGenerate({
    provider: 'xAI',
    model: 'grok-4.7',
    files: IMAGE_FILES,
    primaryError: httpError(400, 'Invalid image: unsupported image format'),
    getClient: (p) => { seen.push(p); return { chat: { completions: { create: async () => streamOf('Veo un gato.') } } }; },
  });
  assert.equal(r.primaryCalls, 1);
  assert.deepEqual(seen, ['Gemini']);
  assert.equal(r.out, 'Veo un gato.');
});

// ── Internal requests without a picked model (dormant path for the chat) ──

test('internal request (no picked model) with nothing funded: honest Spanish error, no raw provider text', async () => {
  process.env.XAI_API_KEY = 'xai-test-key';
  const r = await runGenerate({
    provider: 'xAI',
    model: '',
    primaryError: httpError(402, 'Insufficient Balance: your team sk-live-xyz has no prepaid credits'),
    pick: null,
  });
  assert.equal(r.pickCalls, 1);
  assert.match(r.frames, /Ningún modelo con saldo pudo responder ahora/);
  assert.match(r.frames, /"code":"E_PROVIDER"/);
  assert.doesNotMatch(r.frames, /Insufficient Balance|sk-live|prepaid/);
  assert.equal(billing.isOutOfCredit('xAI'), true);
});

test('internal request fails over with a notice naming the cause before the first token', async () => {
  process.env.XAI_API_KEY = 'xai-test-key';
  const seen = [];
  const r = await runGenerate({
    provider: 'xAI',
    model: '',
    primaryError: httpError(403, 'You have used all available credits.'),
    pick: { provider: 'Gemini', model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', fromLabel: '' },
    getClient: (p) => { seen.push(p); return { chat: { completions: { create: async () => streamOf('2 + 2 = 4.') } } }; },
  });
  assert.deepEqual(seen, ['Gemini']);
  assert.match(r.out, /^_El modelo elegido no está disponible ahora \(el proveedor no tiene saldo\); respondí con Gemini 2\.5 Flash\._\n\n2 \+ 2 = 4\.$/);
  assert.equal(r.failovers.length, 1);
  assert.equal(r.failovers[0].reason, 'billing');
  const failoverAt = r.frames.indexOf('"type":"model_failover"');
  const answerAt = r.frames.indexOf('2 + 2');
  assert.ok(failoverAt !== -1 && failoverAt < answerAt, 'notice frame before the first token');
  assert.match(r.frames, /"reason":"billing"/);
});

test('internal request skips a memoised unfunded rung without calling it (memo not refreshed)', async () => {
  process.env.XAI_API_KEY = 'xai-test-key';
  billing.markOutOfCredit('xAI', httpError(403, 'You have used all available credits.'));
  const since = billing.snapshot().xai.since;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const r = await runGenerate({
    provider: 'xAI',
    model: '',
    primaryError: httpError(500, 'must not be called'),
    pick: { provider: 'Gemini', model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', fromLabel: '' },
    getClient: () => ({ chat: { completions: { create: async () => streamOf('Hola.') } } }),
  });
  assert.equal(r.primaryCalls, 0);
  assert.equal(r.pickCalls, 1);
  assert.equal(billing.snapshot().xai.since, since);
  assert.equal(r.failovers[0].reason, 'billing');
  assert.match(r.out, /Hola\.$/);
});

test('internal request behind an OPEN breaker fails over saying the provider is not responding; no memo', async () => {
  process.env.XAI_API_KEY = 'xai-test-key';
  const breaker = getBreaker('xAI:', { failureThreshold: 5, resetTimeoutMs: 60_000 });
  breaker.state = STATES.OPEN;
  breaker.lastFailureAt = new Date();
  const r = await runGenerate({
    provider: 'xAI',
    model: '',
    primaryError: httpError(500, 'must not be called'),
    pick: { provider: 'Gemini', model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', fromLabel: '' },
    getClient: () => ({ chat: { completions: { create: async () => streamOf('Listo.') } } }),
  });
  assert.equal(r.primaryCalls, 0);
  assert.match(r.out, /el proveedor no está respondiendo/);
  assert.equal(r.failovers[0].reason, 'breaker');
  assert.equal(billing.isOutOfCredit('xAI'), false);
  assert.equal(keyHealth.isRejected('xai', 'xai-test-key'), false);
});
