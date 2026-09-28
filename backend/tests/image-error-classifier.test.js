'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { classifyImageGenError, MAX_MESSAGE_CHARS } = require('../src/services/image-error-classifier');

test('maps a 429 status to a clean image_quota_exceeded / HTTP 429', () => {
  const r = classifyImageGenError({ status: 429, message: 'whatever' });
  assert.equal(r.httpStatus, 429);
  assert.equal(r.code, 'image_quota_exceeded');
  assert.equal(r.isQuota, true);
  assert.match(r.message, /cuota/i);
});

test('detects Gemini RESOURCE_EXHAUSTED quota text even without a status', () => {
  const blob = '{"error":{"code":429,"message":"You exceeded your current quota ... RESOURCE_EXHAUSTED ...' + 'x'.repeat(4000) + '"}}';
  const r = classifyImageGenError(new Error(blob));
  assert.equal(r.httpStatus, 429);
  assert.equal(r.code, 'image_quota_exceeded');
  // Must NOT leak the multi-KB provider blob.
  assert.ok(r.message.length <= 220);
  assert.equal(r.message.includes('RESOURCE_EXHAUSTED'), false);
});

test('truncates a long non-quota error message (no raw-blob leak)', () => {
  const long = 'boom '.repeat(200); // ~1000 chars
  const r = classifyImageGenError(new Error(long));
  assert.equal(r.code, 'image_generation_failed');
  assert.equal(r.httpStatus, 500);
  assert.ok(r.message.length <= MAX_MESSAGE_CHARS + 1, `message too long: ${r.message.length}`);
});

test('preserves a 4xx provider status for non-quota client errors', () => {
  const r = classifyImageGenError({ status: 400, message: 'bad request' });
  assert.equal(r.httpStatus, 400);
  assert.equal(r.code, 'image_generation_failed');
});

test('defaults unknown errors to HTTP 500 with a short message', () => {
  const r = classifyImageGenError(new Error('unexpected'));
  assert.equal(r.httpStatus, 500);
  assert.equal(r.code, 'image_generation_failed');
  assert.equal(r.message, 'unexpected');
});

test('an image provider without credit → image_provider_no_credit, HTTP 503 (never 402), no raw text', () => {
  const cases = [
    { status: 402, message: 'Payment Required' },
    { status: 429, code: 'insufficient_quota', message: '429 You exceeded your current quota, please check your plan and billing details. sk-proj-abc' },
    { status: 400, message: 'Billing hard limit has been reached' },
    { status: 403, message: 'Your team has used all available credits. Purchase more at https://console.x.ai' },
  ];
  for (const err of cases) {
    const r = classifyImageGenError(err);
    assert.equal(r.code, 'image_provider_no_credit', JSON.stringify(err));
    assert.equal(r.httpStatus, 503);
    assert.notEqual(r.httpStatus, 402);
    assert.match(r.message, /saldo/);
    assert.match(r.message, /No cambié de modelo/);
    assert.doesNotMatch(r.message, /sk-|https?:|Billing hard limit|quota/i);
  }
  const named = classifyImageGenError({ status: 402, message: 'Payment Required' }, { modelLabel: 'Grok Imagine' });
  assert.match(named.message, /^Grok Imagine no pudo generar la imagen: su proveedor no tiene saldo ahora\./);
});

test('every failed attempt without credit is billing; a mix is not', () => {
  const all = classifyImageGenError({ message: 'all failed', attempts: [{ error: '402 Payment Required' }, { error: 'insufficient credits' }] });
  assert.equal(all.code, 'image_provider_no_credit');
  const mixed = classifyImageGenError({ message: 'all failed', attempts: [{ error: '402 Payment Required' }, { error: 'content policy violation' }] });
  assert.notEqual(mixed.code, 'image_provider_no_credit');
});

test('no balance is terminal for the client: retryable:false + failureReason', () => {
  const r = classifyImageGenError({ status: 402, message: 'Payment Required' }, { modelLabel: 'Grok Imagine' });
  assert.equal(r.retryable, false);
  assert.equal(r.failureReason, 'billing');
});

test('the picked image model is named with the exact cause: rejected key, forbidden, no connection, not responding', () => {
  const TAIL = 'No cambié de modelo; elige otro en Imágenes o inténtalo más tarde.';
  const auth = classifyImageGenError(
    { code: 'E_PROVIDER', message: 'No se pudo generar', attempts: [{ ok: false, error: '401 Incorrect API key provided: sk-abc' }] },
    { modelLabel: 'GPT Image 2' },
  );
  assert.equal(auth.code, 'E_PROVIDER');
  assert.notEqual(auth.httpStatus, 401, 'never the upstream 401: the user\'s session is fine');
  assert.equal(auth.retryable, false);
  assert.equal(auth.failureReason, 'auth');
  assert.equal(auth.message, `GPT Image 2 no pudo generar la imagen: su proveedor rechazó la clave de conexión. ${TAIL}`);
  assert.doesNotMatch(auth.message, /sk-|401/);

  const forbidden = classifyImageGenError({ status: 403, message: 'Your organization must be verified to use this model.' }, { modelLabel: 'GPT Image 2' });
  assert.equal(forbidden.failureReason, 'forbidden');
  assert.equal(forbidden.retryable, false);
  assert.match(forbidden.message, /^GPT Image 2 no pudo generar la imagen: su proveedor no permite usar este modelo ahora\./);

  const unconfigured = classifyImageGenError({ code: 'E_PROVIDER', message: 'x', attempts: [{ ok: false, error: 'api key missing' }] });
  assert.equal(unconfigured.failureReason, 'unconfigured');
  assert.match(unconfigured.message, /^El modelo de imágenes elegido no pudo generar la imagen: su conexión no está configurada\./);

  const down = classifyImageGenError({ code: 'E_PROVIDER', message: 'x', attempts: [{ ok: false, error: '503 Service Unavailable' }] }, { modelLabel: 'Flux Pro' });
  assert.equal(down.failureReason, 'unavailable');
  assert.equal(down.retryable, undefined, 'an outage may be retried');
  assert.match(down.message, /^Flux Pro no pudo generar la imagen: su proveedor no está respondiendo ahora\./);
});

test('a per-minute limit names the model and the wait when known; the unnamed copy is unchanged', () => {
  const err = Object.assign(new Error('429 Rate limit reached. Please try again in 12s.'), { status: 429 });
  const r = classifyImageGenError(err, { modelLabel: 'Grok Imagine' });
  assert.equal(r.httpStatus, 429);
  assert.equal(r.code, 'image_quota_exceeded');
  assert.equal(r.failureReason, 'rate_limit');
  assert.match(r.message, /^Grok Imagine no pudo generar la imagen: su proveedor alcanzó su límite de cuota por minuto\./);
  assert.match(r.message, /No cambié de modelo\.$/);
  const unnamed = classifyImageGenError({ status: 429, message: 'whatever' });
  assert.equal(unnamed.message, 'El modelo de imágenes alcanzó su límite de cuota. Intenta de nuevo en un momento o elige otro modelo.');
});

test('a mix of causes across attempts is not one cause', () => {
  const mixed = classifyImageGenError({
    code: 'E_PROVIDER',
    message: 'x',
    attempts: [{ ok: false, error: '401 Incorrect API key' }, { ok: false, error: '503 Service Unavailable' }],
  }, { modelLabel: 'GPT Image 2' });
  assert.equal(mixed.code, 'E_PROVIDER');
  assert.equal(mixed.httpStatus, 502);
  assert.equal(mixed.message, 'GPT Image 2 no pudo generar la imagen. Reintenta o elige otro modelo.');
});
