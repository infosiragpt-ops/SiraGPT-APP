/**
 * Tests for the Cohere Rerank wrapper.
 *
 * No real API call: every test injects a fake fetch via
 * options.fetchImpl. Coverage:
 *   - buildRequest shape (URL, headers, body) for various input forms
 *   - normalizeResults parses + filters Cohere's response defensively
 *   - isAvailable mirrors COHERE_API_KEY presence
 *   - rerank() end-to-end: success, HTTP error, invalid JSON, timeout
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const cr = require('../src/services/rag/cohere-rerank');

function withEnv(temp, fn) {
  const saved = {};
  for (const k of Object.keys(temp)) {
    saved[k] = process.env[k];
    if (temp[k] === undefined) delete process.env[k];
    else process.env[k] = temp[k];
  }
  try { return fn(); }
  finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function fakeOk(body) {
  return async (_url, _init) => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function fakeStatus(status, body = '') {
  return async () => ({
    ok: false,
    status,
    json: async () => { throw new Error('not json'); },
    text: async () => body,
  });
}

// ── isAvailable ───────────────────────────────────────────────────────────

test('isAvailable mirrors COHERE_API_KEY presence', () => {
  withEnv({ COHERE_API_KEY: undefined }, () => assert.equal(cr.isAvailable(process.env), false));
  withEnv({ COHERE_API_KEY: '   ' }, () => assert.equal(cr.isAvailable(process.env), false));
  withEnv({ COHERE_API_KEY: 'co-test' }, () => assert.equal(cr.isAvailable(process.env), true));
});

// ── buildRequest ──────────────────────────────────────────────────────────

test('buildRequest builds POST /v2/rerank with bearer auth + JSON body', () => {
  const { url, init } = cr.buildRequest({
    apiKey: 'co-test',
    query: 'pricing for enterprise',
    documents: ['Plan A details', 'Plan B details'],
    topN: 1,
  });
  assert.match(url, /\/v2\/rerank$/);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer co-test');
  const body = JSON.parse(init.body);
  assert.equal(body.model, cr.DEFAULT_MODEL);
  assert.equal(body.query, 'pricing for enterprise');
  assert.deepEqual(body.documents, ['Plan A details', 'Plan B details']);
  assert.equal(body.top_n, 1);
});

test('buildRequest accepts {text} document objects and clips top_n to documents.length', () => {
  const { init } = cr.buildRequest({
    apiKey: 'co-test',
    query: 'q',
    documents: [{ text: 'one' }, { text: 'two' }],
    topN: 99,
  });
  const body = JSON.parse(init.body);
  assert.deepEqual(body.documents, ['one', 'two']);
  assert.equal(body.top_n, 2);
});

test('buildRequest truncates oversized documents to MAX_DOC_CHARS', () => {
  const huge = 'A'.repeat(cr.MAX_DOC_CHARS + 1000);
  const { init } = cr.buildRequest({
    apiKey: 'co-test',
    query: 'q',
    documents: [huge],
  });
  const body = JSON.parse(init.body);
  assert.equal(body.documents[0].length, cr.MAX_DOC_CHARS);
});

test('buildRequest rejects missing apiKey / query / documents with typed codes', () => {
  assert.throws(() => cr.buildRequest({ query: 'q', documents: ['d'] }), (err) => err.code === 'cohere_rerank_disabled');
  assert.throws(() => cr.buildRequest({ apiKey: 'k', query: '', documents: ['d'] }), (err) => err.code === 'cohere_rerank_bad_args');
  assert.throws(() => cr.buildRequest({ apiKey: 'k', query: 'q', documents: [] }), (err) => err.code === 'cohere_rerank_bad_args');
  assert.throws(() => cr.buildRequest({ apiKey: 'k', query: 'q', documents: [null, 12, ''] }), (err) => err.code === 'cohere_rerank_bad_args');
});

// ── normalizeResults ──────────────────────────────────────────────────────

test('normalizeResults attaches document text by index', () => {
  const out = cr.normalizeResults(
    [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.4 }],
    ['first', 'second'],
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].document, 'second');
  assert.equal(out[0].score, 0.9);
  assert.equal(out[1].document, 'first');
});

test('normalizeResults drops items with bad index or score', () => {
  const out = cr.normalizeResults(
    [
      { index: 5, relevance_score: 0.5 },           // out of range
      { index: 0, relevance_score: 'not number' },   // bad score
      { index: 0, relevance_score: 0.7 },            // ok
      null,
      'garbage',
    ],
    ['a', 'b'],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].index, 0);
});

test('normalizeResults handles {text} document inputs', () => {
  const out = cr.normalizeResults(
    [{ index: 0, relevance_score: 0.8 }],
    [{ text: 'wrapped' }],
  );
  assert.equal(out[0].document, 'wrapped');
});

test('normalizeResults returns [] for non-array input', () => {
  assert.deepEqual(cr.normalizeResults(null, ['a']), []);
  assert.deepEqual(cr.normalizeResults('garbage', ['a']), []);
});

// ── rerank() end-to-end ───────────────────────────────────────────────────

test('rerank returns normalized results on a clean response', async () => {
  const out = await cr.rerank({
    query: 'unemployment rate Q2 2025',
    documents: ['Q2 unemployment fell', 'Pricing details', 'Refund policy'],
    options: {
      apiKey: 'co-test',
      fetchImpl: fakeOk({
        results: [
          { index: 0, relevance_score: 0.95 },
          { index: 2, relevance_score: 0.10 },
        ],
      }),
    },
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].document, 'Q2 unemployment fell');
  assert.equal(out[0].score, 0.95);
});

test('rerank rejects with cohere_rerank_disabled when no apiKey is available', async () => {
  await withEnv({ COHERE_API_KEY: undefined }, async () => {
    await assert.rejects(
      () => cr.rerank({ query: 'q', documents: ['d'], options: { fetchImpl: fakeOk({ results: [] }) } }),
      (err) => err.code === 'cohere_rerank_disabled',
    );
  });
});

test('rerank rejects with cohere_rerank_http_failed on non-2xx', async () => {
  await assert.rejects(
    () => cr.rerank({
      query: 'q',
      documents: ['d'],
      options: { apiKey: 'co-test', fetchImpl: fakeStatus(429, '{"message":"slow down"}') },
    }),
    (err) => {
      assert.equal(err.code, 'cohere_rerank_http_failed');
      assert.equal(err.status, 429);
      return true;
    },
  );
});

test('rerank rejects with cohere_rerank_invalid_response on non-JSON body', async () => {
  await assert.rejects(
    () => cr.rerank({
      query: 'q',
      documents: ['d'],
      options: {
        apiKey: 'co-test',
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => { throw new Error('not json'); },
          text: async () => '<html>error</html>',
        }),
      },
    }),
    (err) => err.code === 'cohere_rerank_invalid_response',
  );
});

test('rerank wraps fetch network errors with cohere_rerank_http_failed', async () => {
  await assert.rejects(
    () => cr.rerank({
      query: 'q',
      documents: ['d'],
      options: {
        apiKey: 'co-test',
        fetchImpl: async () => { throw new Error('ECONNRESET'); },
      },
    }),
    (err) => {
      assert.equal(err.code, 'cohere_rerank_http_failed');
      assert.ok(err.cause);
      return true;
    },
  );
});

test('rerank honours an external AbortSignal (caller cancel)', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort('caller'), 5);
  await assert.rejects(
    () => cr.rerank({
      query: 'q',
      documents: ['d'],
      options: {
        apiKey: 'co-test',
        signal: ac.signal,
        fetchImpl: (_url, init) => new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('AbortError')));
        }),
      },
    }),
    (err) => err.code === 'cohere_rerank_http_failed',
  );
});

test('rerank detaches the external-signal listener after a successful call', async () => {
  const { getEventListeners } = require('node:events');
  const ac = new AbortController();
  const out = await cr.rerank({
    query: 'q',
    documents: ['a', 'b'],
    options: {
      apiKey: 'co-test',
      signal: ac.signal,
      fetchImpl: fakeOk({ results: [{ index: 0, relevance_score: 0.9 }] }),
    },
  });
  assert.ok(Array.isArray(out));
  assert.equal(
    getEventListeners(ac.signal, 'abort').length,
    0,
    'abort listener must be removed once rerank settles (no leak on reused signals)',
  );
});
