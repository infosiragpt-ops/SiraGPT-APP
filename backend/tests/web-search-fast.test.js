'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fast = require('../src/services/agents/web-search/fast-search');
const perplexity = require('../src/services/agents/web-search/providers/perplexity');
const { searchSummaryOf } = require('../src/services/agent-harness/event-stream');

const { normalizeQuery, canonicalUrl, shapeResults, allowUser, percentile, _resetForTests } = fast._internal;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rung(id, impl, tier = 'premium') {
  return { id, tier, enabled: () => true, run: impl };
}

function hit(url, title = url) {
  return { title, url, snippet: `snippet ${title}` };
}

test.beforeEach(() => _resetForTests());

test('normalizeQuery collapses whitespace and strips Spanish question marks', () => {
  assert.equal(normalizeQuery('  ¿Qué   es\tRAG?  '), 'Qué es RAG');
  assert.equal(normalizeQuery('precio dólar hoy!!'), 'precio dólar hoy');
});

test('canonicalUrl drops tracking params, www, hash and trailing slash', () => {
  assert.equal(
    canonicalUrl('https://www.Example.com/a/b/?utm_source=x&id=7#top'),
    canonicalUrl('https://example.com/a/b?id=7'),
  );
  assert.equal(canonicalUrl('javascript:alert(1)'), null);
});

test('shapeResults dedupes, filters domains and caps per domain', () => {
  const list = [
    hit('https://a.com/1'), hit('https://www.a.com/1/'), hit('https://a.com/2'),
    hit('https://a.com/3'), hit('https://a.com/4'), hit('https://b.org/x'), hit('https://spam.net/y'),
  ];
  const out = shapeResults(list, { maxResults: 10, domains: [], excludeDomains: ['spam.net'], provider: 'p' });
  assert.deepEqual(out.map((r) => r.url), ['https://a.com/1', 'https://a.com/2', 'https://a.com/3', 'https://b.org/x']);
  assert.equal(out[0].domain, 'a.com');
  assert.match(out[0].favicon, /s2\/favicons\?sz=64&domain=a\.com/);
  const only = shapeResults(list, { maxResults: 10, domains: ['b.org'], excludeDomains: [], provider: 'p' });
  assert.deepEqual(only.map((r) => r.domain), ['b.org']);
});

test('fast premium rung answers alone; no hedge is launched', async () => {
  let secondCalled = false;
  const out = await fast.fastSearch('fast query one', {
    redis: null,
    ladder: [
      rung('p1', async () => [hit('https://one.com/a')]),
      rung('p2', async () => { secondCalled = true; return [hit('https://two.com/b')]; }),
    ],
  });
  assert.equal(out.provider, 'p1');
  assert.equal(secondCalled, false);
  assert.equal(out.results.length, 1);
  assert.equal(out.cached, false);
  assert.ok(Number.isFinite(out.latencyMs));
});

test('slow first rung is hedged: the next rung starts after hedgeMs and wins', async () => {
  let aborted = false;
  const out = await fast.fastSearch('hedge query', {
    redis: null,
    hedgeMs: 30,
    ladder: [
      rung('slow', (q, { signal }) => new Promise((resolve) => {
        const t = setTimeout(() => resolve([hit('https://slow.com/x')]), 500);
        signal.addEventListener('abort', () => { aborted = true; clearTimeout(t); resolve([]); });
      })),
      rung('quick', async () => { await sleep(5); return [hit('https://quick.com/y')]; }),
    ],
  });
  assert.equal(out.provider, 'quick');
  assert.equal(aborted, true, 'the losing in-flight request is aborted');
  assert.ok(out.latencyMs < 400, `hedged answer should be fast, got ${out.latencyMs}ms`);
  assert.ok(out.attempts.some((a) => a.id === 'slow' && a.error === 'cancelled'));
});

test('empty or failing rungs escalate immediately to the next one', async () => {
  const started = Date.now();
  const out = await fast.fastSearch('escalate query', {
    redis: null,
    hedgeMs: 5000,
    ladder: [
      rung('empty', async () => []),
      rung('broken', async () => { throw new Error('perplexity http 503'); }),
      rung('free', async () => [hit('https://free.com/z')], 'free'),
    ],
  });
  assert.equal(out.provider, 'free');
  assert.ok(Date.now() - started < 1000, 'escalation must not wait for the hedge timer');
  const broken = out.attempts.find((a) => a.id === 'broken');
  assert.equal(broken.error, 'http_5xx');
});

test('all rungs empty → empty result, not a throw; deadline bounds a hung ladder', async () => {
  const none = await fast.fastSearch('nothing query', { redis: null, ladder: [rung('e', async () => [])] });
  assert.deepEqual(none.results, []);
  assert.equal(none.provider, null);

  const started = Date.now();
  const hung = await fast.fastSearch('hung query', {
    redis: null,
    hedgeMs: 5000,
    deadlineMs: 60,
    ladder: [rung('hang', () => new Promise(() => {}))],
  });
  assert.deepEqual(hung.results, []);
  assert.ok(Date.now() - started < 1000);
});

test('memory cache serves repeats without touching providers', async () => {
  let calls = 0;
  const ladder = [rung('p', async () => { calls += 1; return [hit('https://c.com/1')]; })];
  await fast.fastSearch('cache me', { redis: null, ladder });
  const again = await fast.fastSearch('  ¿cache   me? ', { redis: null, ladder });
  assert.equal(calls, 1);
  assert.equal(again.cached, true);
  assert.equal(again.results[0].url, 'https://c.com/1');
  assert.equal(fast.getMetrics().counters.memoryHits, 1);
});

