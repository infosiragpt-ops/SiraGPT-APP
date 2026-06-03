'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const rag = require('../src/services/rag-service');

test('embed client options bound the request timeout (no 10-min SDK default) and stay idempotent-retryable', () => {
  const prevT = process.env.SIRA_EMBED_TIMEOUT_MS;
  const prevR = process.env.SIRA_EMBED_MAX_RETRIES;
  delete process.env.SIRA_EMBED_TIMEOUT_MS;
  delete process.env.SIRA_EMBED_MAX_RETRIES;
  try {
    const opts = rag._embedClientOptions();
    assert.equal(opts.timeout, 30000, 'default request timeout is 30s, not the SDK 10-min default');
    assert.equal(opts.maxRetries, 2, 'embeddings are idempotent — keep the SDK retry');

    process.env.SIRA_EMBED_TIMEOUT_MS = '5000';
    process.env.SIRA_EMBED_MAX_RETRIES = '0';
    const tuned = rag._embedClientOptions();
    assert.equal(tuned.timeout, 5000, 'timeout is env-tunable');
    assert.equal(tuned.maxRetries, 0, 'retries are env-tunable');
  } finally {
    if (prevT === undefined) delete process.env.SIRA_EMBED_TIMEOUT_MS; else process.env.SIRA_EMBED_TIMEOUT_MS = prevT;
    if (prevR === undefined) delete process.env.SIRA_EMBED_MAX_RETRIES; else process.env.SIRA_EMBED_MAX_RETRIES = prevR;
  }
});
