/**
 * Tests for services/x-search.js (xAI Live Search → X/Twitter) and the
 * `x_search` agent tool.
 *
 * Network is never touched: the service takes an injectable `fetchImpl`,
 * and the tool-level configured path stubs `globalThis.fetch`. The whole
 * suite asserts:
 *   - key gating (XAI_API_KEY) + graceful degradation with no key,
 *   - the Live Search request body (mode:on, sources:[{type:'x'}], …),
 *   - citation normalisation (strings + objects, dedupe, http-only),
 *   - the agent tool's slim, query-free contract.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const xSearch = require('../src/services/x-search');
const xMetrics = require('../src/services/x-search-metrics');
const agentTools = require('../src/services/agents/agent-tools');

const MANAGED_ENV = ['XAI_API_KEY', 'X_SEARCH_RETRY_DISABLED', 'X_SEARCH_MAX_RETRIES', 'X_SEARCH_RETRY_BASE_MS'];
const savedEnv = {};
let savedFetch;

beforeEach(() => {
  for (const k of MANAGED_ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  // Simple tests run single-shot; retry-specific tests opt in explicitly.
  process.env.X_SEARCH_RETRY_DISABLED = '1';
  savedFetch = globalThis.fetch;
  xMetrics.reset();
});

afterEach(() => {
  for (const k of MANAGED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = savedFetch;
  xMetrics.reset();
});

function jsonRes(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

// ── configuration / gating ───────────────────────────────────────────

test('isConfigured reflects XAI_API_KEY', () => {
  assert.equal(xSearch.isConfigured({}), false);
  assert.equal(xSearch.isConfigured({ XAI_API_KEY: 'k' }), true);
});

test('resolveXaiProvider returns base url + model when configured', () => {
  const p = xSearch.resolveXaiProvider({ XAI_API_KEY: 'k' });
  assert.equal(p.configured, true);
  assert.equal(p.baseUrl, 'https://api.x.ai/v1');
  assert.equal(typeof p.model, 'string');
});

test('search degrades gracefully with no key and never calls fetch', async () => {
  let called = false;
  const out = await xSearch.search('openai', { fetchImpl: async () => { called = true; return jsonRes({}); } });
  assert.equal(out.configured, false);
  assert.equal(out.note, xSearch.UNCONFIGURED_NOTE);
  assert.deepEqual(out.results, []);
  assert.equal(called, false);
});

test('search returns a "missing query" note for empty input', async () => {
  const out = await xSearch.search('   ', { env: { XAI_API_KEY: 'k' } });
  assert.equal(out.note, 'missing "query"');
  assert.deepEqual(out.results, []);
});

// ── search_parameters builder ────────────────────────────────────────

test('buildSearchParameters forces live X search, clamps results, maps handles + dates', () => {
  const p = xSearch.buildSearchParameters({
    maxResults: 999,
    handles: ['@elonmusk', 'openai', ''],
    fromDate: '2024-01-01',
    toDate: 'not-a-date',
  });
  assert.equal(p.mode, 'on');
  assert.equal(p.return_citations, true);
  assert.equal(p.max_search_results, 30); // clamped
  assert.deepEqual(p.sources, [{ type: 'x', x_handles: ['elonmusk', 'openai'] }]);
  assert.equal(p.from_date, '2024-01-01');
  assert.equal(p.to_date, undefined); // invalid date dropped
});

// ── citation normalisation ───────────────────────────────────────────

test('normaliseCitations accepts strings + objects, dedupes, drops non-http', () => {
  const rows = xSearch.normaliseCitations({
    citations: [
      'https://x.com/a/status/1',
      'https://x.com/a/status/1', // dup
      { url: 'https://x.com/b/status/2', title: 'B', text: 'hello' },
      'ftp://nope',
      42,
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, 'https://x.com/a/status/1');
  assert.equal(rows[0].source, 'x');
  assert.equal(rows[1].title, 'B');
  assert.equal(rows[1].snippet, 'hello');
});

// ── network path (injected fetch) ────────────────────────────────────

test('search posts a correct Live Search body and parses summary + citations', async () => {
  let seenUrl = '';
  let seenBody = null;
  let seenAuth = '';
  const fetchImpl = async (url, opts) => {
    seenUrl = String(url);
    seenAuth = opts.headers.Authorization;
    seenBody = JSON.parse(opts.body);
    return jsonRes({
      model: 'grok-4.3',
      choices: [{ message: { content: 'People are discussing the launch.' } }],
      citations: ['https://x.com/news/status/123'],
      usage: { total_tokens: 10 },
    });
  };
  const out = await xSearch.search('product launch', {
    env: { XAI_API_KEY: 'secret' },
    fetchImpl,
    maxResults: 5,
  });
  assert.match(seenUrl, /api\.x\.ai\/v1\/chat\/completions$/);
  assert.equal(seenAuth, 'Bearer secret');
  assert.equal(seenBody.search_parameters.sources[0].type, 'x');
  assert.equal(seenBody.search_parameters.max_search_results, 5);
  assert.equal(seenBody.stream, false);
  assert.equal(out.configured, true);
  assert.equal(out.summary, 'People are discussing the launch.');
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].url, 'https://x.com/news/status/123');
});

test('search throws a query-free error on a non-2xx response', async () => {
  const fetchImpl = async () => jsonRes({}, { ok: false, status: 429 });
  await assert.rejects(
    () => xSearch.search('rate limited topic', { env: { XAI_API_KEY: 'k' }, fetchImpl }),
    (err) => {
      assert.match(err.message, /x-search http 429/);
      assert.equal(err.message.includes('rate limited topic'), false);
      return true;
    },
  );
});

// ── agent tool contract ──────────────────────────────────────────────

test('x_search tool is registered in ALL_TOOLS', () => {
  assert.ok(agentTools.TOOLS_BY_NAME.has('x_search'));
  assert.equal(agentTools.x_search.name, 'x_search');
});

test('x_search tool rejects a missing query', async () => {
  const obs = await agentTools.x_search.handler({});
  assert.equal(obs.error, 'missing "query"');
});

test('x_search tool reports configured:false (no throw) when XAI_API_KEY is absent', async () => {
  const obs = await agentTools.x_search.handler({ query: 'breaking news' });
  assert.equal(obs.configured, false);
  assert.equal(obs.count, 0);
  assert.equal(obs.note, xSearch.UNCONFIGURED_NOTE);
});

test('x_search tool returns a slim result on the configured path', async () => {
  process.env.XAI_API_KEY = 'tool-key';
  globalThis.fetch = async () => jsonRes({
    model: 'grok-4.3',
    choices: [{ message: { content: 'Summary here.' } }],
    citations: ['https://x.com/x/status/9', { url: 'https://x.com/y/status/10' }],
  });
  const obs = await agentTools.x_search.handler({ query: 'ai news', maxResults: 8 });
  assert.equal(obs.configured, true);
  assert.equal(obs.summary, 'Summary here.');
  assert.equal(obs.count, 2);
  assert.equal(obs.results[0].source, 'x');
});

// ── source mapping ────────────────────────────────────────────────────

test('buildSearchParameters always includes x and folds in valid extra sources', () => {
  const p = xSearch.buildSearchParameters({ sources: ['web', 'news', 'bogus', 'x'] });
  const types = p.sources.map((s) => s.type);
  assert.deepEqual(types, ['x', 'web', 'news']); // x first, deduped, invalid dropped
});

test('buildSearchParameters honours mode:auto but defaults to on', () => {
  assert.equal(xSearch.buildSearchParameters({}).mode, 'on');
  assert.equal(xSearch.buildSearchParameters({ mode: 'auto' }).mode, 'auto');
  assert.equal(xSearch.buildSearchParameters({ mode: 'nonsense' }).mode, 'on');
});

test('normaliseCitations tags x.com/twitter.com as source:x and others as web', () => {
  const rows = xSearch.normaliseCitations({
    citations: ['https://x.com/a/status/1', 'https://twitter.com/b/status/2', 'https://example.com/post'],
  });
  assert.equal(rows[0].source, 'x');
  assert.equal(rows[1].source, 'x');
  assert.equal(rows[2].source, 'web');
});

// ── resilience ────────────────────────────────────────────────────────

test('classifyXSearchError retries 429/5xx/timeout/network but not 4xx/abort', () => {
  const c = xSearch.classifyXSearchError;
  assert.equal(c({ status: 429 }).retryable, true);
  assert.equal(c({ status: 502 }).retryable, true);
  assert.equal(c({ status: 401 }).retryable, false);
  assert.equal(c(new Error('socket timeout')).retryable, true);
  assert.equal(c(new Error('aborted')).retryable, false);
});

test('search retries a transient 503 then succeeds', async () => {
  delete process.env.X_SEARCH_RETRY_DISABLED;
  process.env.X_SEARCH_MAX_RETRIES = '1';
  process.env.X_SEARCH_RETRY_BASE_MS = '1';
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n === 1) return jsonRes({}, { ok: false, status: 503 });
    return jsonRes({ choices: [{ message: { content: 'ok' } }], citations: ['https://x.com/a/1'] });
  };
  const out = await xSearch.search('topic', { env: { XAI_API_KEY: 'k' }, fetchImpl });
  assert.equal(n, 2);
  assert.equal(out.results.length, 1);
});

test('search does NOT retry a 401 and records an error metric', async () => {
  delete process.env.X_SEARCH_RETRY_DISABLED;
  process.env.X_SEARCH_MAX_RETRIES = '2';
  process.env.X_SEARCH_RETRY_BASE_MS = '1';
  let n = 0;
  const fetchImpl = async () => { n += 1; return jsonRes({}, { ok: false, status: 401 }); };
  await assert.rejects(() => xSearch.search('q', { env: { XAI_API_KEY: 'k' }, fetchImpl }), /x-search http 401/);
  assert.equal(n, 1);
  const snap = xMetrics.snapshot();
  assert.equal(snap.errors, 1);
  assert.equal(snap.topErrorCodes[0].code, 'http_401');
});

// ── metrics integration ───────────────────────────────────────────────

test('a successful search records searches + posts; unconfigured records its own counter', async () => {
  const fetchImpl = async () => jsonRes({
    choices: [{ message: { content: 's' } }],
    citations: ['https://x.com/a/1', 'https://x.com/b/2'],
  });
  await xSearch.search('q', { env: { XAI_API_KEY: 'k' }, fetchImpl });
  await xSearch.search('q2'); // no key → unconfigured
  const snap = xMetrics.snapshot();
  assert.equal(snap.searches, 1);
  assert.equal(snap.posts, 2);
  assert.equal(snap.unconfigured, 1);
  assert.equal(snap.successRate, 1);
});
