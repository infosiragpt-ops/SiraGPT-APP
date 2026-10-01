'use strict';

// Owner policy (Luis): a model the user picked is never switched; when its
// provider fails, the user is told exactly which model and which cause, in
// Spanish. agentic-degrade-policy decides what /api/ai/generate does with a
// degraded agentic run.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  decideAgenticDegrade,
  plainFallbackMaxMs,
  modelErrorStatus,
  DEFAULT_PLAIN_FALLBACK_MAX_MS,
  RUNTIME_BUDGET_MESSAGE,
} = require('../src/services/ai/agentic-degrade-policy');
const {
  AGENTIC_TIMEOUT_MESSAGE,
  PROVIDER_NO_CREDIT_MESSAGE,
} = require('../src/services/ai/generate-sse-close');
const billing = require('../src/services/ai/billing-failover');
const { ENUM_VALUES } = require('../src/services/ai/generate-request-observability');
const { CONNECT_MESSAGE } = require('../src/services/construir-mvp/github-publish');

beforeEach(() => billing.__resetForTests());

const ENV = {};

test('step_timeout / «Request timed out» regenerate only for plain turns within the budget', () => {
  for (const stoppedReason of ['model_error: step_timeout_60000ms', 'model_error: Request timed out.']) {
    const within = decideAgenticDegrade({ stoppedReason, elapsedMs: 10_000, hasAttachments: false, env: ENV });
    assert.equal(within.action, 'plain_fallback', stoppedReason);
    assert.equal(within.reasonCode, 'step_timeout');

    const late = decideAgenticDegrade({ stoppedReason, elapsedMs: DEFAULT_PLAIN_FALLBACK_MAX_MS + 1, env: ENV });
    assert.equal(late.action, 'honest_close', stoppedReason);
    assert.equal(late.code, 'E_TIMEOUT');
    assert.equal(late.message, AGENTIC_TIMEOUT_MESSAGE);

    const withFiles = decideAgenticDegrade({ stoppedReason, elapsedMs: 1000, hasAttachments: true, env: ENV });
    assert.equal(withFiles.action, 'honest_close', 'a document turn never regenerates from scratch');
    assert.equal(withFiles.code, 'E_TIMEOUT');
  }
});

test('SIRAGPT_AGENTIC_PLAIN_FALLBACK_MAX_MS bounds the plain regeneration', () => {
  assert.equal(plainFallbackMaxMs({}), DEFAULT_PLAIN_FALLBACK_MAX_MS);
  assert.equal(plainFallbackMaxMs({ SIRAGPT_AGENTIC_PLAIN_FALLBACK_MAX_MS: '5000' }), 5000);
  assert.equal(plainFallbackMaxMs({ SIRAGPT_AGENTIC_PLAIN_FALLBACK_MAX_MS: 'nope' }), DEFAULT_PLAIN_FALLBACK_MAX_MS);
  const out = decideAgenticDegrade({
    stoppedReason: 'model_error: step_timeout_60000ms',
    elapsedMs: 6000,
    env: { SIRAGPT_AGENTIC_PLAIN_FALLBACK_MAX_MS: '5000' },
  });
  assert.equal(out.action, 'honest_close');
});

test('runtime_budget_exhausted closes honestly without blaming GitHub or the model\'s speed', () => {
  const plain = decideAgenticDegrade({ stoppedReason: 'runtime_budget_exhausted', env: ENV });
  assert.equal(plain.action, 'honest_close');
  assert.equal(plain.code, 'E_TIMEOUT');
  assert.equal(plain.message, RUNTIME_BUDGET_MESSAGE);
  assert.doesNotMatch(RUNTIME_BUDGET_MESSAGE, /GitHub|tardó/);
  assert.match(RUNTIME_BUDGET_MESSAGE, /agotó el tiempo disponible/);
  assert.match(RUNTIME_BUDGET_MESSAGE, /No cambié de modelo/);
  assert.doesNotMatch(AGENTIC_TIMEOUT_MESSAGE, /GitHub/);
  assert.match(AGENTIC_TIMEOUT_MESSAGE, /No cambié de modelo/);

  // The budget is spent by tools too: the model is not blamed even when named.
  const named = decideAgenticDegrade({ stoppedReason: 'runtime_budget_exhausted', modelLabel: 'DeepSeek V4 Pro', env: ENV });
  assert.equal(named.message, RUNTIME_BUDGET_MESSAGE);
  // A step timeout (the model call itself) still names the model.
  const step = decideAgenticDegrade({ stoppedReason: 'model_error: step_timeout_60000ms', hasAttachments: true, modelLabel: 'DeepSeek V4 Pro', env: ENV });
  assert.match(step.message, /^DeepSeek V4 Pro tardó más de lo previsto/);
});

