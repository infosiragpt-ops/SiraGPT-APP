/**
 * Tests for services/usage-service.js — token calc + Prisma usage
 * recorder for the AI billing layer.
 *
 * We mock prisma via require-cache injection BEFORE requiring the
 * service so `new PrismaClient()` at module-top picks up our stub.
 * The `@prisma/client` package itself is what gets mocked.
 */

'use strict';

const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const { describe, it, before, after, beforeEach } = require('node:test');

const PRISMA_PATH = require.resolve('@prisma/client');
const USAGE_PATH = require.resolve('../src/services/usage-service');

const prismaMock = {
  apiUsage: { create: async () => null },
  user: {
    update: async () => null,
    findUnique: async () => null,
  },
  // recordUsage now wraps the create+increment in an array-form transaction.
  $transaction: async (ops) => Promise.all(ops),
};

class FakePrismaClient {
  constructor() {
    // Reflect the same surface as the real client.
    return prismaMock;
  }
}

let origPrismaCache;
let origUsageCache;

function installMocks() {
  origPrismaCache = require.cache[PRISMA_PATH];
  origUsageCache = require.cache[USAGE_PATH];
  const m = new Module(PRISMA_PATH);
  m.filename = PRISMA_PATH;
  m.loaded = true;
  m.exports = { PrismaClient: FakePrismaClient };
  m.paths = Module._nodeModulePaths(path.dirname(PRISMA_PATH));
  require.cache[PRISMA_PATH] = m;
  delete require.cache[USAGE_PATH];
}

function restoreMocks() {
  if (origPrismaCache) require.cache[PRISMA_PATH] = origPrismaCache;
  else delete require.cache[PRISMA_PATH];
  if (origUsageCache) require.cache[USAGE_PATH] = origUsageCache;
  else delete require.cache[USAGE_PATH];
}

let usage;

before(() => {
  installMocks();
  usage = require('../src/services/usage-service');
});

after(() => {
  restoreMocks();
});

beforeEach(() => {
  prismaMock.apiUsage.create = async () => null;
  prismaMock.user.update = async () => null;
  prismaMock.user.findUnique = async () => null;
});

// ── calculateTextTokens ──────────────────────────────────────────

describe('calculateTextTokens', () => {
  it('returns a positive token count for a short text', () => {
    const n = usage.calculateTextTokens('hello world');
    assert.equal(typeof n, 'number');
    assert.ok(n > 0);
  });

  it('returns 0 for empty input', () => {
    assert.equal(usage.calculateTextTokens(''), 0);
  });

  it('longer text yields more tokens', () => {
    const short = usage.calculateTextTokens('hi');
    const long = usage.calculateTextTokens('this is a much longer sentence with many tokens');
    assert.ok(long > short);
  });

  it('OpenRouter-style "vendor/model" names are mapped to gpt-4 for tiktoken', () => {
    // The function's behavior: any slash means OpenRouter → fall back
    // to gpt-4 encoding. Verify it doesn't throw.
    const n = usage.calculateTextTokens('hello', 'anthropic/claude-sonnet-4-5');
    assert.equal(typeof n, 'number');
    assert.ok(n > 0);
  });

  it('uses fallback (≈chars/4) on unknown model name', () => {
    const muted = console.warn;
    console.warn = () => {};
    try {
      // 'definitely-not-a-tiktoken-model' is not a valid encoding name
      // for tiktoken; the function must fall back without throwing.
      const text = 'abcdefghijklmnopqrst';  // 20 chars
      const n = usage.calculateTextTokens(text, 'totally-unknown-future-model-v99');
      // Fallback formula: ceil(len/4) = 5.
      assert.equal(n, 5);
    } finally {
      console.warn = muted;
    }
  });

  it('default model is gpt-3.5-turbo', () => {
    // We can't directly assert the model used, but we can verify no
    // throw + result is deterministic for the default path.
    const a = usage.calculateTextTokens('test text');
    const b = usage.calculateTextTokens('test text', 'gpt-3.5-turbo');
    assert.equal(a, b);
  });
});

// ── calculateAudioTokens ─────────────────────────────────────────

describe('calculateAudioTokens', () => {
  it('uses 100 tokens per minute when duration provided', () => {
    // duration 120s = 2 minutes → ceil(120/60)*100 = 200.
    assert.equal(usage.calculateAudioTokens({ duration: 120 }), 200);
    // 1.5 min → ceil(1.5)*100 = 200.
    assert.equal(usage.calculateAudioTokens({ duration: 90 }), 200);
  });

  it('falls back to text-token calc when textLength provided (no duration)', () => {
    // textLength is passed as a string to calculateTextTokens.
    const n = usage.calculateAudioTokens({ textLength: 'some short text' });
    assert.ok(n > 0);
  });

  it('default to 500 when no duration / textLength', () => {
    assert.equal(usage.calculateAudioTokens({}), 500);
    assert.equal(usage.calculateAudioTokens(null), 500);
    assert.equal(usage.calculateAudioTokens(undefined), 500);
  });

  it('zero duration triggers fallback paths (textLength or default)', () => {
    assert.equal(usage.calculateAudioTokens({ duration: 0 }), 500);
    assert.equal(usage.calculateAudioTokens({ duration: 0, textLength: 'hi' }) > 0, true);
  });
});

