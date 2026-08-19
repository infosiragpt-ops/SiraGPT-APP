'use strict';

/**
 * Ratchet 45 — tests for enforce-api-key-rate-limit middleware.
 *
 * Covers:
 *   - JWT/session traffic is bypassed (no consume / audit)
 *   - Per-key override (apiKey.rateLimitPerMinute) takes precedence
 *   - Plan default kicks in when no override is set
 *   - 429 response shape on cap exceeded
 *   - Fail-open on store errors
 *   - Sampled api_key_used audit fires every Nth use
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const mwPath = path.resolve(__dirname, '../src/middleware/enforce-api-key-rate-limit.js');
const dbPath = path.resolve(__dirname, '../src/config/database.js');
const auditPath = path.resolve(__dirname, '../src/utils/audit-log.js');

// Audit-log mock — collect every call.
const auditCalls = [];
const fakeAudit = {
  writeAuditLog: async (prisma, entry) => {
    auditCalls.push(entry);
    return { id: `al_${auditCalls.length}` };
  },
};

// Prisma mock — just needs to exist for the audit writer to see a client.
const prismaMock = { auditLog: { create: async () => ({}) } };

require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: prismaMock };
require.cache[auditPath] = { id: auditPath, filename: auditPath, loaded: true, exports: fakeAudit };

delete require.cache[mwPath];
const {
  enforceApiKeyRateLimit,
  defaultRpmForPlan,
  createResilientApiKeyRateLimitGate,
  resolveLimit,
  AUDIT_SAMPLE_RATE,
  _resetAuditCountersForTests,
  _auditCounterSize,
} = require(mwPath);

function buildReq({
  authMethod = 'api_key',
  apiKey = { id: 'ak_1', prefix: 'sk_test', scopes: ['*'] },
  user = { id: 'u_1', plan: 'FREE' },
  organization = null,
  url = '/api/ai/generate',
} = {}) {
  return { authMethod, apiKey, user, organization, originalUrl: url, url, headers: {} };
}

function buildRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    getHeader(name) { return this.headers[name]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function makeStore(behaviour) {
  return {
    calls: [],
    async consume(key, limit, windowMs, options) {
      this.calls.push({ key, limit, windowMs, options });
      return behaviour(this.calls.length, key, limit);
    },
  };
}

function runMw(mw, req, res) {
  return new Promise((resolve, reject) => {
    Promise.resolve(mw(req, res, (err) => {
      if (err) return reject(err);
      resolve('next');
    })).catch(reject);
    setImmediate(() => {
      if (res.body !== null) resolve('responded');
    });
  });
}

describe('enforce-api-key-rate-limit · helpers', () => {
  test('exports a resilient lazy-init gate for the auth middleware', () => {
    assert.equal(typeof createResilientApiKeyRateLimitGate, 'function');
  });

  test('defaultRpmForPlan respects env overrides + fallback', () => {
    const oldFree = process.env.SIRAGPT_API_KEY_RPM_FREE;
    const oldHard = process.env.SIRAGPT_API_KEY_DEFAULT_RPM;
    process.env.SIRAGPT_API_KEY_RPM_FREE = '17';
    process.env.SIRAGPT_API_KEY_DEFAULT_RPM = '23';
    try {
      assert.equal(defaultRpmForPlan('FREE'), 17);
      assert.equal(defaultRpmForPlan('UNKNOWN'), 23);
      assert.equal(defaultRpmForPlan('PRO'), 600);
      assert.equal(defaultRpmForPlan('ENTERPRISE'), 6000);
    } finally {
      if (oldFree == null) delete process.env.SIRAGPT_API_KEY_RPM_FREE;
      else process.env.SIRAGPT_API_KEY_RPM_FREE = oldFree;
      if (oldHard == null) delete process.env.SIRAGPT_API_KEY_DEFAULT_RPM;
      else process.env.SIRAGPT_API_KEY_DEFAULT_RPM = oldHard;
    }
  });

  test('resolveLimit prefers per-key override', () => {
    const req = buildReq({
      apiKey: { id: 'ak', prefix: 'sk', scopes: ['*'], rateLimitPerMinute: 5 },
    });
    const { limit, source } = resolveLimit(req);
    assert.equal(limit, 5);
    assert.equal(source, 'key');
  });

  test('resolveLimit falls back to plan default when override missing', () => {
    const req = buildReq({
      apiKey: { id: 'ak', prefix: 'sk', scopes: ['*'], rateLimitPerMinute: null },
      organization: { billingPlan: 'ENTERPRISE' },
    });
    const { limit, source } = resolveLimit(req);
    assert.equal(limit, 6000);
    assert.equal(source, 'plan:ENTERPRISE');
  });
});

describe('enforce-api-key-rate-limit · middleware', () => {
  beforeEach(() => {
    auditCalls.length = 0;
    _resetAuditCountersForTests();
  });

  test('JWT/session traffic bypasses both rate limit and audit', async () => {
    const store = makeStore(() => ({ allowed: true, remaining: 60, resetAt: new Date() }));
    const mw = enforceApiKeyRateLimit({ store });
    const req = buildReq({ authMethod: 'session', apiKey: null });
    const res = buildRes();
    const r = await runMw(mw, req, res);
    assert.equal(r, 'next');
    assert.equal(store.calls.length, 0);
    assert.equal(auditCalls.length, 0);
  });

  test('uses per-key override limit when present', async () => {
    const store = makeStore(() => ({ allowed: true, remaining: 4, resetAt: new Date(Date.now() + 60000) }));
    const mw = enforceApiKeyRateLimit({ store });
    const req = buildReq({
      apiKey: { id: 'ak_override', prefix: 'sk_o', scopes: ['*'], rateLimitPerMinute: 5 },
    });
    const res = buildRes();
    await runMw(mw, req, res);
    assert.equal(store.calls.length, 1);
    assert.equal(store.calls[0].limit, 5);
    assert.equal(store.calls[0].key, 'api-key-rpm:ak_override');
    assert.equal(res.getHeader('X-API-Key-RateLimit-Limit'), '5');
    assert.equal(res.getHeader('X-API-Key-RateLimit-Source'), 'key');
  });

  test('uses plan default when override is null', async () => {
    const store = makeStore(() => ({ allowed: true, remaining: 59, resetAt: new Date() }));
    const mw = enforceApiKeyRateLimit({ store });
    const req = buildReq({
      apiKey: { id: 'ak_plan', prefix: 'sk_p', scopes: ['*'], rateLimitPerMinute: null },
      user: { id: 'u', plan: 'FREE' },
    });
    const res = buildRes();
    await runMw(mw, req, res);
    assert.equal(store.calls[0].limit, 60);
    assert.equal(res.getHeader('X-API-Key-RateLimit-Source'), 'plan:FREE');
  });

  test('returns 429 with retry headers when store denies', async () => {
    const future = new Date(Date.now() + 30_000);
    const store = makeStore(() => ({ allowed: false, remaining: 0, resetAt: future }));
    const mw = enforceApiKeyRateLimit({ store });
    const req = buildReq({
      apiKey: { id: 'ak_deny', prefix: 'sk_d', scopes: ['*'], rateLimitPerMinute: 2 },
    });
    req.requestId = 'req_api_key_limit_1';
    const res = buildRes();
    await runMw(mw, req, res);
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'api_key_rate_limited');
    assert.equal(res.body.error, 'api key rate limit exceeded');
    assert.equal(res.body.keyId, 'ak_deny');
    assert.equal(res.body.limitPerMinute, 2);
    assert.equal(res.body.requestId, 'req_api_key_limit_1');
    assert.ok(res.body.retryAfterMs >= 0);
    assert.ok(res.body.retryAfterSec >= 1);
    assert.ok(res.getHeader('Retry-After'));
    assert.equal(res.getHeader('Cache-Control'), 'no-store');
    assert.equal(res.getHeader('X-Content-Type-Options'), 'nosniff');
  });

  test('keeps the explicit nonproduction fail-open policy on store errors', async () => {
    const store = {
      calls: [],
      async consume() {
        this.calls.push(1);
        throw new Error('redis_down');
      },
    };
    const mw = enforceApiKeyRateLimit({
      store,
      env: {
        NODE_ENV: 'test',
        RATE_LIMIT_SENSITIVE_POLICY: 'fail-open',
        REDIS_URL: 'redis://mock',
      },
    });
    const req = buildReq({
      apiKey: { id: 'ak_failopen', prefix: 'sk_f', scopes: ['*'] },
    });
    const res = buildRes();
    const r = await runMw(mw, req, res);
    assert.equal(r, 'next');
    assert.equal(res.statusCode, 200);
  });

  test('fails closed with a value-free 503 when the production store errors', async () => {
    const calls = [];
    const store = {
      async consume(key, limit, windowMs, options) {
        calls.push({ key, limit, windowMs, options });
        throw new Error('redis://user:secret@redis.internal unavailable');
      },
    };
    const env = {
      NODE_ENV: 'production',
      REDIS_URL: 'redis://user:secret@redis.internal:6379',
    };
    const mw = enforceApiKeyRateLimit({ store, env });
    const req = buildReq({
      apiKey: { id: 'ak_failclosed', prefix: 'sk_fc', scopes: ['*'] },
    });
    req.requestId = 'req_api_key_store_down';
    const res = buildRes();

    const result = await runMw(mw, req, res);

    assert.equal(result, 'responded');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.requireDistributed, true);
    assert.equal(calls[0].options.env, env);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'RATE_LIMIT_STORE_UNAVAILABLE');
    assert.equal(res.body.requestId, 'req_api_key_store_down');
    assert.equal(res.getHeader('Cache-Control'), 'no-store');
    assert.equal(res.getHeader('X-Content-Type-Options'), 'nosniff');
    assert.equal(res.getHeader('Retry-After'), '5');
    assert.doesNotMatch(JSON.stringify(res.body), /user|secret|redis\.internal/i);
  });

  test('literal production fails closed and uses the active store-breaker Retry-After', async () => {
    const error = new Error('private redis detail');
    error.code = 'RATE_LIMIT_STORE_UNAVAILABLE';
    error.retryAfterSeconds = 17;
    const store = {
      async consume() {
        throw error;
      },
    };
    const mw = enforceApiKeyRateLimit({
      store,
      env: {
        NODE_ENV: 'production',
        REDIS_URL: 'redis://mock',
        RATE_LIMIT_STORE_RETRY_AFTER_SECONDS: '5',
      },
    });
    const res = buildRes();

    const result = await runMw(mw, buildReq(), res);

    assert.equal(result, 'responded');
    assert.equal(res.statusCode, 503);
    assert.equal(res.getHeader('Retry-After'), '17');
    assert.equal(res.body.retryAfterSec, 17);
  });

  test('passes explicit local memory policy to the store', async () => {
    const store = makeStore(() => ({
      allowed: true,
      remaining: 4,
      resetAt: new Date(Date.now() + 60_000),
    }));
    const mw = enforceApiKeyRateLimit({
      store,
      env: {
        NODE_ENV: 'test',
        RATE_LIMIT_STORE: 'memory',
        RATE_LIMIT_SENSITIVE_POLICY: 'memory',
      },
    });

    const result = await runMw(mw, buildReq(), buildRes());

    assert.equal(result, 'next');
    assert.equal(store.calls[0].options.requireDistributed, false);
    assert.equal(store.calls[0].options.env.RATE_LIMIT_STORE, 'memory');
  });

  test('emits sampled api_key_used audit every N uses', async () => {
    const store = makeStore(() => ({ allowed: true, remaining: 999, resetAt: new Date() }));
    const mw = enforceApiKeyRateLimit({ store });

    for (let i = 0; i < AUDIT_SAMPLE_RATE - 1; i += 1) {
      const res = buildRes();
      // eslint-disable-next-line no-await-in-loop
      await runMw(mw, buildReq({ apiKey: { id: 'ak_audit', prefix: 'sk_a', scopes: ['read'] } }), res);
    }
    // Allow scheduled microtasks (audit writer is async) to flush.
    await new Promise((r) => setImmediate(r));
    assert.equal(auditCalls.length, 0);

    const res = buildRes();
    await runMw(mw, buildReq({ apiKey: { id: 'ak_audit', prefix: 'sk_a', scopes: ['read'] }, url: '/api/ai/generate' }), res);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(auditCalls.length, 1);
    const entry = auditCalls[0];
    assert.equal(entry.action, 'api_key_used');
    assert.equal(entry.actorType, 'api_key');
    assert.equal(entry.resource, 'api_key');
    assert.equal(entry.resourceId, 'ak_audit');
    assert.equal(entry.metadata.keyId, 'ak_audit');
    assert.equal(entry.metadata.prefix, 'sk_a');
    assert.deepEqual(entry.metadata.scope, ['read']);
    assert.equal(entry.metadata.endpoint, '/api/ai/generate');
    assert.equal(entry.metadata.sampledEveryNUses, AUDIT_SAMPLE_RATE);
    assert.equal(entry.metadata.uses, AUDIT_SAMPLE_RATE);
  });

  test('audit counter is per-key (distinct keys do not pollute)', async () => {
    const store = makeStore(() => ({ allowed: true, remaining: 999, resetAt: new Date() }));
    const mw = enforceApiKeyRateLimit({ store });

    // Drive AUDIT_SAMPLE_RATE-1 calls on key A and AUDIT_SAMPLE_RATE-1 on key B.
    for (let i = 0; i < AUDIT_SAMPLE_RATE - 1; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runMw(mw, buildReq({ apiKey: { id: 'ak_A', prefix: 'sk_A', scopes: ['*'] } }), buildRes());
      // eslint-disable-next-line no-await-in-loop
      await runMw(mw, buildReq({ apiKey: { id: 'ak_B', prefix: 'sk_B', scopes: ['*'] } }), buildRes());
    }
    await new Promise((r) => setImmediate(r));
    assert.equal(auditCalls.length, 0);
  });

  test('bounds the in-process audit-use counter map', async () => {
    const store = makeStore(() => ({ allowed: true, remaining: 999, resetAt: new Date() }));
    const mw = enforceApiKeyRateLimit({ store, auditCounterMax: 3 });

    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runMw(mw, buildReq({
        apiKey: { id: `ak_bounded_${i}`, prefix: 'sk_b', scopes: ['read'] },
      }), buildRes());
    }

    assert.equal(_auditCounterSize(), 3);
  });
});

describe('enforce-api-key-rate-limit · resilient auth gate', () => {
  test('returns 503 on production init failure and retries initialization next request', async () => {
    let loads = 0;
    const gate = createResilientApiKeyRateLimitGate({
      env: { NODE_ENV: 'production', RATE_LIMIT_STORE_RETRY_AFTER_SECONDS: '11' },
      loadMiddleware() {
        loads += 1;
        if (loads === 1) throw new Error('module init private detail');
        return (_req, _res, next) => next();
      },
    });

    const firstRes = buildRes();
    const first = await runMw(gate, buildReq(), firstRes);
    assert.equal(first, 'responded');
    assert.equal(firstRes.statusCode, 503);
    assert.equal(firstRes.body.code, 'RATE_LIMIT_STORE_UNAVAILABLE');
    assert.equal(firstRes.getHeader('Retry-After'), '11');

    const second = await runMw(gate, buildReq(), buildRes());
    assert.equal(second, 'next');
    assert.equal(loads, 2, 'failed initialization must not be cached');
  });

  test('returns 503 on unexpected production runtime failure and reloads next request', async () => {
    let loads = 0;
    const gate = createResilientApiKeyRateLimitGate({
      env: { NODE_ENV: 'production' },
      loadMiddleware() {
        loads += 1;
        if (loads === 1) {
          return async () => {
            const error = new Error('runtime private detail');
            error.retryAfterSeconds = 23;
            throw error;
          };
        }
        return (_req, _res, next) => next();
      },
    });

    const firstRes = buildRes();
    await runMw(gate, buildReq(), firstRes);
    assert.equal(firstRes.statusCode, 503);
    assert.equal(firstRes.getHeader('Retry-After'), '23');

    assert.equal(await runMw(gate, buildReq(), buildRes()), 'next');
    assert.equal(loads, 2);
  });
});
