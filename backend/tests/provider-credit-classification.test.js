'use strict';

/**
 * A provider with an empty account says so in words, wrapped in whatever
 * status it likes: OpenAI 429, xAI 403, Anthropic 400, Meta 402. Both
 * classifiers must read the words, not the status — otherwise the turn is
 * retried as a rate limit or reported as «clave rechazada» (prod 2026-09-28/29,
 * Admin → Logs).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyTaskError } = require('../src/utils/task-error-classifier');
const { classifyProviderError } = require('../src/services/ai-product-os/litellm-gateway');
const { failureCategoryOf } = require('../src/services/turn-progress');
const {
  classifyGenerateError,
  STREAM_TIMEOUT_MESSAGE,
} = require('../src/services/ai/generate-sse-close');

function providerError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.statusCode = status;
  return err;
}

const NO_CREDIT = [
  ['xAI 403', providerError(403, '403 "Your team caf66fcb has either used all available credits or reached its monthly spending limit. To continue making API requests, purchase more credits or raise the limit."')],
  ['OpenAI 429', providerError(429, '429 You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing')],
  ['Anthropic 400', providerError(400, '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}')],
  ['Meta 402', providerError(402, '402 Billing verification failed. Please check your payment method.')],
];

test('task classifier: explicit no-credit wording is quota-exhausted, never retried, whatever the status', () => {
  for (const [label, err] of NO_CREDIT) {
    const out = classifyTaskError(err);
    assert.equal(out.reason, 'quota-exhausted', label);
    assert.equal(out.retryable, false, label);
  }
});

test('task classifier: a bare 403 / 401 / 429 keeps its own class', () => {
  assert.equal(classifyTaskError(providerError(403, 'Forbidden')).reason, 'auth-failure');
  assert.equal(classifyTaskError(providerError(401, 'Incorrect API key provided: sk-proj-***')).reason, 'auth-failure');
  const limited = classifyTaskError(providerError(429, 'Rate limit exceeded: 60 requests per minute'));
  assert.equal(limited.reason, 'rate-limited');
  assert.equal(limited.retryable, true);
});

test('gateway classifier: no-credit wording is quota_exhausted even on 403 (xAI) and 429 (OpenAI)', () => {
  for (const [label, err] of NO_CREDIT) {
    const out = classifyProviderError(err);
    assert.equal(out.error_class, 'quota_exhausted', label);
    assert.equal(out.retryable, false, label);
    assert.equal(failureCategoryOf(err, { classified: out }), 'billing', label);
  }
  assert.equal(classifyProviderError(providerError(403, 'Forbidden')).error_class, 'auth');
  assert.equal(classifyProviderError(providerError(401, 'invalid api key')).error_class, 'auth');
  assert.equal(classifyProviderError(providerError(429, 'Rate limit exceeded')).error_class, 'rate_limit');
});

test('stream timeout copy talks about the model, not GitHub', () => {
  assert.doesNotMatch(STREAM_TIMEOUT_MESSAGE, /github/i);
  assert.match(STREAM_TIMEOUT_MESSAGE, /Reintenta/);
  assert.equal(classifyGenerateError({ code: 'E_TIMEOUT', message: 'stream ended' }).message, STREAM_TIMEOUT_MESSAGE);
  // The copy itself round-trips through the classifier (a re-thrown message).
  assert.equal(classifyGenerateError(new Error(STREAM_TIMEOUT_MESSAGE)).code, 'E_TIMEOUT');
  assert.equal(classifyGenerateError(new Error('El modelo cortó el stream después de pensar.')).code, 'E_TIMEOUT');
});
