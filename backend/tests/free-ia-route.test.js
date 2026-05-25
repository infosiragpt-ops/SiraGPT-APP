'use strict';

// Unit tests for the /api/free-ia/* status endpoint. Uses a minimal
// in-process Express harness — no network, no DB.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const freeIaRoutes = require('../src/routes/free-ia');

function startServer() {
  const app = express();
  app.use('/api/free-ia', freeIaRoutes);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseURL: `http://127.0.0.1:${port}` });
    });
  });
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ status: res.statusCode, body });
        } catch (err) { reject(err); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

test('GET /api/free-ia/status reports disabled when CEREBRAS_API_KEY is unset', async () => {
  const prevKey = process.env.CEREBRAS_API_KEY;
  delete process.env.CEREBRAS_API_KEY;
  const { server, baseURL } = await startServer();
  try {
    const { status, body } = await fetchJSON(`${baseURL}/api/free-ia/status`);
    assert.equal(status, 200);
    assert.equal(body.enabled, false);
    assert.equal(body.reason, 'no_api_key');
    assert.equal(body.provider, 'Cerebras');
    assert.equal(body.model, 'llama-3.1-8b');
    assert.equal(body.displayName, 'Free IA');
    // baseURL is internal-only — must not leak in the response.
    assert.equal(body.baseURL, undefined);
    assert.equal(body.apiKey, undefined);
  } finally {
    server.close();
    if (prevKey !== undefined) process.env.CEREBRAS_API_KEY = prevKey;
  }
});

test('GET /api/free-ia/status reports enabled when CEREBRAS_API_KEY is set', async () => {
  const prevKey = process.env.CEREBRAS_API_KEY;
  process.env.CEREBRAS_API_KEY = 'csk-test-status-endpoint';
  const { server, baseURL } = await startServer();
  try {
    const { status, body } = await fetchJSON(`${baseURL}/api/free-ia/status`);
    assert.equal(status, 200);
    assert.equal(body.enabled, true);
    assert.equal(body.reason, 'ok');
    assert.equal(body.provider, 'Cerebras');
    assert.equal(body.model, 'llama-3.1-8b');
    assert.equal(body.displayName, 'Free IA');
    assert.equal(body.apiKey, undefined, 'API key must never be returned');
  } finally {
    server.close();
    if (prevKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = prevKey;
  }
});

test('GET /api/free-ia/configured returns boolean only', async () => {
  const prevKey = process.env.CEREBRAS_API_KEY;
  process.env.CEREBRAS_API_KEY = 'csk-test-configured';
  const { server, baseURL } = await startServer();
  try {
    const { status, body } = await fetchJSON(`${baseURL}/api/free-ia/configured`);
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ['configured']);
    assert.equal(body.configured, true);
  } finally {
    server.close();
    if (prevKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = prevKey;
  }
});
