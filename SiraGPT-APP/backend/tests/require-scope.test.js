'use strict';

/**
 * Tests for backend/src/middleware/require-scope.js — cycle 88
 * API-key scope enforcement.
 *
 *  • JWT/session requests bypass the scope check entirely
 *  • API-key requests are rejected with 403 when the scope is missing
 *  • The wildcard '*' grants every scope
 *  • A colon-namespace wildcard (e.g. 'ai:*') covers 'ai:generate'
 *  • Each API-key request increments
 *    `siragpt_api_key_requests_total{prefix}` regardless of outcome
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const metricsPath = path.resolve(__dirname, '../src/utils/metrics.js');
const mwPath = path.resolve(__dirname, '../src/middleware/require-scope.js');

delete require.cache[metricsPath];
delete require.cache[mwPath];

const metrics = require(metricsPath);
const { requireScope, hasScope } = require(mwPath);

function buildReq({ authMethod, scopes, prefix = 'sk_test_abcd' } = {}) {
  return {
    authMethod,
    apiKey: authMethod === 'api_key' ? { prefix, scopes } : undefined,
  };
}

function buildRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function readCounter(prefix) {
  const text = metrics.renderText();
  const re = new RegExp(`siragpt_api_key_requests_total\\{prefix="${prefix}"\\} (\\d+(?:\\.\\d+)?)`);
  const m = text.match(re);
  return m ? Number(m[1]) : 0;
}

describe('requireScope · hasScope helper', () => {
  test('returns false for empty/invalid scope arrays', () => {
    assert.equal(hasScope(undefined, 'read'), false);
    assert.equal(hasScope([], 'read'), false);
    assert.equal(hasScope(null, 'read'), false);
  });

  test('wildcard "*" grants every scope', () => {
    assert.equal(hasScope(['*'], 'ai:generate'), true);
    assert.equal(hasScope(['*'], 'admin'), true);
  });

  test('exact match passes', () => {
    assert.equal(hasScope(['read', 'write'], 'write'), true);
    assert.equal(hasScope(['ai:generate'], 'ai:generate'), true);
  });

  test('colon-namespace wildcard ai:* covers ai:generate', () => {
    assert.equal(hasScope(['ai:*'], 'ai:generate'), true);
    assert.equal(hasScope(['files:*'], 'ai:generate'), false);
  });
});

describe('requireScope · middleware', () => {
  beforeEach(() => {
    // Reset the counter series before each test so increments are
    // independently observable.
    try { metrics._reset && metrics._reset(); } catch (_) { /* noop */ }
  });

  test('throws on invalid needed argument', () => {
    assert.throws(() => requireScope(''), /non-empty string/);
    assert.throws(() => requireScope(undefined), /non-empty string/);
  });

  test('JWT/session requests bypass scope checks (no counter tick)', () => {
    const mw = requireScope('ai:generate');
    const req = { authMethod: 'jwt' };
    const res = buildRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(readCounter('sk_test_abcd'), 0);
  });

  test('rejects API-key requests missing the required scope (403)', () => {
    const mw = requireScope('ai:generate');
    const req = buildReq({ authMethod: 'api_key', scopes: ['read'] });
    const res = buildRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'insufficient_scope');
    assert.equal(res.body.required, 'ai:generate');
    // Counter ticks regardless of outcome.
    assert.equal(readCounter('sk_test_abcd'), 1);
  });

  test('allows API-key requests with exact scope', () => {
    const mw = requireScope('files:write');
    const req = buildReq({ authMethod: 'api_key', scopes: ['files:write'] });
    const res = buildRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(readCounter('sk_test_abcd'), 1);
  });

  test('wildcard "*" scope grants any required scope', () => {
    const mw = requireScope('chats:read');
    const req = buildReq({ authMethod: 'api_key', scopes: ['*'] });
    const res = buildRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(readCounter('sk_test_abcd'), 1);
  });

  test('counter increments per request and is labelled by prefix', () => {
    const mw = requireScope('chats:read');
    const reqA = buildReq({ authMethod: 'api_key', scopes: ['chats:read'], prefix: 'sk_aaa' });
    const reqB = buildReq({ authMethod: 'api_key', scopes: ['chats:read'], prefix: 'sk_bbb' });
    mw(reqA, buildRes(), () => {});
    mw(reqA, buildRes(), () => {});
    mw(reqB, buildRes(), () => {});
    assert.equal(readCounter('sk_aaa'), 2);
    assert.equal(readCounter('sk_bbb'), 1);
  });

  test('missing apiKey object on api_key request → 403 (defensive)', () => {
    const mw = requireScope('ai:generate');
    const req = { authMethod: 'api_key' }; // no apiKey object
    const res = buildRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    // Counter still ticks with 'unknown' prefix.
    assert.equal(readCounter('unknown'), 1);
  });
});