test('terminal causes tell the client not to retry; a per-minute limit carries its wait', () => {
  for (const [status, message, cause] of [
    [402, 'Insufficient Balance', 'billing'],
    [401, 'invalid x-api-key', 'auth'],
    [403, 'Your organization must be verified', 'forbidden'],
  ]) {
    const out = decideAgenticDegrade({
      stoppedReason: `model_error: ${status} ${message}`,
      modelError: { status, message, reason: cause },
      modelLabel: 'GPT 5.5',
      env: ENV,
    });
    assert.equal(out.action, 'honest_close', cause);
    assert.equal(out.retryable, false, cause);
  }
  const limited = decideAgenticDegrade({
    stoppedReason: 'model_error: 429 Rate limit reached. Please try again in 17s.',
    modelError: { status: 429, message: 'Rate limit reached. Please try again in 17s.', reason: null },
    modelLabel: 'GPT 5.5',
    env: ENV,
  });
  assert.equal(limited.action, 'honest_close');
  assert.equal(limited.failureReason, 'rate_limit');
  assert.equal(limited.retryable, null, 'a per-minute limit may be retried after the wait');
  assert.equal(limited.retryAfterSeconds, 17);
});

test('the route forwards retryable / retryAfterSeconds into the SSE error frame', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
  const at = src.indexOf("if (__degrade.action === 'honest_close') {");
  assert.ok(at > 0);
  const block = src.slice(at, at + 2000);
  assert.match(block, /__degrade\.retryable === false \? \{ retryable: false \} : \{\}/);
  assert.match(block, /__degrade\.retryAfterSeconds \? \{ retryAfterSeconds: __degrade\.retryAfterSeconds \} : \{\}/);
  const { writeGenerateSseError } = require('../src/services/ai/generate-sse-close');
  const frames = [];
  const payload = writeGenerateSseError({ write: (f) => frames.push(f) }, {
    message: 'x', code: 'E_PROVIDER', retryable: false, retryAfterSeconds: 16.2, failureReason: 'rate_limit',
  });
  assert.equal(payload.retryable, false);
  assert.equal(payload.retryAfterSeconds, 17);
  assert.equal(payload.failureReason, 'rate_limit');
  const bare = writeGenerateSseError({ write: () => {} }, { message: 'x', code: 'E_PROVIDER' });
  assert.equal('retryable' in bare, false);
  assert.equal('retryAfterSeconds' in bare, false);
});

test('a user Stop or an ended response never regenerates', () => {
  assert.equal(decideAgenticDegrade({ stoppedReason: 'aborted' }).action, 'none');
  assert.equal(decideAgenticDegrade({ stoppedReason: 'aborted' }).message, null, 'the loop\'s own cancel copy stays');
  assert.equal(decideAgenticDegrade({ stoppedReason: 'max_steps', clientGone: true }).action, 'none');
  assert.equal(decideAgenticDegrade({ stoppedReason: 'max_steps', clientGone: true }).message, null, 'a real partial answer stays');
});

test('a Stop that lands mid model call (SDK / fetch abort text) is a Stop, not a provider failure', () => {
  for (const stoppedReason of [
    'model_error: Request was aborted.',
    'model_error: This operation was aborted',
    'model_error: AbortError: The operation was aborted.',
  ]) {
    const out = decideAgenticDegrade({ stoppedReason, modelError: null, elapsedMs: 1000, env: ENV });
    assert.equal(out.action, 'none', stoppedReason);
    assert.equal(out.reasonCode, 'aborted', stoppedReason);
    assert.equal(out.message, 'La tarea se canceló antes de completarse.', stoppedReason);
  }
  // The route passes the turn signal: any model_error while stopped is a Stop.
  const signalled = decideAgenticDegrade({ stoppedReason: 'model_error: socket hang up', userStopped: true, env: ENV });
  assert.equal(signalled.action, 'none');
  assert.equal(signalled.message, 'La tarea se canceló antes de completarse.');
  // A real HTTP failure whose text mentions «aborted» is still a failure.
  const http = decideAgenticDegrade({
    stoppedReason: 'model_error: 429 Request aborted by rate limiter',
    modelError: { status: 429, message: 'Request aborted by rate limiter', reason: 'rate_limit' },
    modelLabel: 'DeepSeek V4 Flash',
    env: ENV,
  });
  assert.notEqual(http.action, 'none');
});

test('the route passes the user\'s Stop (signal.aborted) into the degrade decision', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
  const at = src.indexOf("require('../services/ai/agentic-degrade-policy').decideAgenticDegrade(");
  assert.ok(at > 0);
  const call = src.slice(at, at + 1500);
  assert.match(call, /userStopped:\s*Boolean\(signal && signal\.aborted\)/);
});

test('E_SANDBOX and E_GITHUB_CONNECT keep their current messages', () => {
  const sandbox = decideAgenticDegrade({ stoppedReason: 'E_SANDBOX', finalAnswer: 'La ruta sale del área aislada del proyecto.' });
  assert.equal(sandbox.action, 'honest_close');
  assert.equal(sandbox.code, 'E_SANDBOX');
  assert.equal(sandbox.message, 'La ruta sale del área aislada del proyecto.');
  assert.equal(sandbox.reasonCode, 'sandbox');

  const github = decideAgenticDegrade({ stoppedReason: 'E_GITHUB_CONNECT', finalAnswer: 'GitHub is not connected' });
  assert.equal(github.action, 'honest_close');
  assert.equal(github.code, 'E_GITHUB_CONNECT');
  assert.equal(github.message, CONNECT_MESSAGE);
});

