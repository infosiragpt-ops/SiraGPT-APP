'use strict';

// Tests for the /api/free-ia billing-preview endpoints (thin wiring over the
// feature-cost-estimator, which was previously a fully-orphaned module).
// In-process Express harness — no network, no DB (the /digest route, which
// needs auth + DB, is not exercised here).

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
      resolve({ server, baseURL: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* non-json */ }
        resolve({ status: res.statusCode, body });
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

test('GET /plans returns the pricing table + popular plan', async () => {
  const { server, baseURL } = await startServer();
  try {
    const { status, body } = await getJSON(`${baseURL}/api/free-ia/plans`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.plans) && body.plans.length >= 3);
    assert.equal(typeof body.popular, 'string');
  } finally { server.close(); }
});

test('GET /budget returns a plan for a valid budget and 400s bad input', async () => {
  const { server, baseURL } = await startServer();
  try {
    const ok = await getJSON(`${baseURL}/api/free-ia/budget?maxUsd=5`);
    assert.equal(ok.status, 200);
    assert.ok(ok.body.plan);
    const bad = await getJSON(`${baseURL}/api/free-ia/budget?maxUsd=abc`);
    assert.equal(bad.status, 400);
  } finally { server.close(); }
});

test('GET /compare requires from+to', async () => {
  const { server, baseURL } = await startServer();
  try {
    const ok = await getJSON(`${baseURL}/api/free-ia/compare?from=PRO&to=PRO_MAX`);
    assert.equal(ok.status, 200);
    assert.ok(ok.body.comparison);
    const bad = await getJSON(`${baseURL}/api/free-ia/compare?from=PRO`);
    assert.equal(bad.status, 400);
  } finally { server.close(); }
});

test('GET /affords returns affordability + verdict', async () => {
  const { server, baseURL } = await startServer();
  try {
    const { status, body } = await getJSON(`${baseURL}/api/free-ia/affords?plan=PRO&feature=paraphrase&calls=100&avgTextLength=500`);
    assert.equal(status, 200);
    assert.ok('affords' in body);
    assert.equal(typeof body.verdict, 'string');
    const bad = await getJSON(`${baseURL}/api/free-ia/affords?plan=PRO`);
    assert.equal(bad.status, 400);
  } finally { server.close(); }
});

test('GET /faq returns the FAQ entries', async () => {
  const { server, baseURL } = await startServer();
  try {
    const { status, body } = await getJSON(`${baseURL}/api/free-ia/faq`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.faq) && body.faq.length > 0);
  } finally { server.close(); }
});
