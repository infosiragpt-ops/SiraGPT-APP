'use strict';

/**
 * Ratchet 44 — verifies the API-key request latency histogram
 * (`siragpt_api_key_request_duration_seconds{prefix,method,statusBand}`)
 * is observed by the requireScope middleware on every authenticated
 * API-key request, and that the active-api-keys gauge
 * (`siragpt_api_keys_active_total`) is refreshed correctly.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');

const metricsPath = path.resolve(__dirname, '../src/utils/metrics.js');
const mwPath = path.resolve(__dirname, '../src/middleware/require-scope.js');

delete require.cache[metricsPath];
delete require.cache[mwPath];

const metrics = require(metricsPath);
const { requireScope } = require(mwPath);

function buildReq({ authMethod, scopes, prefix = 'sk_test_abcd', method = 'GET' } = {}) {
  return {
    method,
    authMethod,
    apiKey: authMethod === 'api_key' ? { prefix, scopes } : undefined,
  };
}

function buildRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.status = function status(code) { this.statusCode = code; return this; };
  res.json = function json(payload) { this.body = payload; return this; };
  return res;
}

function findHistogramBucket(name, labelSubstr) {
  const text = metrics.renderText();
  const lines = text.split('\n').filter((l) => l.startsWith(`${name}_count`));
  const target = labelSubstr ? lines.find((l) => l.includes(labelSubstr)) : lines[0];
  if (!target) return null;
  const parts = target.trim().split(/\s+/);
  return Number(parts[parts.length - 1]);
}

function findGaugeValue(name) {
  const text = metrics.renderText();
  const lines = text
    .split('\n')
    .filter((l) => l.startsWith(name) && !l.startsWith(`${name}_`));
  if (!lines[0]) return null;
  const parts = lines[0].trim().split(/\s+/);
  return Number(parts[parts.length - 1]);
}

describe('requireScope · latency histogram (ratchet 44)', () => {
  beforeEach(() => metrics._reset());

  test('histogram is registered with prefix/method/statusBand labels', () => {
    const text = metrics.renderText();
    assert.match(text, /# TYPE siragpt_api_key_request_duration_seconds histogram/);
  });

  test('observes one sample per successful API-key request', async () => {
    const mw = requireScope('chats:read');
    const req = buildReq({ authMethod: 'api_key', scopes: ['chats:read'], prefix: 'sk_aaa', method: 'POST' });
    const res = buildRes();
    mw(req, res, () => {});
    res.emit('finish');
    const count = findHistogramBucket(
      'siragpt_api_key_request_duration_seconds',
      'prefix="sk_aaa",method="POST",statusBand="2xx"',
    );
    assert.equal(count, 1);
  });

  test('observes a 4xx band when scope check fails', () => {
    const mw = requireScope('ai:generate');
    const req = buildReq({ authMethod: 'api_key', scopes: ['read'], prefix: 'sk_bad', method: 'GET' });
    const res = buildRes();
    mw(req, res, () => {});
    res.emit('finish');
    const count = findHistogramBucket(
      'siragpt_api_key_request_duration_seconds',
      'prefix="sk_bad",method="GET",statusBand="4xx"',
    );
    assert.equal(count, 1);
  });

  test('JWT/session requests do not observe latency samples', () => {
    const mw = requireScope('ai:generate');
    const req = { authMethod: 'jwt', method: 'GET' };
    const res = buildRes();
    mw(req, res, () => {});
    res.emit('finish');
    const count = findHistogramBucket('siragpt_api_key_request_duration_seconds');
    assert.equal(count, null);
  });

  test('histogram only fires once even if both finish and close emit', () => {
    const mw = requireScope('files:write');
    const req = buildReq({ authMethod: 'api_key', scopes: ['files:write'], prefix: 'sk_once', method: 'PUT' });
    const res = buildRes();
    mw(req, res, () => {});
    res.emit('finish');
    res.emit('close');
    const count = findHistogramBucket(
      'siragpt_api_key_request_duration_seconds',
      'prefix="sk_once",method="PUT",statusBand="2xx"',
    );
    assert.equal(count, 1);
  });

  test('missing apiKey object still observes with prefix=unknown', () => {
    const mw = requireScope('ai:generate');
    const req = { authMethod: 'api_key', method: 'GET' };
    const res = buildRes();
    mw(req, res, () => {});
    res.emit('finish');
    const count = findHistogramBucket(
      'siragpt_api_key_request_duration_seconds',
      'prefix="unknown",method="GET",statusBand="4xx"',
    );
    assert.equal(count, 1);
  });
});

describe('refreshActiveApiKeysGauge · ratchet 44', () => {
  beforeEach(() => metrics._reset());

  test('gauge is registered', () => {
    const text = metrics.renderText();
    assert.match(text, /# TYPE siragpt_api_keys_active_total gauge/);
  });

  test('sets the gauge to the count of live api keys', async () => {
    const prisma = {
      apiKey: {
        count: async ({ where }) => {
          assert.equal(where.deletedAt, null);
          assert.ok(Array.isArray(where.OR));
          assert.equal(where.OR[0].expiresAt, null);
          assert.ok(where.OR[1].expiresAt && where.OR[1].expiresAt.gt instanceof Date);
          return 12;
        },
      },
    };
    const v = await metrics.refreshActiveApiKeysGauge(prisma);
    assert.equal(v, 12);
    assert.equal(findGaugeValue('siragpt_api_keys_active_total'), 12);
  });

  test('no-ops on missing prisma client', async () => {
    assert.equal(await metrics.refreshActiveApiKeysGauge(null), null);
    assert.equal(await metrics.refreshActiveApiKeysGauge({}), null);
  });

  test('swallows prisma errors and returns null', async () => {
    const prisma = { apiKey: { count: async () => { throw new Error('db down'); } } };
    const v = await metrics.refreshActiveApiKeysGauge(prisma);
    assert.equal(v, null);
  });

  test('coerces non-finite counts to 0 and clamps negatives', async () => {
    const nanPrisma = { apiKey: { count: async () => Number.NaN } };
    assert.equal(await metrics.refreshActiveApiKeysGauge(nanPrisma), 0);
    assert.equal(findGaugeValue('siragpt_api_keys_active_total'), 0);

    const negPrisma = { apiKey: { count: async () => -3 } };
    assert.equal(await metrics.refreshActiveApiKeysGauge(negPrisma), 0);
    assert.equal(findGaugeValue('siragpt_api_keys_active_total'), 0);
  });
});
