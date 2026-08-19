/**
 * Tests for RepoCoder-style iterative retrieval.
 *
 * We stub both the LLM (for the draft step) and the rag-service
 * retrieve() so the test doesn't touch the real vector store. The
 * assertions focus on the two-pass structure and the RRF fusion call.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

// Stub rag-service BEFORE requiring repo-retriever, since the module
// caches the reference on require().
const ragCalls = [];
let nextRetrieveResult = null;
let rrfCaptured = null;
require.cache[require.resolve('../src/services/rag-service')] = {
  exports: {
    retrieve: async (userId, collection, query, k) => {
      ragCalls.push({ userId, collection, query, k });
      if (Array.isArray(nextRetrieveResult) && nextRetrieveResult.length > 0) {
        return nextRetrieveResult.shift();
      }
      return [];
    },
    fuseByRRF: (a, b, opts) => {
      rrfCaptured = { a, b, opts };
      // Simplified fusion for tests: interleave + cap to k.
      const fused = [];
      const maxLen = Math.max(a.length, b.length);
      for (let i = 0; i < maxLen; i++) {
        if (a[i]) fused.push(a[i]);
        if (b[i]) fused.push(b[i]);
      }
      return fused.slice(0, opts?.k || fused.length);
    },
  },
};

const rr = require('../src/services/agents/repo-retriever');

function resetStubs() {
  ragCalls.length = 0;
  nextRetrieveResult = null;
  rrfCaptured = null;
}

function scriptedLLM(content) {
  return {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content } }],
    }) } },
  };
}

// ─── buildSecondPassQuery ────────────────────────────────────────────────

test('buildSecondPassQuery: concatenates query + identifiers + draft tail', () => {
  const q = rr.buildSecondPassQuery('refactor auth middleware', {
    identifiers: ['AuthMiddleware', 'verifyToken', 'SessionStore'],
    code: 'class AuthMiddleware {\n  async verify(req, res, next) {}\n}',
  });
  assert.match(q, /refactor auth middleware/);
  assert.match(q, /identifiers: AuthMiddleware verifyToken SessionStore/);
  assert.match(q, /draft:\s*class AuthMiddleware/);
});

test('buildSecondPassQuery: missing draft → only the original query', () => {
  const q = rr.buildSecondPassQuery('x', { identifiers: [], code: '' });
  assert.equal(q.trim(), 'x');
});

test('buildSecondPassQuery: caps identifiers at 12', () => {
  const ids = Array.from({ length: 20 }, (_, i) => `id${i}`);
  const q = rr.buildSecondPassQuery('q', { identifiers: ids, code: '' });
  // Count "idN" tokens in the output.
  const found = (q.match(/\bid\d+\b/g) || []).length;
  assert.equal(found, 12);
});

// ─── draftCandidate ──────────────────────────────────────────────────────

test('draftCandidate: returns empty when openai missing', async () => {
  const r = await rr.draftCandidate({ openai: null, query: 'x' });
  assert.deepEqual(r, { code: '', identifiers: [] });
});

test('draftCandidate: parses JSON payload', async () => {
  const openai = scriptedLLM(JSON.stringify({
    code: 'class Foo {}',
    identifiers: ['Foo', 'bar', null, 42],
  }));
  const r = await rr.draftCandidate({ openai, query: 'need Foo' });
  assert.equal(r.code, 'class Foo {}');
  // null and number coerced via String() but filtered by .filter(Boolean)
  assert.deepEqual(r.identifiers, ['Foo', 'bar', '42']);
});

// ─── retrieveIterative: two passes + fusion ──────────────────────────────

test('retrieveIterative: runs pass A, drafts, runs pass B, fuses', async () => {
  resetStubs();
  nextRetrieveResult = [
    [
      { source: 'auth/login.ts', text: 'class LoginController {}', score: 0.8 },
    ],
    [
      { source: 'auth/middleware.ts', text: 'class AuthMiddleware {}', score: 0.9 },
      { source: 'auth/session.ts', text: 'class SessionStore {}', score: 0.7 },
    ],
  ];
  const openai = scriptedLLM(JSON.stringify({
    code: 'class AuthMiddleware {}',
    identifiers: ['AuthMiddleware', 'SessionStore'],
  }));

  const r = await rr.retrieveIterative({
    openai,
    userId: 'u1',
    collection: 'proj',
    query: 'add 2FA support to our auth middleware',
    k: 10,
    kPerPass: 5,
  });

  assert.equal(ragCalls.length, 2);
  assert.equal(ragCalls[0].query, 'add 2FA support to our auth middleware');
  assert.match(ragCalls[1].query, /AuthMiddleware/);
  assert.equal(r.passA.length, 1);
  assert.equal(r.passB.length, 2);
  assert.ok(r.passages.length >= 1);
  assert.ok(r.stages.some(s => /pass1/.test(s)));
  assert.ok(r.stages.some(s => /draft/.test(s)));
  assert.ok(r.stages.some(s => /pass2/.test(s)));
  assert.ok(rrfCaptured, 'RRF fusion should have been invoked');
});

test('retrieveIterative: skipDraft=true runs only pass A', async () => {
  resetStubs();
  nextRetrieveResult = [
    [{ source: 'a.ts', text: 'x', score: 0.5 }],
  ];
  const openai = scriptedLLM('{"code":"no","identifiers":[]}');

  const r = await rr.retrieveIterative({
    openai,
    userId: 'u',
    collection: 'c',
    query: 'x',
    k: 5,
    skipDraft: true,
  });
  assert.equal(ragCalls.length, 1, 'only pass 1 should have been called');
  assert.equal(r.passB.length, 0);
  assert.equal(r.draft.code, '');
});

test('retrieveIterative: externalDraft bypasses the drafter LLM', async () => {
  resetStubs();
  nextRetrieveResult = [
    [{ source: 'a.ts', text: 'x', score: 0.5 }],
    [{ source: 'b.ts', text: 'y', score: 0.5 }],
  ];
  // LLM that would throw if accidentally called
  const openai = {
    chat: { completions: { create: async () => { throw new Error('should not be called'); } } },
  };
  const r = await rr.retrieveIterative({
    openai,
    userId: 'u',
    collection: 'c',
    query: 'x',
    externalDraft: { code: 'class X {}', identifiers: ['X', 'Y'] },
  });
  assert.equal(r.draft.code, 'class X {}');
  assert.ok(r.stages.includes('draft: external'));
  assert.equal(ragCalls.length, 2);
});

test('retrieveIterative: empty query short-circuits to empty result', async () => {
  resetStubs();
  const r = await rr.retrieveIterative({
    openai: scriptedLLM('{}'),
    userId: 'u',
    collection: 'c',
    query: '',
  });
  assert.equal(r.passages.length, 0);
  assert.equal(ragCalls.length, 0, 'no RAG calls for empty query');
});
