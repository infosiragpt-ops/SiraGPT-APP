'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createGenerateLogger,
  safeErrorFields,
  sanitizeGenerateFields,
  summarizeGenerateRequest,
} = require('../src/services/ai/generate-request-observability');

function captureLogger() {
  const records = [];
  const logger = {};
  for (const level of ['info', 'warn', 'error']) {
    logger[level] = (payload, message) => records.push({ level, payload, message });
  }
  return { logger, records };
}

test('generate observability keeps only allowlisted non-content fields', () => {
  const safe = sanitizeGenerateFields({
    promptChars: 72,
    attachmentCount: 2,
    hasChat: true,
    retryable: false,
    status: 503,
    reasonCode: 'queue_wait',
    prompt: 'PRIVATE_PROMPT_SENTINEL',
    content: 'PRIVATE_CONTENT_SENTINEL',
    filename: 'private-thesis.docx',
    path: '/private/customer/private-thesis.docx',
    userId: 'user-private-id',
    chatId: 'chat-private-id',
    streamId: 'stream-private-id',
    model: 'private-model',
    provider: 'private-provider',
    nested: { apiKey: 'sk-private' },
  });

  assert.deepEqual(safe, {
    promptChars: 72,
    attachmentCount: 2,
    hasChat: true,
    retryable: false,
    status: 503,
    reasonCode: 'queue_wait',
  });
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_|private-|sk-private/);
});

test('generate request summary records shape, never values or identifiers', () => {
  const summary = summarizeGenerateRequest({
    prompt: 'PRIVATE_PROMPT_SENTINEL',
    files: [{ name: 'private.docx' }, { path: '/private/image.png' }],
    chatId: 'chat-private-id',
    streamId: 'stream-private-id',
    idempotencyKey: 'idem-private-id',
    regenerate: true,
    resume: true,
    publicWeb: false,
    authenticated: true,
  });

  assert.deepEqual(summary, {
    promptChars: 23,
    attachmentCount: 2,
    hasChat: true,
    hasStream: true,
    hasIdempotencyKey: true,
    regenerate: true,
    resume: true,
    publicWeb: false,
    authenticated: true,
  });
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_|private-id|private\.docx/);
});

test('generate logger emits a structured event without serializing discarded fields', () => {
  const { logger, records } = captureLogger();
  const log = createGenerateLogger({ logger });

  const payload = log.warn('queue.rejected', {
    status: 503,
    retryable: true,
    reasonCode: 'queue_wait',
    prompt: 'PRIVATE_PROMPT_SENTINEL',
    chatId: 'chat-private-id',
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].level, 'warn');
  assert.equal(records[0].message, 'ai.generate');
  assert.deepEqual(records[0].payload, payload);
  assert.deepEqual(payload, {
    event: 'ai.generate.queue.rejected',
    status: 503,
    retryable: true,
    reasonCode: 'queue_wait',
  });
  assert.doesNotMatch(JSON.stringify(records[0]), /PRIVATE_|chat-private-id/);
});

test('generate logger normalizes event and enum-like fields', () => {
  const { logger, records } = captureLogger();
  const log = createGenerateLogger({ logger });

  log.info('request accepted with private text', {
    source: 'response close with private text',
    status: Number.POSITIVE_INFINITY,
    durationMs: -10,
  });

  assert.equal(records[0].payload.event, 'ai.generate.invalid_event');
  assert.equal(records[0].payload.source, undefined);
  assert.equal(records[0].payload.status, undefined);
  assert.equal(records[0].payload.durationMs, 0);
});

test('enum-shaped private values are rejected unless explicitly enumerated', () => {
  const safe = sanitizeGenerateFields({
    source: 'private_prompt_sentinel',
    reasonCode: 'customer_12345',
    action: 'secret_project_alpha',
    mode: 'direct',
  });

  assert.deepEqual(safe, { mode: 'direct' });
});

test('closed enums retain the operational categories emitted by generate', () => {
  assert.deepEqual(sanitizeGenerateFields({
    action: 'execute',
    source: 'heuristic_override',
    reasonCode: 'duplicate_turn',
    detectedLanguage: 'es',
    resolvedLanguage: 'en',
    mode: 'self_consistency',
    outcome: 'degraded',
  }), {
    action: 'execute',
    source: 'heuristic_override',
    reasonCode: 'duplicate_turn',
    detectedLanguage: 'es',
    resolvedLanguage: 'en',
    mode: 'self_consistency',
    outcome: 'degraded',
  });
});

