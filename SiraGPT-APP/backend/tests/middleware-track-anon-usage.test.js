'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Stub prisma BEFORE requiring the middleware so it captures our stub.
const prisma = require('../src/config/database');
const { trackAnonUsage } = require('../src/middleware/trackAnonUsage');

function freshStore() {
  return new Map();
}

function installPrismaStub(store) {
  prisma.anonymousUsage = {
    async findUnique({ where }) {
      return store.get(where.anonId) || null;
    },
    async create({ data }) {
      const record = { id: 'rec-' + data.anonId, usedQueries: 0, ...data };
      store.set(data.anonId, record);
      return record;
    },
    async update({ where, data }) {
      const cur = store.get(where.anonId) || { anonId: where.anonId, usedQueries: 0 };
      let updated = { ...cur };
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && 'increment' in v) {
          updated[k] = (updated[k] || 0) + v.increment;
        } else {
          updated[k] = v;
        }
      }
      store.set(where.anonId, updated);
      return updated;
    },
  };
}

function makeReq(overrides = {}) {
  return {
    user: overrides.user ?? null,
    cookies: overrides.cookies || {},
    ip: overrides.ip || '127.0.0.1',
    headers: overrides.headers || { 'user-agent': 'test-agent' },
    get(name) { return overrides.headers?.[name.toLowerCase()] || overrides.headers?.[name] || null; },
    ...overrides,
  };
}

function makeRes() {
  const captured = { statusCode: 200, body: null, headers: {}, cookies: {} };
  const res = {
    status(code) { captured.statusCode = code; return this; },
    json(body) { captured.body = body; return this; },
    setHeader(name, value) { captured.headers[name] = value; return this; },
    cookie(name, value, opts) { captured.cookies[name] = { value, opts }; return this; },
  };
  return { res, captured };
}

function makeNext() {
  const calls = [];
  return { next: () => calls.push(true), calls };
}

test('exports trackAnonUsage', () => {
  assert.equal(typeof trackAnonUsage, 'function');
});

test('authenticated requests skip the anonymous-usage path entirely', async () => {
  const store = freshStore();
  installPrismaStub(store);
  const req = makeReq({ user: { id: 'u1' } });
  const { res, captured } = makeRes();
  const { next, calls } = makeNext();

  await trackAnonUsage(req, res, next);

  assert.equal(calls.length, 1, 'next() must be called for authed user');
  assert.equal(captured.statusCode, 200);
  assert.equal(store.size, 0, 'must not touch the anonymousUsage store');
  assert.equal(req.anonymous, undefined);
});

test('first anonymous request creates a record, sets cookie + headers, exposes req.anonymous', async () => {
  const store = freshStore();
  installPrismaStub(store);
  const req = makeReq({ cookies: { anon_id: 'anon-fixed' } });
  const { res, captured } = makeRes();
  const { next, calls } = makeNext();

  await trackAnonUsage(req, res, next);

  assert.equal(calls.length, 1);
  assert.ok(captured.cookies.anon_id, 'must set anon_id cookie');
  assert.equal(captured.cookies.anon_id.value, 'anon-fixed');
  assert.equal(captured.cookies.anon_id.opts.httpOnly, true);
  assert.equal(captured.headers['X-Anon-Limit'], 2);
  assert.equal(captured.headers['X-Anon-Remaining'], 1, 'after first hit, 1 remaining of 2');
  assert.equal(req.anonymous.anonId, 'anon-fixed');
  assert.equal(req.anonymous.used, 1);
  assert.equal(req.anonymous.remaining, 1);
  assert.equal(req.anonymous.limit, 2);
});

test('reads anon id from x-anon-id header when cookie is absent', async () => {
  const store = freshStore();
  installPrismaStub(store);
  const req = makeReq({ headers: { 'x-anon-id': 'header-anon', 'user-agent': 'ua' } });
  const { res, captured } = makeRes();
  const { next } = makeNext();

  await trackAnonUsage(req, res, next);

  assert.equal(req.anonymous.anonId, 'header-anon');
  assert.equal(captured.cookies.anon_id.value, 'header-anon');
});

test('generates a fresh UUID when neither cookie nor header provides an id', async () => {
  const store = freshStore();
  installPrismaStub(store);
  const req = makeReq();
  const { res, captured } = makeRes();
  const { next } = makeNext();

  await trackAnonUsage(req, res, next);

  assert.ok(req.anonymous.anonId, 'must auto-generate an anon id');
  assert.match(req.anonymous.anonId, /^[0-9a-f-]{36}$/i);
  assert.equal(captured.cookies.anon_id.value, req.anonymous.anonId);
});

test('blocks with 401 + ANON_LIMIT_REACHED once usedQueries reaches the default limit (2)', async () => {
  const store = freshStore();
  installPrismaStub(store);
  // Pre-fill the store with a record at-or-above the limit.
  store.set('anon-x', { id: 'rec', anonId: 'anon-x', usedQueries: 2 });
  const req = makeReq({ cookies: { anon_id: 'anon-x' } });
  const { res, captured } = makeRes();
  const { next, calls } = makeNext();

  await trackAnonUsage(req, res, next);

  assert.equal(calls.length, 0, 'next() must NOT be called when blocking');
  assert.equal(captured.statusCode, 401);
  assert.equal(captured.body.code, 'ANON_LIMIT_REACHED');
  assert.equal(captured.body.limit, 2);
});

test('returns 500 when prisma throws', async () => {
  prisma.anonymousUsage = {
    async findUnique() { throw new Error('db down'); },
  };
  const req = makeReq();
  const { res, captured } = makeRes();
  const { next, calls } = makeNext();

  // Silence the console.error noise the middleware emits on the error path
  const origConsoleError = console.error;
  console.error = () => {};
  try {
    await trackAnonUsage(req, res, next);
  } finally {
    console.error = origConsoleError;
  }

  assert.equal(calls.length, 0);
  assert.equal(captured.statusCode, 500);
  assert.equal(captured.body.error, 'Anonymous usage tracking failed');
});
