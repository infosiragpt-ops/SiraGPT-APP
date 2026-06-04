'use strict';

/**
 * Tests for github-search.js — mocks global.fetch so the suite runs offline.
 * Each corpus is exercised with a fixture payload mirroring the real GitHub
 * REST API shape. Token-gated behaviour (code search) is covered both with
 * and without a configured token.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const gh = require('../src/services/github-search');
const ghCache = require('../src/services/github-search-cache');

// ── Fetch stub helpers ─────────────────────────────────────────────────

const originalFetch = global.fetch;
const originalToken = process.env.GITHUB_TOKEN;
const originalSiraToken = process.env.SIRAGPT_GITHUB_TOKEN;
let fetchHandler = null;

function setFetchHandler(handler) {
  fetchHandler = handler;
  global.fetch = async (url, opts) => {
    if (!fetchHandler) throw new Error('no fetch handler set');
    return fetchHandler(String(url), opts || {});
  };
}

function jsonResponse(body, headers = {}) {
  return {
    ok: true, status: 200, statusText: 'OK',
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    json: async () => body,
  };
}

function errorResponse(status, headers = {}) {
  return {
    ok: false, status, statusText: 'Error',
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    json: async () => ({}),
  };
}

function clearToken() {
  delete process.env.GITHUB_TOKEN;
  delete process.env.SIRAGPT_GITHUB_TOKEN;
}

test.afterEach(() => {
  fetchHandler = null;
  global.fetch = originalFetch;
  ghCache.clear();
  if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalToken;
  if (originalSiraToken === undefined) delete process.env.SIRAGPT_GITHUB_TOKEN;
  else process.env.SIRAGPT_GITHUB_TOKEN = originalSiraToken;
});

// ── Internal helpers ───────────────────────────────────────────────────

test('clampLimit clamps to [1,50] and defaults to 10', () => {
  const { clampLimit } = gh._internal;
  assert.equal(clampLimit(0), 10);
  assert.equal(clampLimit(-5), 10);
  assert.equal(clampLimit('abc'), 10);
  assert.equal(clampLimit(7), 7);
  assert.equal(clampLimit(999), 50);
});

test('pickSort only accepts valid non-best-match sorts', () => {
  const { pickSort, VALID_REPO_SORTS } = gh._internal;
  assert.equal(pickSort('stars', VALID_REPO_SORTS), 'stars');
  assert.equal(pickSort('best-match', VALID_REPO_SORTS), null);
  assert.equal(pickSort('bogus', VALID_REPO_SORTS), null);
});

test('pickOrder normalises to asc/desc', () => {
  const { pickOrder } = gh._internal;
  assert.equal(pickOrder('asc'), 'asc');
  assert.equal(pickOrder('ASC'), 'asc');
  assert.equal(pickOrder('desc'), 'desc');
  assert.equal(pickOrder(undefined), 'desc');
});

test('buildRepoQuery appends language/minStars/topic qualifiers', () => {
  const { buildRepoQuery } = gh._internal;
  assert.equal(buildRepoQuery('rag', { language: 'python' }), 'rag language:python');
  assert.equal(buildRepoQuery('rag', { minStars: 100 }), 'rag stars:>=100');
  assert.equal(buildRepoQuery('rag', { topic: 'llm' }), 'rag topic:llm');
  assert.equal(buildRepoQuery('rag', {}), 'rag');
});

test('extractRepoFromIssueUrl pulls owner/name from repository_url', () => {
  const { extractRepoFromIssueUrl } = gh._internal;
  assert.equal(
    extractRepoFromIssueUrl('https://api.github.com/repos/octocat/Hello-World'),
    'octocat/Hello-World',
  );
  assert.equal(extractRepoFromIssueUrl(null), null);
});

test('normaliseRepo maps GitHub fields to the canonical shape', () => {
  const { normaliseRepo } = gh._internal;
  const r = normaliseRepo({
    id: 1, full_name: 'a/b', name: 'b', owner: { login: 'a' },
    description: 'desc', html_url: 'https://github.com/a/b',
    stargazers_count: 42, forks_count: 5, watchers_count: 42,
    open_issues_count: 3, language: 'TypeScript', topics: ['x'],
    license: { spdx_id: 'MIT' }, default_branch: 'main', size: 99,
    archived: false, fork: false, pushed_at: '2024-01-01T00:00:00Z',
  });
  assert.equal(r.type, 'repository');
  assert.equal(r.fullName, 'a/b');
  assert.equal(r.owner, 'a');
  assert.equal(r.stars, 42);
  assert.equal(r.license, 'MIT');
  assert.deepEqual(r.topics, ['x']);
});

test('rankRepos sorts by stars desc then recency', () => {
  const { rankRepos } = gh._internal;
  const out = rankRepos([
    { stars: 10, pushedAt: '2020-01-01' },
    { stars: 100, pushedAt: '2019-01-01' },
    { stars: 100, pushedAt: '2024-01-01' },
  ]);
  assert.equal(out[0].stars, 100);
  assert.equal(out[0].pushedAt, '2024-01-01');
  assert.equal(out[2].stars, 10);
});

// ── Repositories ───────────────────────────────────────────────────────

test('searchRepositories returns normalised + star-ranked repos', async () => {
  clearToken();
  setFetchHandler((url, opts) => {
    assert.match(url, /\/search\/repositories\?/);
    assert.match(url, /q=rag/);
    // GitHub requires a User-Agent header.
    assert.ok(opts.headers['User-Agent']);
    return jsonResponse({
      items: [
        { id: 1, full_name: 'low/stars', stargazers_count: 5, html_url: 'u1' },
        { id: 2, full_name: 'high/stars', stargazers_count: 9000, html_url: 'u2' },
      ],
    });
  });
  const out = await gh.search('rag', { type: 'repositories' });
  assert.equal(out.type, 'repositories');
  assert.equal(out.count, 2);
  assert.equal(out.items[0].fullName, 'high/stars', 'highest stars ranked first');
  assert.equal(out.errors.length, 0);
});

test('search caches identical repository queries', async () => {
  clearToken();
  let calls = 0;
  setFetchHandler(() => {
    calls += 1;
    return jsonResponse({ items: [{ id: 1, full_name: 'a/b', stargazers_count: 1, html_url: 'u' }] });
  });
  await gh.search('cached-query', { type: 'repositories' });
  const second = await gh.search('cached-query', { type: 'repositories' });
  assert.equal(calls, 1, 'second call served from cache');
  assert.ok(second._cache && second._cache.hit, 'cache hit flag present');
});

// ── Code (token-gated) ─────────────────────────────────────────────────

test('searchCode throws without a token', async () => {
  clearToken();
  const out = await gh.search('parser', { type: 'code' });
  assert.equal(out.items.length, 0);
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0].status, 401);
});

test('searchCode works with a token and sends Authorization', async () => {
  process.env.GITHUB_TOKEN = 'ghp_test';
  setFetchHandler((url, opts) => {
    assert.match(url, /\/search\/code\?/);
    assert.equal(opts.headers.Authorization, 'Bearer ghp_test');
    return jsonResponse({
      items: [{ name: 'a.js', path: 'src/a.js', repository: { full_name: 'o/r' }, html_url: 'h', sha: 'abc' }],
    });
  });
  const out = await gh.searchCode('parser', {});
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'code');
  assert.equal(out[0].repository, 'o/r');
});

// ── Issues / Users / Topics ────────────────────────────────────────────

test('searchIssues distinguishes PRs from issues', async () => {
  clearToken();
  setFetchHandler(() => jsonResponse({
    items: [
      { number: 1, title: 'a bug', state: 'open', html_url: 'h1', repository_url: 'https://api.github.com/repos/o/r', user: { login: 'u' }, comments: 2, labels: [{ name: 'bug' }] },
      { number: 2, title: 'a pr', state: 'closed', html_url: 'h2', pull_request: { url: 'x' }, repository_url: 'https://api.github.com/repos/o/r', user: { login: 'u' } },
    ],
  }));
  const out = await gh.searchIssues('something', {});
  assert.equal(out[0].type, 'issue');
  assert.equal(out[0].repository, 'o/r');
  assert.deepEqual(out[0].labels, ['bug']);
  assert.equal(out[1].type, 'pull_request');
});

test('searchUsers maps organizations vs users', async () => {
  clearToken();
  setFetchHandler(() => jsonResponse({
    items: [
      { login: 'octocat', id: 1, type: 'User', html_url: 'h', avatar_url: 'a', score: 1 },
      { login: 'github', id: 2, type: 'Organization', html_url: 'h2', avatar_url: 'a2', score: 2 },
    ],
  }));
  const out = await gh.searchUsers('octo', {});
  assert.equal(out[0].type, 'user');
  assert.equal(out[1].type, 'organization');
});

test('searchTopics returns canonical topic shape', async () => {
  clearToken();
  setFetchHandler((url, opts) => {
    assert.equal(opts.headers.Accept, 'application/vnd.github.mercy-preview+json');
    return jsonResponse({ items: [{ name: 'llm', display_name: 'LLM', description: 'd', featured: true, curated: true }] });
  });
  const out = await gh.searchTopics('llm', {});
  assert.equal(out[0].type, 'topic');
  assert.equal(out[0].displayName, 'LLM');
  assert.equal(out[0].featured, true);
});

// ── getRepo / getReadme ────────────────────────────────────────────────

test('getReadme decodes base64 content and caps length', async () => {
  clearToken();
  const raw = '# Hello\nworld';
  setFetchHandler(() => jsonResponse({
    path: 'README.md', html_url: 'h', encoding: 'base64',
    content: Buffer.from(raw, 'utf8').toString('base64'),
  }));
  const out = await gh.getReadme('o', 'r', { maxChars: 1000 });
  assert.equal(out.repository, 'o/r');
  assert.equal(out.content, raw);
  assert.equal(out.truncated, false);
});

// ── Error handling ─────────────────────────────────────────────────────

test('rate-limit 403 surfaces as a captured error, not a throw', async () => {
  clearToken();
  setFetchHandler(() => errorResponse(403, { 'x-ratelimit-remaining': '0', 'retry-after': '60' }));
  const out = await gh.search('anything', { type: 'repositories' });
  assert.equal(out.items.length, 0);
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0].status, 403);
});

test('empty query short-circuits without fetching', async () => {
  clearToken();
  setFetchHandler(() => { throw new Error('should not fetch'); });
  const out = await gh.search('   ', {});
  assert.equal(out.count, 0);
  assert.equal(out.errors[0].source, 'input');
});

// ── searchAll fan-out ──────────────────────────────────────────────────

test('searchAll skips code search when unauthenticated', async () => {
  clearToken();
  const seen = [];
  setFetchHandler((url) => {
    seen.push(url);
    if (url.includes('/search/repositories')) return jsonResponse({ items: [{ id: 1, full_name: 'a/b', stargazers_count: 3, html_url: 'u' }] });
    if (url.includes('/search/issues')) return jsonResponse({ items: [] });
    if (url.includes('/search/users')) return jsonResponse({ items: [] });
    throw new Error(`unexpected url ${url}`);
  });
  const out = await gh.searchAll('topic', {});
  assert.ok(out.repositories.length >= 1);
  assert.equal(out.authenticated, false);
  assert.ok(!seen.some((u) => u.includes('/search/code')), 'code search not attempted without token');
});
