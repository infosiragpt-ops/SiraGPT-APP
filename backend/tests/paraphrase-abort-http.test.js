'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createParaphraseHandler } = require('../src/routes/paraphrase');

function provider() {
  return {
    client: { chat: { completions: { async create() {} } } },
    metadata: {
      provider: 'OpenAI',
      model: 'paid-test-model',
      forcedFallback: false,
    },
  };
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

function requestJson(server, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'POST',
      path: '/paraphrase',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode,
          body: JSON.parse(text),
        });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

function buildApp({ runPipeline, onRequest }) {
  const app = express();
  app.use(express.json());
  const handler = createParaphraseHandler({
    env: { PARAPHRASE_PROVIDER_TIMEOUT_MS: '2000' },
    resolveProvider: () => provider(),
    createRewriteFn: () => async () => 'unused',
    runPipeline,
    cacheIdempotentResponse: async () => ({ ok: true }),
    refundLastCharge: async () => ({ ok: true, txn: { id: 'refund-http' } }),
  });
  app.post('/paraphrase', async (req, res, next) => {
    req.user = { id: 'http-user' };
    req.id = 'http-request';
    req._chargedCredits = {
      feature: 'paraphrase',
      amount: 3,
      txn: {
        id: 'http-charge',
        userId: 'http-user',
        amount: -3n,
        idempotencyKey: 'credit-idem:v1:test',
        metadata: {
          feature: 'paraphrase',
          requestHash: 'http-request-hash',
          path: 'paid',
          idempotency: { state: 'in_progress' },
        },
      },
      replay: false,
      requestHash: 'http-request-hash',
    };
    onRequest?.(req, res);
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  });
  return app;
}

test('a normal HTTP request with a delayed provider remains 200 after request-body close', async () => {
  let sawAbort = false;
  const app = buildApp({
    runPipeline: ({ signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve({
          ok: true,
          output: 'A delayed but valid rewritten response.',
          similarity: 0.1,
          maxSimilarity: 0.72,
        });
      }, 75);
      signal.addEventListener('abort', () => {
        sawAbort = true;
        clearTimeout(timer);
        reject(signal.reason || new Error('aborted'));
      }, { once: true });
    }),
  });
  const server = await listen(app);
  try {
    const response = await requestJson(server, {
      text: 'This source paragraph is long enough to pass request validation.',
      mode: 'standard',
      language: 'en',
      idempotencyKey: 'http-delayed-key',
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.output, 'A delayed but valid rewritten response.');
    assert.equal(sawAbort, false);
  } finally {
    await close(server);
  }
});

test('an aborted HTTP client cancels the in-flight provider signal', async () => {
  let providerStartedResolve;
  const providerStarted = new Promise((resolve) => { providerStartedResolve = resolve; });
  let providerCancelledResolve;
  const providerCancelled = new Promise((resolve) => { providerCancelledResolve = resolve; });
  const app = buildApp({
    runPipeline: ({ signal }) => new Promise((_resolve, reject) => {
      providerStartedResolve();
      signal.addEventListener('abort', () => {
        providerCancelledResolve(signal.reason);
        reject(signal.reason || new Error('aborted'));
      }, { once: true });
    }),
  });
  const server = await listen(app);
  try {
    const payload = JSON.stringify({
      text: 'This source paragraph is long enough to pass request validation.',
      mode: 'standard',
      language: 'en',
      idempotencyKey: 'http-abort-key',
    });
    const request = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'POST',
      path: '/paraphrase',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    });
    request.on('error', () => {});
    request.end(payload);
    await providerStarted;
    request.destroy();

    const reason = await Promise.race([
      providerCancelled,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('provider was not cancelled')), 1000);
      }),
    ]);
    assert.equal(reason?.code, 'REQUEST_ABORTED');
  } finally {
    await close(server);
  }
});