// ── calculateVideoTokens ─────────────────────────────────────────

describe('calculateVideoTokens', () => {
  it('uses 1000 tokens per minute when duration provided', () => {
    assert.equal(usage.calculateVideoTokens({ duration: 60 }), 1000);
    assert.equal(usage.calculateVideoTokens({ duration: 180 }), 3000);
  });

  it('rounds up partial minutes', () => {
    assert.equal(usage.calculateVideoTokens({ duration: 30 }), 1000);  // ceil(0.5) = 1
    assert.equal(usage.calculateVideoTokens({ duration: 61 }), 2000);  // ceil(61/60) = 2
  });

  it('defaults to 2000 when no duration', () => {
    assert.equal(usage.calculateVideoTokens({}), 2000);
    assert.equal(usage.calculateVideoTokens(null), 2000);
    assert.equal(usage.calculateVideoTokens(undefined), 2000);
  });
});

// ── recordUsage ──────────────────────────────────────────────────

describe('recordUsage', () => {
  it('writes apiUsage row AND increments user.apiUsage in same call', async () => {
    const ops = [];
    prismaMock.apiUsage.create = async (a) => { ops.push({ op: 'apiUsage.create', a }); return null; };
    prismaMock.user.update = async (a) => { ops.push({ op: 'user.update', a }); return null; };
    await usage.recordUsage('u1', 'gpt-4o', 500, 0.025);
    assert.equal(ops.length, 2);
    assert.deepEqual(ops[0].a, {
      data: { userId: 'u1', model: 'gpt-4o', tokens: 500, cost: 0.025 },
    });
    assert.equal(ops[1].a.where.id, 'u1');
    assert.deepEqual(ops[1].a.data.apiUsage, { increment: 500 });
  });

  it('throws a wrapped error when apiUsage.create fails', async () => {
    const _origError = console.error;
    console.error = () => {};
    prismaMock.apiUsage.create = async () => { throw new Error('db down'); };
    try {
      await assert.rejects(
        () => usage.recordUsage('u1', 'gpt-4o', 100, 0.01),
        /Failed to record usage/,
      );
    } finally {
      console.error = _origError;
    }
  });

  it('throws a wrapped error when user.update fails', async () => {
    const _origError = console.error;
    console.error = () => {};
    prismaMock.user.update = async () => { throw new Error('user not found'); };
    try {
      await assert.rejects(
        () => usage.recordUsage('u1', 'gpt-4o', 100, 0.01),
        /Failed to record usage/,
      );
    } finally {
      console.error = _origError;
    }
  });
});

// ── hasEnoughTokens ──────────────────────────────────────────────

describe('hasEnoughTokens', () => {
  it('returns true when user has more than required', async () => {
    prismaMock.user.findUnique = async () => ({ availableTokens: 1000 });
    assert.equal(await usage.hasEnoughTokens('u1', 500), true);
  });

  it('returns true at the exact boundary (>= required)', async () => {
    prismaMock.user.findUnique = async () => ({ availableTokens: 500 });
    assert.equal(await usage.hasEnoughTokens('u1', 500), true);
  });

  it('returns false when below', async () => {
    prismaMock.user.findUnique = async () => ({ availableTokens: 499 });
    assert.equal(await usage.hasEnoughTokens('u1', 500), false);
  });

  it('returns false when user is not found (no implicit credit)', async () => {
    const muted = console.warn;
    console.warn = () => {};
    try {
      prismaMock.user.findUnique = async () => null;
      assert.equal(await usage.hasEnoughTokens('missing-user', 1), false);
    } finally {
      console.warn = muted;
    }
  });

  it('throws a wrapped error when prisma fails', async () => {
    const _origError = console.error;
    console.error = () => {};
    prismaMock.user.findUnique = async () => { throw new Error('connection lost'); };
    try {
      await assert.rejects(
        () => usage.hasEnoughTokens('u1', 1),
        /Failed to check user tokens/,
      );
    } finally {
      console.error = _origError;
    }
  });
});

// ── deductTokens ─────────────────────────────────────────────────

describe('deductTokens', () => {
  it('decrements availableTokens by the supplied amount', async () => {
    let captured;
    prismaMock.user.update = async (a) => { captured = a; return null; };
    await usage.deductTokens('u1', 250);
    assert.equal(captured.where.id, 'u1');
    assert.deepEqual(captured.data.availableTokens, { decrement: 250 });
  });

  it('throws a wrapped error when prisma fails', async () => {
    const _origError = console.error;
    console.error = () => {};
    prismaMock.user.update = async () => { throw new Error('boom'); };
    try {
      await assert.rejects(
        () => usage.deductTokens('u1', 100),
        /Failed to deduct tokens/,
      );
    } finally {
      console.error = _origError;
    }
  });
});