test('closed enums retain every compacting source emitted by generate', () => {
  assert.deepEqual(sanitizeGenerateFields({ source: 'llm' }), { source: 'llm' });
  assert.deepEqual(sanitizeGenerateFields({ source: 'extractive' }), { source: 'extractive' });
});

test('closed enums retain only the finite spreadsheet recovery operations', () => {
  const operations = [
    'count_region_rows',
    'max_total_row',
    'min_total_row',
    'sum_rows',
    'difference_rows',
    'max_period_for_row',
  ];

  for (const action of operations) {
    assert.deepEqual(sanitizeGenerateFields({ action }), { action });
  }
  assert.deepEqual(sanitizeGenerateFields({ action: 'customer_formula_private' }), {});
});

test('unknown enum-shaped events are reduced to a fixed invalid event', () => {
  const { logger, records } = captureLogger();
  const log = createGenerateLogger({ logger });

  log.info('private_prompt_sentinel', { success: true });

  assert.deepEqual(records[0].payload, {
    event: 'ai.generate.invalid_event',
    success: true,
  });
});

test('numeric telemetry is type-strict and bounded', () => {
  assert.deepEqual(sanitizeGenerateFields({
    promptChars: '42',
    status: 999,
    durationMs: 999_999_999,
    score: -5,
  }), {
    durationMs: 604_800_000,
    score: 0,
  });
});

test('hostile values and accessors cannot break request handling', () => {
  assert.doesNotThrow(() => sanitizeGenerateFields({ status: Symbol('private') }));
  assert.deepEqual(sanitizeGenerateFields({ status: Symbol('private') }), {});

  const hostile = new Error('PRIVATE_PROMPT_SENTINEL');
  Object.defineProperty(hostile, 'code', {
    get() { throw new Error('hostile accessor'); },
  });
  assert.doesNotThrow(() => safeErrorFields(hostile));
  assert.deepEqual(safeErrorFields(hostile), { errorName: 'error' });

  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  assert.doesNotThrow(() => summarizeGenerateRequest({ files: revoked.proxy }));
  assert.equal(summarizeGenerateRequest({ files: revoked.proxy }).attachmentCount, 0);

  const revokedInput = Proxy.revocable({}, {});
  revokedInput.revoke();
  assert.doesNotThrow(() => summarizeGenerateRequest(revokedInput.proxy));
  assert.doesNotThrow(() => createGenerateLogger(null));
});

test('logger failures and hostile field objects remain best-effort', () => {
  const log = createGenerateLogger({
    logger: {
      info() { throw new Error('sink failed'); },
      warn() { throw new Error('sink failed'); },
      error() { throw new Error('sink failed'); },
    },
  });

  const fields = {};
  Object.defineProperty(fields, 'status', {
    enumerable: true,
    get() { throw new Error('hostile field'); },
  });
  assert.doesNotThrow(() => log.info('request.accepted', fields));
  assert.deepEqual(log.info('request.accepted', fields), {
    event: 'ai.generate.telemetry_failed',
  });
});

test('safe error fields never expose error messages or attached payloads', () => {
  const error = new Error('PRIVATE_PROMPT_SENTINEL at /private/customer/file.docx');
  error.name = 'ProviderRequestError';
  error.code = 'UPSTREAM_TIMEOUT';
  error.status = 504;
  error.response = { data: { apiKey: 'sk-private', prompt: 'PRIVATE_PROMPT_SENTINEL' } };

  const safe = safeErrorFields(error);
  assert.deepEqual(safe, {
    errorName: 'provider_request_error',
    status: 504,
  });
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_|private\/customer|sk-private/);
});

test('private enum-shaped error codes never cross the boundary', () => {
  const error = new Error('PRIVATE_PROMPT_SENTINEL');
  error.code = 'client_secret_project_alpha';

  assert.deepEqual(safeErrorFields(error), { errorName: 'error' });
});