test('redis tier is read on memory miss and written after a network answer', async () => {
  const store = new Map();
  const redis = {
    get: async (k) => store.get(k),
    set: async (k, v) => { store.set(k, v); return true; },
  };
  const ladder = [rung('p', async () => [hit('https://r.com/1')])];
  await fast.fastSearch('redis query', { redis, ladder });
  assert.equal(store.size, 1);
  _resetForTests(); // wipe memory only (redis map survives)
  let providerCalled = false;
  const out = await fast.fastSearch('redis query', {
    redis,
    ladder: [rung('p', async () => { providerCalled = true; return []; })],
  });
  assert.equal(providerCalled, false);
  assert.equal(out.cached, true);
  assert.equal(out.results[0].url, 'https://r.com/1');
});

test('per-user rate limit rejects bursts but cache hits stay free', async () => {
  assert.equal(allowUser('u1', 2), true);
  assert.equal(allowUser('u1', 2), true);
  assert.equal(allowUser('u1', 2), false);
  assert.equal(allowUser('u2', 2), true);

  _resetForTests();
  const ladder = [rung('p', async (q) => [hit(`https://x.com/${encodeURIComponent(q)}`)])];
  await fast.fastSearch('first query', { redis: null, ladder, userId: 'u9', userRpm: 1 });
  const limited = await fast.fastSearch('second query', { redis: null, ladder, userId: 'u9', userRpm: 1 });
  assert.equal(limited.rateLimited, true);
  assert.deepEqual(limited.results, []);
  const cachedRepeat = await fast.fastSearch('first query', { redis: null, ladder, userId: 'u9', userRpm: 1 });
  assert.equal(cachedRepeat.cached, true);
});

test('metrics expose p50/p95 per provider without queries', async () => {
  assert.equal(percentile([10, 20, 30, 40, 100], 50), 30);
  assert.equal(percentile([10, 20, 30, 40, 100], 95), 100);
  for (const q of ['m one', 'm two', 'm three']) {
    await fast.fastSearch(q, { redis: null, ladder: [rung('pp', async () => [hit(`https://m.com/${q.length}${q}`)])] });
  }
  const m = fast.getMetrics();
  assert.equal(m.engine, 'fast-search');
  assert.equal(m.providers.pp.count, 3);
  assert.ok(Number.isFinite(m.providers.pp.p50Ms));
  assert.ok(Number.isFinite(m.network.p95Ms));
  assert.doesNotMatch(JSON.stringify(m), /m one|m two/);
  assert.ok(m.configured.includes('free'));
});

test('perplexity provider: request body, auth and result mapping', async () => {
  const prev = process.env.PERPLEXITY_API_KEY;
  process.env.PERPLEXITY_API_KEY = 'pplx-test-key';
  try {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, init, body: JSON.parse(init.body) };
      return {
        ok: true,
        json: async () => ({ results: [
          { title: 'Uno', url: 'https://uno.pe/a', snippet: ' hola  mundo ', date: '2026-09-20' },
          { title: 'bad', url: 'ftp://nope' },
        ] }),
      };
    };
    const out = await perplexity.search('dólar hoy', {
      fetchImpl, maxResults: 5, freshness: 'pd', locale: 'es-PE', domains: ['bcrp.gob.pe'], excludeDomains: ['spam.com'],
    });
    assert.equal(seen.url, 'https://api.perplexity.ai/search');
    assert.equal(seen.init.headers.Authorization, 'Bearer pplx-test-key');
    assert.equal(seen.body.query, 'dólar hoy');
    assert.equal(seen.body.max_results, 5);
    assert.equal(seen.body.search_recency_filter, 'day');
    assert.equal(seen.body.country, 'PE');
    assert.deepEqual(seen.body.search_domain_filter, ['bcrp.gob.pe', '-spam.com']);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], { title: 'Uno', url: 'https://uno.pe/a', snippet: 'hola mundo', date: '2026-09-20', source: 'perplexity' });
    assert.equal(perplexity.enabled, true);
  } finally {
    if (prev === undefined) delete process.env.PERPLEXITY_API_KEY; else process.env.PERPLEXITY_API_KEY = prev;
  }
  assert.equal(perplexity.enabled, Boolean(process.env.PERPLEXITY_API_KEY || process.env.PPLX_API_KEY));
});

test('perplexity without a key makes no network call', async () => {
  const prev = process.env.PERPLEXITY_API_KEY;
  const prevAlias = process.env.PPLX_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;
  delete process.env.PPLX_API_KEY;
  try {
    let called = false;
    const out = await perplexity.search('x y', { fetchImpl: async () => { called = true; } });
    assert.deepEqual(out, []);
    assert.equal(called, false);
  } finally {
    if (prev !== undefined) process.env.PERPLEXITY_API_KEY = prev;
    if (prevAlias !== undefined) process.env.PPLX_API_KEY = prevAlias;
  }
});

test('tool_result search summary carries count, latency and sources only', () => {
  const summary = searchSummaryOf('web_search', {
    provider: 'perplexity', latencyMs: 183.4, cached: false, count: 2,
    results: [
      { title: 'A', url: 'https://a.com/1', snippet: 'secret-ish snippet' },
      { title: 'B', url: 'javascript:alert(1)' },
    ],
  });
  assert.deepEqual(summary, {
    count: 2, latencyMs: 183, provider: 'perplexity', cached: false,
    sources: [{ title: 'A', url: 'https://a.com/1' }],
  });
  assert.equal(searchSummaryOf('read_url', { results: [] }), null);
  assert.equal(searchSummaryOf('web_search', 'not json'), null);
});
