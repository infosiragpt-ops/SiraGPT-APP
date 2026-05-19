'use strict';

/**
 * Ratchet 45 — tests for the sampled per-scope last-used aggregate
 * baked into requireScope(). The middleware fires off a 1-in-N
 * Prisma update to `ApiKey.usedScopes` on successful scope checks.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const mwPath = path.resolve(__dirname, '../src/middleware/require-scope.js');
const dbPath = path.resolve(__dirname, '../src/config/database.js');

// Stub the prisma database module BEFORE first require of the middleware.
const fakePrisma = {
  _findCalls: [],
  _updateCalls: [],
  _row: null,
  apiKey: {
    async findUnique(args) {
      fakePrisma._findCalls.push(args);
      return fakePrisma._row;
    },
    async update(args) {
      fakePrisma._updateCalls.push(args);
      fakePrisma._row = { usedScopes: args.data.usedScopes };
      return { id: args.where.id, usedScopes: args.data.usedScopes };
    },
  },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function patched(request, parent, ...rest) {
  if (request === '../config/database' && parent && parent.filename === mwPath) {
    return dbPath;
  }
  return origResolve.call(this, request, parent, ...rest);
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakePrisma };

delete require.cache[mwPath];
const { requireScope, _resetSampleCounterForTests, USED_SCOPE_SAMPLE_RATE } = require(mwPath);

function buildReq({ scopes, id = 'ak_1', prefix = 'sk_test' } = {}) {
  return { authMethod: 'api_key', apiKey: { id, prefix, scopes } };
}
function buildRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const tick = () => new Promise((r) => setImmediate(r));

describe('requireScope · sampled usedScopes tracking', () => {
  beforeEach(() => {
    _resetSampleCounterForTests();
    fakePrisma._findCalls.length = 0;
    fakePrisma._updateCalls.length = 0;
    fakePrisma._row = null;
  });

  test('fires sampled update once every N successful checks', async () => {
    const mw = requireScope('ai:generate');
    const req = buildReq({ scopes: ['ai:generate'], id: 'ak_sample' });

    // First N-1 calls: no sampled write.
    for (let i = 0; i < USED_SCOPE_SAMPLE_RATE - 1; i += 1) {
      mw(req, buildRes(), () => {});
    }
    await tick();
    assert.equal(fakePrisma._updateCalls.length, 0);

    // Nth call: fires the fire-and-forget update.
    mw(req, buildRes(), () => {});
    await tick(); await tick();
    assert.equal(fakePrisma._updateCalls.length, 1);
    const update = fakePrisma._updateCalls[0];
    assert.equal(update.where.id, 'ak_sample');
    assert.ok(update.data.usedScopes);
    assert.equal(update.data.usedScopes['ai:generate'].count, USED_SCOPE_SAMPLE_RATE);
    assert.ok(update.data.usedScopes['ai:generate'].lastUsedAt);
  });

  test('failed scope checks do NOT count toward the sample window', async () => {
    const mw = requireScope('ai:generate');
    const req = buildReq({ scopes: ['read'], id: 'ak_fail' }); // wrong scope

    for (let i = 0; i < USED_SCOPE_SAMPLE_RATE * 2; i += 1) {
      mw(req, buildRes(), () => {});
    }
    await tick();
    assert.equal(fakePrisma._updateCalls.length, 0);
  });

  test('aggregates per-scope across distinct keys', async () => {
    const mwGen = requireScope('ai:generate');
    const mwRead = requireScope('chats:read');

    // Drive 2*N successes split across two scopes on the same key.
    for (let i = 0; i < USED_SCOPE_SAMPLE_RATE; i += 1) {
      mwGen(buildReq({ scopes: ['*'], id: 'ak_agg' }), buildRes(), () => {});
    }
    await tick(); await tick();
    for (let i = 0; i < USED_SCOPE_SAMPLE_RATE; i += 1) {
      mwRead(buildReq({ scopes: ['*'], id: 'ak_agg' }), buildRes(), () => {});
    }
    await tick(); await tick();

    assert.equal(fakePrisma._updateCalls.length, 2);
    const merged = fakePrisma._updateCalls[1].data.usedScopes;
    assert.equal(merged['ai:generate'].count, USED_SCOPE_SAMPLE_RATE);
    assert.equal(merged['chats:read'].count, USED_SCOPE_SAMPLE_RATE);
  });

  test('skips tracking when apiKey.id is missing (defensive)', async () => {
    const mw = requireScope('ai:generate');
    const req = { authMethod: 'api_key', apiKey: { scopes: ['*'], prefix: 'sk_x' } };
    for (let i = 0; i < USED_SCOPE_SAMPLE_RATE; i += 1) {
      mw(req, buildRes(), () => {});
    }
    await tick();
    assert.equal(fakePrisma._updateCalls.length, 0);
  });
});
