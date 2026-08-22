'use strict';

/**
 * provider-resilience-wiring.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Verifies the retry + circuit-breaker wiring on outbound provider calls
 * that previously had none:
 *
 *   1. generate-document route — transient 5xx/429/network errors are
 *      retried with backoff, validation 4xx are not, and after N failures
 *      the shared per-(provider, model) breaker opens and maps to a 503
 *      provider_unavailable payload.
 *   2. visual-media-tools — fal.subscribe and raw video-download fetches
 *      retry only transient failures; the storyboard fallback stays the
 *      last resource (out of scope here: covered by the catch block).
 *   3. model-sync-service — the fal.ai public catalog fetch retries 3
 *      attempts total on transient errors and still degrades gracefully.
 *   4. circuit-breaker service registry — getBreakerSnapshot exposes
 *      name/state/failures for /health.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const docRoute = require('../src/routes/generate-document');
const { CircuitBreakerError } = require('../src/services/circuit-breaker');
const {
  isTransientMediaStatus,
  classifyMediaToolError,
  fetchWithTransientRetry,
} = require('../src/services/agents/visual-media-tools').__test_helpers;
const modelSyncService = require('../src/services/model-sync-service');

const { createDocumentGenerationCall, classifyProviderError, isTransientProviderStatus, mapRouteErrorToSsePayload } = docRoute.INTERNAL;
const { isTransientFalSyncError, axiosGetWithRetry } = modelSyncService.__resilience;

// ── Helpers ────────────────────────────────────────────────────────────────

function uniqueBreakerName(prefix) {
  return `${prefix}:${Math.random().toString(36).slice(2)}`;
}

function makeError({ status, name, message } = {}) {
  const error = new Error(message || `error ${status ?? ''}`);
  if (status !== undefined) error.status = status;
  if (name) error.name = name;
  return error;
}

// ── generate-document: classification ──────────────────────────────────────

test('doc-gen classify: transient statuses are retryable', () => {
  assert.equal(isTransientProviderStatus(500), true);
  assert.equal(isTransientProviderStatus(502), true);
  assert.equal(isTransientProviderStatus(429), true);
  assert.equal(isTransientProviderStatus(408), true);
});

test('doc-gen classify: validation and auth 4xx are NOT retried', () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(classifyProviderError(makeError({ status })).retryable, false, `status ${status}`);
  }
});

test('doc-gen classify: client aborts are never retried', () => {
  const verdict = classifyProviderError(makeError({ status: 500, name: 'AbortError' }));
  assert.equal(verdict.retryable, false);
  assert.equal(verdict.reason, 'aborted');
});

test('doc-gen classify: network errors without status/code are retryable', () => {
  const verdict = classifyProviderError(new Error('socket hang up'));
  assert.equal(verdict.retryable, true);
  assert.equal(verdict.reason, 'network_error');
});

test('doc-gen classify: OpenAI-style numeric code 400 (bad request) is NOT retried', () => {
  const err = new Error('Invalid model');
  err.code = 400;
  assert.equal(classifyProviderError(err).retryable, false);
});

// ── generate-document: breaker + retry wiring ──────────────────────────────

test('doc-gen call: retries transient 500 then succeeds', async () => {
  const call = createDocumentGenerationCall(
    { provider: 'OpenAI', model: uniqueBreakerName('gpt-test-retry-500') },
    { baseDelayMs: 1 },
  );
  let attempts = 0;
  const streamToken = { ok: true };
  const result = await call.run(() => {
    attempts += 1;
    if (attempts === 1) throw makeError({ status: 500 });
    return Promise.resolve(streamToken);
  });
  assert.equal(result, streamToken);
  assert.ok(call.getCallCount() >= 2, `expected at least 2 attempts, got ${call.getCallCount()}`);
});

test('doc-gen call: does NOT retry a 400 from the provider', async () => {
  const call = createDocumentGenerationCall(
    { provider: 'OpenAI', model: uniqueBreakerName('gpt-test-no-retry-400') },
    { baseDelayMs: 1 },
  );
  await assert.rejects(
    () => call.run(() => Promise.reject(makeError({ status: 400 }))),
    /error 400/,
  );
  assert.equal(call.getCallCount(), 1);
});

test('doc-gen call: retries network errors up to maxRetries then rethrows last error', async () => {
  const call = createDocumentGenerationCall(
    { provider: 'DeepSeek', model: uniqueBreakerName('deepseek-chat-net') },
    { baseDelayMs: 1 },
  );
  await assert.rejects(
    () => call.run(() => Promise.reject(new Error('ECONNRESET'))),
    /ECONNRESET/,
  );
  // initial attempt + DOC_GEN_MAX_RETRIES (default 2)
  assert.equal(call.getCallCount(), 3);
});

test('doc-gen call: breaker opens after 5 consecutive exhausted failures and short-circuits', async () => {
  const model = uniqueBreakerName('gpt-test-open');
  const call = createDocumentGenerationCall({ provider: 'OpenAI', model }, { baseDelayMs: 1 });

  // Each run() exhausts its own retry budget (3 calls) and fails → one
  // recorded breaker failure per run(). Threshold is 5.
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => call.run(() => Promise.reject(makeError({ status: 503 }))), /error 503/);
  }

  const openErr = await call.run(() => Promise.resolve({ ok: true })).then(
    () => { throw new Error('expected CircuitBreakerError'); },
    (err) => err,
  );
  assert.ok(openErr instanceof CircuitBreakerError, `expected CircuitBreakerError, got ${openErr.name}`);
  assert.equal(openErr.state, 'OPEN');
  assert.ok(String(openErr.breakerName).endsWith(`:${model}`));
  // The last run() must have short-circuited before reaching the provider fn.
  assert.equal(call.getCallCount(), 15);
});

test('doc-gen mapping: CircuitBreakerError maps to 503 provider_unavailable', () => {
  const mapped = mapRouteErrorToSsePayload(new CircuitBreakerError('openai:m', 'OPEN', new Date(Date.now() + 60_000)));
  assert.deepEqual(mapped, {
    status: 503,
    payload: {
      code: 'provider_unavailable',
      error: 'El proveedor del modelo no está disponible temporalmente. Intenta de nuevo en unos momentos.',
    },
  });
  assert.equal(mapRouteErrorToSsePayload(new Error('other')), null);
});

test('doc-gen breaker key uses lowercased provider so it matches the shared registry naming', async () => {
  const model = uniqueBreakerName('m');
  const call = createDocumentGenerationCall({ provider: 'Gemini', model }, { baseDelayMs: 1 });
  assert.equal(call.breakerName, `gemini:${model}`);
  // One failing run records exactly one breaker failure under that key.
  await assert.rejects(() => call.run(() => Promise.reject(makeError({ status: 502 }))));
  const { getBreakerSnapshot } = require('../src/services/circuit-breaker');
  const entry = getBreakerSnapshot().find((b) => b.name === `gemini:${model}`);
  assert.ok(entry, 'breaker should be registered under the lowercased provider key');
  assert.equal(entry.failures, 1);
});

// ── visual-media-tools helpers ─────────────────────────────────────────────

test('media classify: 408/429/5xx transient, other 4xx terminal', () => {
  assert.equal(isTransientMediaStatus(408), true);
  assert.equal(isTransientMediaStatus(429), true);
  assert.equal(isTransientMediaStatus(500), true);
  assert.equal(isTransientMediaStatus(503), true);
  assert.equal(isTransientMediaStatus(400), false);
  assert.equal(isTransientMediaStatus(402), false);

  assert.equal(classifyMediaToolError(makeError({ status: 429 })).retryable, true);
  assert.equal(classifyMediaToolError(makeError({ status: 400 })).retryable, false);
  assert.equal(classifyMediaToolError(Object.assign(new Error('x'), { code: 'ECONNRESET' })).retryable, true);
});

test('media fetch helper: retries 5xx responses and returns the final response', async () => {
  let attempts = 0;
  const failResp = { ok: false, status: 503 };
  const goodResp = { ok: true, status: 200, body: 'video' };
  const resp = await fetchWithTransientRetry(async () => {
    attempts += 1;
    return attempts < 3 ? failResp : goodResp;
  }, 'https://dl.example/video.mp4', {}, { maxRetries: 2, baseDelayMs: 1 });
  assert.equal(resp, goodResp);
  assert.equal(attempts, 3);
});

test('media fetch helper: does NOT retry a 400 response', async () => {
  let attempts = 0;
  const badReq = { ok: false, status: 400 };
  const resp = await fetchWithTransientRetry(async () => {
    attempts += 1;
    return badReq;
  }, 'https://dl.example/video.mp4', {}, { maxRetries: 2, baseDelayMs: 1 });
  assert.equal(resp, badReq);
  assert.equal(attempts, 1);
});

test('media fetch helper: returns the transient response (not a throw) when retries exhaust', async () => {
  let attempts = 0;
  const unavailable = { ok: false, status: 503 };
  const resp = await fetchWithTransientRetry(async () => {
    attempts += 1;
    return unavailable;
  }, 'https://dl.example/video.mp4', {}, { maxRetries: 1, baseDelayMs: 1 });
  assert.equal(resp, unavailable);
  assert.equal(attempts, 2);
  assert.equal(resp.ok, false); // caller's storyboard degrade path still triggers
});

test('media fetch helper: propagates thrown network errors after exhausting retries', async () => {
  let attempts = 0;
  await assert.rejects(
    () => fetchWithTransientRetry(async () => {
      attempts += 1;
      throw Object.assign(new Error('boom'), { code: 'ECONNRESET' });
    }, 'https://dl.example/video.mp4', {}, { maxRetries: 1, baseDelayMs: 1 }),
    /boom/,
  );
  assert.equal(attempts, 2);
});

test('media fal subscribe shape: thrown transient errors would be classified retryable by withRetry', () => {
  // The fal.subscribe wiring passes classifyMediaToolError to withRetry —
  // this pins the contract used by the live call site.
  const falValidationError = Object.assign(new Error('Invalid input'), { status: 422 });
  assert.equal(classifyMediaToolError(falValidationError).retryable, false);
  const falRateLimit = Object.assign(new Error('Too many requests'), { status: 429 });
  assert.equal(classifyMediaToolError(falRateLimit).retryable, true);
});

// ── model-sync-service: fal catalog sync retry ────────────────────────────

test('fal sync: axios 429 is transient, 402/401 are not', () => {
  const httpError = (status) => Object.assign(new Error(`http ${status}`), { response: { status } });
  assert.equal(isTransientFalSyncError(httpError(429)), true);
  assert.equal(isTransientFalSyncError(httpError(503)), true);
  assert.equal(isTransientFalSyncError(httpError(402)), false);
  assert.equal(isTransientFalSyncError(httpError(401)), false);
  assert.equal(isTransientFalSyncError(new Error('getaddrinfo ENOTFOUND')), true);
});

test('fal sync: legacy explore endpoint retries transient failures then succeeds', async () => {
  const originalGet = axios.get;
  const seenUrls = [];
  try {
    let attempts = 0;
    axios.get = async (url) => {
      seenUrls.push(url);
      attempts += 1;
      if (attempts <= 2) {
        throw Object.assign(new Error('rate limited'), { response: { status: 429 } });
      }
      return { data: { pages: 1, items: [] } };
    };

    const result = await axiosGetWithRetry('https://fal.ai/api/explore/models', {}, { baseDelayMs: 1 });
    assert.equal(result.data.pages, 1);
    assert.equal(seenUrls.length, 3);
    assert.ok(seenUrls.every((u) => u === 'https://fal.ai/api/explore/models'));
  } finally {
    axios.get = originalGet;
  }
});

test('fal sync: non-transient failure surfaces immediately without retry', async () => {
  const originalGet = axios.get;
  try {
    let attempts = 0;
    axios.get = async () => {
      attempts += 1;
      throw Object.assign(new Error('unauthorized'), { response: { status: 401 } });
    };
    await assert.rejects(() => axiosGetWithRetry('https://fal.ai/api/explore/models', {}, { baseDelayMs: 1 }), /unauthorized/);
    assert.equal(attempts, 1);
  } finally {
    axios.get = originalGet;
  }
});

test('fal sync: wired into fetchFalVideoModels legacy fallback (still degrades to static manifest)', async () => {
  const originalGet = axios.get;
  const originalWarn = console.warn;
  try {
    console.warn = () => {};
    axios.get = async () => { throw new Error('getaddrinfo ENOTFOUND fal.ai'); };
    const models = await modelSyncService.fetchFalVideoModels();
    assert.ok(Array.isArray(models));
    assert.ok(models.length > 0, 'static manifest models should still be returned');
    assert.ok(models.every((m) => m.type === 'VIDEO'));
  } finally {
    axios.get = originalGet;
    console.warn = originalWarn;
  }
});

// ── services/circuit-breaker snapshot ──────────────────────────────────────

test('breaker snapshot: getBreakerSnapshot exposes name/state/failures per registered breaker', async () => {
  const { getBreaker, getBreakerSnapshot } = require('../src/services/circuit-breaker');
  const name = uniqueBreakerName('snapshot-probe');
  const breaker = getBreaker(name, { failureThreshold: 2, resetTimeoutMs: 60_000 });

  assert.deepEqual(getBreakerSnapshot().find((b) => b.name === name), { name, state: 'CLOSED', failures: 0 });

  await assert.rejects(() => breaker.execute(() => Promise.reject(new Error('x'))));
  await assert.rejects(() => breaker.execute(() => Promise.reject(new Error('x'))));

  const snap = getBreakerSnapshot().find((b) => b.name === name);
  assert.equal(snap.state, 'OPEN');
  assert.equal(snap.failures, 2);

  breaker.reset();
});
