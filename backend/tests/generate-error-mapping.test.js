'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  CONNECTION_UNAVAILABLE_MESSAGE,
  PROVIDER_UNAVAILABLE_MESSAGE,
  STREAM_TIMEOUT_MESSAGE,
  PROVIDER_FAIL_MESSAGE,
  classifyGenerateError,
  publicGenerateErrorMessage,
  closeGenerateSseWithError,
} = require('../src/services/ai/generate-sse-close');
const { CONNECT_MESSAGE } = require('../src/services/construir-mvp/github-publish');

function mockRes() {
  const chunks = [];
  const res = {
    writableEnded: false,
    destroyed: false,
    chunks,
    write(frame) {
      chunks.push(String(frame));
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  };
  return res;
}

test('missing first-party pin / vendor leak is provider_unavailable, not vague Conexión', () => {
  const unknown = classifyGenerateError({ message: '400 unknown parameter reasoning' });
  assert.equal(unknown.code, 'provider_unavailable');
  assert.equal(unknown.message, PROVIDER_UNAVAILABLE_MESSAGE);
  assert.doesNotMatch(unknown.message, /DeepSeek|OpenRouter|muse-spark|unknown parameter/i);
  assert.doesNotMatch(unknown.message, /\/conexiones/);

  const leak = classifyGenerateError({
    message: 'OpenRouter 502 DeepSeek muse-spark-1.2-contributor',
  });
  assert.equal(leak.code, 'provider_unavailable');
  assert.equal(leak.message, PROVIDER_UNAVAILABLE_MESSAGE);

  const missingKey = classifyGenerateError({
    message: PROVIDER_UNAVAILABLE_MESSAGE,
    code: 'PROVIDER_CONNECTION_UNAVAILABLE',
  });
  assert.equal(missingKey.code, 'provider_unavailable');
  assert.equal(missingKey.message, PROVIDER_UNAVAILABLE_MESSAGE);
  assert.match(missingKey.message, /Ajustes|selector/i);
});

test('true transport dead stays short Conexión no disponible', () => {
  assert.equal(
    publicGenerateErrorMessage({ message: CONNECTION_UNAVAILABLE_MESSAGE, code: 'connection_unavailable' }),
    CONNECTION_UNAVAILABLE_MESSAGE,
  );
  assert.equal(classifyGenerateError({}).code, 'connection_unavailable');
  assert.equal(classifyGenerateError({}).message, CONNECTION_UNAVAILABLE_MESSAGE);
});

test('maps timeout / abort / stream drop to E_TIMEOUT, not a fake GitHub connection', () => {
  const cases = [
    { name: 'AbortError', message: 'aborted' },
    { code: 'ETIMEDOUT', message: 'connect timeout' },
    { message: 'First-byte timeout after 45000ms' },
    { code: 'runtime_budget_exhausted', message: 'budget' },
    { code: 'aborted', message: '' },
    { message: 'La solicitud tardó demasiado. Intenta de nuevo.' },
  ];
  for (const err of cases) {
    const out = classifyGenerateError(err);
    assert.equal(out.code, 'E_TIMEOUT', JSON.stringify(err));
    assert.equal(out.message, STREAM_TIMEOUT_MESSAGE);
    assert.doesNotMatch(out.message, /Conexión no disponible|connection_unavailable/i);
    assert.match(out.message, /stream|Reintenta/i);
  }
});

test('maps GitHub OAuth miss to E_GITHUB_CONNECT + /conexiones CTA', () => {
  const out = classifyGenerateError({
    code: 'E_GITHUB_CONNECT',
    message: CONNECT_MESSAGE,
  });
  assert.equal(out.code, 'E_GITHUB_CONNECT');
  assert.equal(out.message, CONNECT_MESSAGE);
  assert.match(out.message, /\/conexiones/);
  assert.doesNotMatch(out.message, /Conexión no disponible/);

  const english = classifyGenerateError({
    code: 'github_not_connected',
    message: 'GitHub is not connected for this user',
  });
  assert.equal(english.code, 'E_GITHUB_CONNECT');
  assert.match(english.message, /\/conexiones/);
});

test('maps sandbox jail and generic tool/provider failures honestly', () => {
  const jail = classifyGenerateError({ code: 'E_PATH_ESCAPE', message: 'La ruta sale del workspace aislado.' });
  assert.equal(jail.code, 'E_SANDBOX');
  assert.match(jail.message, /workspace|ruta/i);

  const provider = classifyGenerateError({ message: 'AI generation failed after exhausting fallback chain' });
  assert.equal(provider.code, 'E_PROVIDER');
  assert.equal(provider.message, PROVIDER_FAIL_MESSAGE);
  assert.doesNotMatch(provider.message, /Conexión no disponible/);
});

test('SSE closer writes the classified Spanish text, not a generic connection', () => {
  const res = mockRes();
  closeGenerateSseWithError(res, {
    message: STREAM_TIMEOUT_MESSAGE,
    code: 'E_TIMEOUT',
  });
  const body = res.chunks.join('');
  assert.match(body, /El modelo cortó el stream/);
  assert.match(body, /"code":"E_TIMEOUT"/);
  assert.doesNotMatch(body, /Conexión no disponible/);
  assert.match(body, /data: \[DONE\]/);
});

test('frontend remappers only collapse true connection_unavailable, not timeout or GitHub CTA', () => {
  const roots = [
    path.join(__dirname, '../../lib/generate-stream-errors.ts'),
    path.join(__dirname, '../../lib/chat-context-integrated.tsx'),
    path.join(__dirname, '../../lib/api.ts'),
    path.join(__dirname, '../../lib/recover-persisted-turn.ts'),
  ];
  for (const file of roots) {
    const src = fs.readFileSync(file, 'utf8');
    assert.match(src, /connection_unavailable|conexión no disponible/i, file);
    assert.doesNotMatch(
      src,
      /E_TIMEOUT|E_GITHUB_CONNECT/,
      `${file} must not remap the new codes onto Conexión no disponible`,
    );
  }
  const friendly = fs.readFileSync(path.join(__dirname, '../../lib/generate-stream-errors.ts'), 'utf8');
  assert.match(friendly, /PROVIDER_UNAVAILABLE_MESSAGE/);
  assert.match(friendly, /isProviderUnavailablePayload/);
  assert.equal(STREAM_TIMEOUT_MESSAGE.includes('conexión no disponible'), false);
  assert.equal(CONNECT_MESSAGE.includes('conexión no disponible'), false);
  assert.equal(PROVIDER_UNAVAILABLE_MESSAGE.includes('conexión no disponible'), false);
  assert.equal(PROVIDER_UNAVAILABLE_MESSAGE.includes('/conexiones'), false);
});

// ── Owner policy: transparent «sin saldo» (never the provider's text) ──

test('an empty account maps to E_PROVIDER with the «sin saldo» copy, not the raw provider text', () => {
  const { PROVIDER_NO_CREDIT_MESSAGE } = require('../src/services/ai/generate-sse-close');
  const billing = require('../src/services/ai/billing-failover');
  assert.equal(PROVIDER_NO_CREDIT_MESSAGE, billing.buildFailureMessage({ reason: 'billing' }));
  const cases = [
    { status: 402, message: 'Insufficient credits. Add more using https://openrouter.ai/settings/credits' },
    { message: 'Your credit balance is too low to access the Anthropic API.' },
    { status: 403, message: 'You have used all available credits for this team. sk-live-xyz' },
    { status: 402, message: 'Insufficient Balance' },
  ];
  for (const err of cases) {
    const out = classifyGenerateError(err);
    assert.equal(out.code, 'E_PROVIDER', JSON.stringify(err));
    assert.equal(out.message, PROVIDER_NO_CREDIT_MESSAGE);
    assert.match(out.message, /saldo/);
    assert.match(out.message, /No cambié de modelo/);
    assert.doesNotMatch(out.message, /openrouter|sk-|credit balance|Insufficient/i);
  }
});

test('a rate limit or a per-minute quota window is never «sin saldo»', () => {
  const { PROVIDER_NO_CREDIT_MESSAGE } = require('../src/services/ai/generate-sse-close');
  const rate = classifyGenerateError({ status: 429, message: 'Rate limit reached for requests' });
  assert.notEqual(rate.message, PROVIDER_NO_CREDIT_MESSAGE);
  assert.doesNotMatch(rate.message, /saldo/);

  const gemini = classifyGenerateError({
    status: 429,
    message: 'You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric generate_content_free_tier_requests. Please retry in 29.3s.',
  });
  assert.doesNotMatch(gemini.message, /saldo/);
});

test('an annotated error gets the 100% transparent copy (model + cause), code unchanged', () => {
  const err = Object.assign(new Error('429 quota'), {
    status: 429,
    siraFailureReason: 'rate_limit',
    siraRetryAfterSeconds: 29,
    siraModelLabel: 'Gemini 2.5 Flash',
  });
  const out = classifyGenerateError(err);
  assert.equal(out.code, 'E_PROVIDER');
  assert.equal(
    out.message,
    'Gemini 2.5 Flash no pudo responder: su proveedor alcanzó el límite de solicitudes por minuto. Espera 29 s y vuelve a intentarlo. No cambié de modelo.',
  );

  // Gemini's per-minute text also matches the billing wording: the annotated
  // cause wins over the «sin saldo» mapping.
  const window = Object.assign(new Error('You exceeded your current quota'), { status: 429, siraFailureReason: 'rate_limit' });
  assert.match(classifyGenerateError(window).message, /límite de solicitudes por minuto/);

  const timeout = Object.assign(new Error('First-byte timeout after 45000ms'), { siraFailureReason: 'unavailable', siraModelLabel: 'Grok 4.7' });
  const t = classifyGenerateError(timeout);
  assert.equal(t.code, 'E_TIMEOUT');
  assert.match(t.message, /^Grok 4\.7 no pudo responder: su proveedor no está respondiendo ahora\./);
});