test('«model_error: 402 Insufficient credits» closes honestly: sin saldo, model named, never regenerated', () => {
  const out = decideAgenticDegrade({ stoppedReason: 'model_error: 402 Insufficient credits', env: ENV });
  assert.equal(out.action, 'honest_close');
  assert.equal(out.billing, true);
  assert.equal(out.code, 'E_PROVIDER');
  assert.equal(out.status, 402);
  assert.equal(out.message, PROVIDER_NO_CREDIT_MESSAGE);
  assert.match(out.message, /saldo/);
  assert.match(out.message, /No cambié de modelo/);

  const named = decideAgenticDegrade({ stoppedReason: 'model_error: 402 Insufficient credits', modelLabel: 'Grok 4.7' });
  assert.match(named.message, /^Grok 4\.7 no pudo responder: su proveedor no tiene saldo ahora\./);
});

test('react-agent modelError is the source of the cause (auth, per-minute window with seconds)', () => {
  const auth = decideAgenticDegrade({
    stoppedReason: 'model_error: whatever',
    modelError: { status: 401, code: 'invalid_api_key', message: 'Incorrect API key provided', reason: 'auth' },
    modelLabel: 'GPT 5.5',
  });
  assert.equal(auth.action, 'honest_close');
  assert.equal(auth.failureReason, 'auth');
  assert.match(auth.message, /^GPT 5\.5 no pudo responder: su proveedor rechazó la clave de conexión/);

  const window = decideAgenticDegrade({
    stoppedReason: 'model_error: 429',
    modelError: {
      status: 429,
      code: null,
      message: 'You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric generate_content. Please retry in 29.3s.',
      reason: 'billing',
    },
    modelLabel: 'Gemini 2.5 Flash',
  });
  assert.equal(window.action, 'honest_close');
  assert.equal(window.failureReason, 'rate_limit', 'a per-minute window is never «sin saldo»');
  assert.equal(window.billing, false);
  assert.equal(window.retryAfterSeconds, 30);
  assert.match(window.message, /límite de solicitudes por minuto\. Espera 30 s/);
  assert.doesNotMatch(window.message, /saldo/);
});

test('transient model errors keep today\'s plain regeneration', () => {
  for (const stoppedReason of ['model_error: 500', 'model_error: 400 Invalid schema for function', 'max_steps', 'no_message', 'invalid_tool_calls']) {
    const out = decideAgenticDegrade({ stoppedReason, elapsedMs: 1000 });
    assert.equal(out.action, 'plain_fallback', stoppedReason);
  }
  assert.equal(decideAgenticDegrade({ stoppedReason: 'model_error: 500' }).status, 500);
});

test('modelErrorStatus reads the 3-digit status after model_error:', () => {
  assert.equal(modelErrorStatus('model_error: 402 Insufficient credits'), 402);
  assert.equal(modelErrorStatus('model_error: step_timeout_60000ms'), null);
  assert.equal(modelErrorStatus('max_steps'), null);
});

test('every reasonCode is in the observability allowlist', () => {
  const reasons = [
    'model_error: step_timeout_60000ms', 'model_error: Request timed out.', 'runtime_budget_exhausted',
    'aborted', 'E_SANDBOX', 'E_GITHUB_CONNECT', 'model_error: 402 Insufficient credits', 'model_error: 500',
    'max_steps', 'no_message', 'invalid_tool_calls', 'tool_circuit_open:web_search', 'verification_failed:guard',
    'degraded_no_finalize', 'weird',
  ];
  for (const stoppedReason of reasons) {
    const out = decideAgenticDegrade({ stoppedReason, elapsedMs: 1000, finalAnswer: stoppedReason === 'E_SANDBOX' ? 'sandbox' : '' });
    assert.ok(ENUM_VALUES.reasonCode.has(out.reasonCode), `${stoppedReason} → ${out.reasonCode}`);
  }
});

test('source pin: routes/ai.js decides with decideAgenticDegrade and the loop returns modelError', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
  assert.match(route, /decideAgenticDegrade\(\{[\s\S]*?modelError: agenticResult\.modelError \|\| null,[\s\S]*?modelLabel: await __turnModelLabel\(\)/);
  assert.match(route, /__degrade\.action === 'honest_close'[\s\S]*?closeGenerateSseWithError\(res, \{[\s\S]*?message: __degrade\.message/);
  assert.doesNotMatch(route, /const degradedClassified = classifyGenerateError/);
  const loop = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'agentic-chat-stream.js'), 'utf8');
  assert.match(loop, /modelError: result\?\.modelError \|\| null/);
});


test('coding timeout closes with its cause and never falls back to prose', () => {
  const out = decideAgenticDegrade({ stoppedReason: 'model_error: step_timeout_60000ms', elapsedMs: 71536, codingWorkspace: true, modelLabel: 'Grok 4.7', env: ENV });
  assert.equal(out.action, 'honest_close');
  assert.equal(out.code, 'E_TIMEOUT');
  assert.equal(out.reasonCode, 'step_timeout');
  assert.match(out.message, /^Grok 4.7 tardó más de lo previsto/);
});
