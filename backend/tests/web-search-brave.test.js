/**
 * Tests for the Brave Search provider + its integration into the
 * web-search adapter chain.
 *
 * Brave is key-gated (BRAVE_SEARCH_API_KEY). These tests:
 *   - stub node-fetch via require.cache BEFORE loading the provider so
 *     the network is never touched,
 *   - assert the provider normalises Brave's `{ web: { results } }`
 *     shape into the standard { title, url, snippet, source:'brave' },
 *   - assert it sends the X-Subscription-Token header and returns []
 *     (without any fetch) when no key is configured,
 *   - assert the adapter includes/excludes Brave from its provider list
 *     purely on the presence of the key.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// --- node-fetch stub --------------------------------------------------
const fetchPath = require.resolve('node-fetch');
let fetchImpl = async () => { throw new Error('fetch not mocked'); };
let fetchCalls = [];
require.cache[fetchPath] = {
  id: fetchPath,
  filename: fetchPath,
  loaded: true,
  exports: (...args) => { fetchCalls.push(args); return fetchImpl(...args); },
};

// Load AFTER the stub so the provider picks up the fake fetch.
const brave = require('../src/services/agents/web-search/providers/brave');
const webSearch = require('../src/services/agents/web-search');

const KEY_ENV = 'BRAVE_SEARCH_API_KEY';
const ALT_ENV = 'BRAVE_API_KEY';
const MANAGED_ENV = [
  KEY_ENV, ALT_ENV,
  'BRAVE_SEARCH_RETRY_DISABLED', 'BRAVE_SEARCH_MAX_RETRIES',
  'BRAVE_SEARCH_RETRY_BASE_MS', 'BRAVE_SEARCH_TIMEOUT_MS',
];
const savedEnv = {};

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

beforeEach(() => {
  for (const k of MANAGED_ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  // Simple tests run single-shot; retry-specific tests opt in explicitly.
  process.env.BRAVE_SEARCH_RETRY_DISABLED = '1';
  fetchCalls = [];
  fetchImpl = async () => { throw new Error('fetch not mocked'); };
});

afterEach(() => {
  for (const k of MANAGED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  webSearch.resetProviders();
  webSearch.clearCache();
});

// --- pure mapping -----------------------------------------------------

test('mapResults normalises Brave web results into the standard envelope', () => {
  const rows = brave._internal.mapResults({
    web: {
      results: [
        { title: 'Example <strong>Site</strong>', url: 'https://example.com', description: 'A <b>great</b> result &amp; more' },
        { title: 'Second', url: 'https://second.test', description: 'Second snippet' },
      ],
    },
  }, 5);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Example Site');
  assert.equal(rows[0].url, 'https://example.com');
  assert.equal(rows[0].snippet, 'A great result & more');
  assert.equal(rows[0].source, 'brave');
});

test('mapResults drops non-http urls, dedupes, and caps to maxResults', () => {
  const rows = brave._internal.mapResults({
    web: {
      results: [
        { title: 'ok', url: 'https://a.test', description: '' },
        { title: 'js', url: 'javascript:alert(1)', description: 'bad' },
        { title: 'dup', url: 'https://a.test', description: 'dupe' },
        { title: 'b', url: 'https://b.test', description: '' },
        { title: 'c', url: 'https://c.test', description: '' },
      ],
    },
  }, 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, 'https://a.test');
  assert.equal(rows[1].url, 'https://b.test');
});

test('mapResults returns [] when the body has no web results', () => {
  assert.deepEqual(brave._internal.mapResults({}, 5), []);
  assert.deepEqual(brave._internal.mapResults({ web: {} }, 5), []);
  assert.deepEqual(brave._internal.mapResults(null, 5), []);
});

// --- key gating -------------------------------------------------------

test('enabled getter + hasBraveKey reflect the env key (primary and alias)', () => {
  assert.equal(brave.enabled, false);
  assert.equal(brave._internal.hasBraveKey(), false);
  process.env[KEY_ENV] = 'abc123';
  assert.equal(brave.enabled, true);
  assert.equal(brave._internal.hasBraveKey(), true);
  delete process.env[KEY_ENV];
  process.env[ALT_ENV] = 'fallback-key';
  assert.equal(brave.enabled, true);
});

test('search returns [] without ever calling fetch when no key is set', async () => {
  const out = await brave.search('anything', { maxResults: 5 });
  assert.deepEqual(out, []);
  assert.equal(fetchCalls.length, 0, 'fetch must not be called without a key');
});

// --- network path (mocked) -------------------------------------------

test('search sends the subscription token header and maps the response', async () => {
  process.env[KEY_ENV] = 'secret-token-xyz';
  fetchImpl = async (url, opts) => {
    assert.match(String(url), /api\.search\.brave\.com/);
    assert.match(String(url), /[?&]q=ai\b|[?&]q=ai$/);
    assert.equal(opts.headers['X-Subscription-Token'], 'secret-token-xyz');
    assert.equal(opts.headers.Accept, 'application/json');
    return jsonResponse({
      web: { results: [{ title: 'AI', url: 'https://ai.test', description: 'about ai' }] },
    });
  };
  const out = await brave.search('ai', { maxResults: 3 });
  assert.equal(fetchCalls.length, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://ai.test');
  assert.equal(out[0].source, 'brave');
});

test('search maps locale to search_lang + country query params', async () => {
  process.env[KEY_ENV] = 'k';
  let seenUrl = '';
  fetchImpl = async (url) => {
    seenUrl = String(url);
    return jsonResponse({ web: { results: [] } });
  };
  await brave.search('hola', { locale: 'es-ES' });
  assert.match(seenUrl, /search_lang=es/);
  assert.match(seenUrl, /country=ES/);
});

test('search throws a query-free error on non-2xx so the adapter can fall through', async () => {
  process.env[KEY_ENV] = 'k';
  fetchImpl = async () => jsonResponse({}, { status: 429 });
  await assert.rejects(() => brave.search('q'), /brave http 429/);
});

// --- adapter integration ---------------------------------------------

test('adapter EXCLUDES brave from the provider list when no key is set', () => {
  webSearch.resetProviders();
  const ids = webSearch.getProviders().map((p) => p.id);
  assert.equal(ids.includes('brave'), false);
  assert.equal(ids.includes('duckduckgo'), true, 'free DDG fallback stays in the chain');
});

test('adapter INCLUDES brave at the head of the general-web tier when key is set', () => {
  process.env[KEY_ENV] = 'present';
  webSearch.resetProviders();
  const providers = webSearch.getProviders();
  const ids = providers.map((p) => p.id);
  assert.equal(ids.includes('brave'), true);
  // Brave (priority 8) must come before DuckDuckGo (priority 10).
  const braveIdx = ids.indexOf('brave');
  const ddgIdx = ids.indexOf('duckduckgo');
  assert.ok(braveIdx >= 0 && ddgIdx >= 0 && braveIdx < ddgIdx, `brave(${braveIdx}) should precede ddg(${ddgIdx})`);
});

test('adapter prefers brave results over later providers when key is set', async () => {
  process.env[KEY_ENV] = 'present';
  webSearch.clearCache();
  webSearch.setProviders([
    {
      id: 'brave', name: 'Brave Search', priority: 8, enabled: true,
      async search() { return [{ title: 'Brave', url: 'https://brave.test', snippet: 'b', source: 'brave' }]; },
    },
    {
      id: 'duckduckgo', name: 'DDG', priority: 10, enabled: true,
      async search() { return [{ title: 'DDG', url: 'https://ddg.test', snippet: 'd', source: 'duckduckgo' }]; },
    },
  ]);
  const out = await webSearch.search('q');
  assert.equal(out.provider, 'brave');
  assert.equal(out.results[0].url, 'https://brave.test');
});

// ── freshness normalisation ──────────────────────────────────────────

test('normaliseFreshness maps aliases (incl. bilingual) and validates date ranges', () => {
  const f = brave._internal.normaliseFreshness;
  assert.equal(f('pw'), 'pw');
  assert.equal(f('week'), 'pw');
  assert.equal(f('semana'), 'pw');
  assert.equal(f('día'), 'pd');
  assert.equal(f('YEAR'), 'py');
  assert.equal(f('2024-01-01to2024-03-31'), '2024-01-01to2024-03-31');
  assert.equal(f('garbage'), null);
  assert.equal(f(''), null);
  assert.equal(f(null), null);
});

// ── error classification ─────────────────────────────────────────────

test('classifyBraveError retries 429/5xx/timeout/network but not 4xx/abort', () => {
  const c = brave._internal.classifyBraveError;
  assert.equal(c({ status: 429 }).retryable, true);
  assert.equal(c({ status: 503 }).retryable, true);
  assert.equal(c({ status: 400 }).retryable, false);
  assert.equal(c({ status: 401 }).retryable, false);
  assert.equal(c(new Error('connect ETIMEDOUT, timeout')).retryable, true);
  assert.equal(c(new Error('fetch failed: ECONNRESET')).retryable, true);
  assert.equal(c(new Error('The operation was aborted')).retryable, false);
});

// ── richer result mapping ────────────────────────────────────────────

test('mapResults merges extra_snippets and folds in news with a brave-news source', () => {
  const rows = brave._internal.mapResults({
    web: { results: [{ title: 'Web', url: 'https://w.test', description: 'base', extra_snippets: ['more', 'context'] }] },
    news: { results: [{ title: 'News', url: 'https://n.test', description: 'fresh', age: '2 hours ago' }] },
  }, 5, { includeNews: true });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].snippet, 'base more context');
  assert.equal(rows[0].source, 'brave');
  assert.equal(rows[1].source, 'brave-news');
  assert.equal(rows[1].age, '2 hours ago');
});

test('mapResults omits news when includeNews is false', () => {
  const rows = brave._internal.mapResults({
    web: { results: [{ title: 'Web', url: 'https://w.test', description: 'x' }] },
    news: { results: [{ title: 'News', url: 'https://n.test', description: 'y' }] },
  }, 5, { includeNews: false });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'brave');
});

// ── freshness threaded into the request ──────────────────────────────

test('search adds freshness + news + extra_snippets params when a freshness hint is given', async () => {
  process.env[KEY_ENV] = 'k';
  let seenUrl = '';
  fetchImpl = async (url) => { seenUrl = String(url); return jsonResponse({ web: { results: [] } }); };
  await brave.search('breaking story', { freshness: 'week' });
  assert.match(seenUrl, /freshness=pw/);
  assert.match(seenUrl, /result_filter=web%2Cnews/);
  assert.match(seenUrl, /extra_snippets=1/);
});

// ── resilience (withRetry) ───────────────────────────────────────────

test('search retries a transient 503 then succeeds', async () => {
  process.env[KEY_ENV] = 'k';
  delete process.env.BRAVE_SEARCH_RETRY_DISABLED;
  process.env.BRAVE_SEARCH_MAX_RETRIES = '1';
  process.env.BRAVE_SEARCH_RETRY_BASE_MS = '1';
  let n = 0;
  fetchImpl = async () => {
    n += 1;
    if (n === 1) return jsonResponse({}, { status: 503 });
    return jsonResponse({ web: { results: [{ title: 'ok', url: 'https://ok.test', description: 'd' }] } });
  };
  const out = await brave.search('q', { maxResults: 3 });
  assert.equal(n, 2, 'should have retried exactly once');
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://ok.test');
});

test('search does NOT retry a 401 auth error (fails fast, single fetch)', async () => {
  process.env[KEY_ENV] = 'k';
  delete process.env.BRAVE_SEARCH_RETRY_DISABLED;
  process.env.BRAVE_SEARCH_MAX_RETRIES = '2';
  process.env.BRAVE_SEARCH_RETRY_BASE_MS = '1';
  let n = 0;
  fetchImpl = async () => { n += 1; return jsonResponse({}, { status: 401 }); };
  await assert.rejects(() => brave.search('q'), /brave http 401/);
  assert.equal(n, 1, 'auth errors must not be retried');
});

// ── adapter forwards freshness + separates cache buckets ─────────────

test('adapter forwards freshness to providers and caches fresh/non-fresh separately', async () => {
  const seen = [];
  let calls = 0;
  webSearch.clearCache();
  webSearch.setProviders([
    {
      id: 'brave', name: 'Brave', priority: 8, enabled: true,
      async search(q, opts) {
        calls += 1;
        seen.push(opts.freshness || null);
        return [{ title: 'B', url: 'https://b.test', snippet: 's', source: 'brave' }];
      },
    },
  ]);
  await webSearch.search('news today', { freshness: 'pw' });
  await webSearch.search('news today'); // different bucket → provider hit again
  await webSearch.search('news today', { freshness: 'pw' }); // cached → no new call
  assert.equal(calls, 2, `fresh + non-fresh are distinct cache buckets, calls=${calls}`);
  assert.deepEqual(seen, ['pw', null]);
});
