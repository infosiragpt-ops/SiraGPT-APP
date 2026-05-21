/**
 * Tests for services/agents/web-search adapter.
 *
 * Real provider calls would hit the live network and be flaky; instead
 * we swap in fake providers via webSearch.setProviders() and assert
 * adapter behaviour:
 *   - priority order (first non-empty wins)
 *   - fallback on timeout / error
 *   - cache hit/miss + cache key normalisation
 *   - normalised result shape across providers
 *   - the raw query never lands in audit-log lines
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const webSearch = require('../src/services/agents/web-search');
const auditLog = require('../src/services/agents/audit-log');
const agentTools = require('../src/services/agents/agent-tools');

let auditCaptured = [];
const originalAudit = auditLog.audit;

beforeEach(() => {
  webSearch.resetProviders();
  webSearch.clearCache();
  auditCaptured = [];
  auditLog.audit = (rec) => { auditCaptured.push(rec); };
});

afterEach(() => {
  auditLog.audit = originalAudit;
  webSearch.resetProviders();
  webSearch.clearCache();
});

function makeProvider({ id, priority = 100, results = [], delay = 0, throws = null }) {
  return {
    id,
    name: id,
    priority,
    enabled: true,
    async search(query, opts) {
      if (delay) {
        await new Promise((r, rj) => {
          const t = setTimeout(r, delay);
          if (opts?.signal) {
            opts.signal.addEventListener('abort', () => { clearTimeout(t); rj(new Error('aborted')); });
          }
        });
      }
      if (throws) throw new Error(throws);
      return results.map((r) => ({ ...r, source: r.source || id }));
    },
  };
}

test('returns the first provider with non-empty results in priority order', async () => {
  webSearch.setProviders([
    makeProvider({ id: 'b', priority: 20, results: [{ title: 'B', url: 'https://b.test', snippet: 'b' }] }),
    makeProvider({ id: 'a', priority: 10, results: [{ title: 'A', url: 'https://a.test', snippet: 'a' }] }),
  ]);
  const out = await webSearch.search('hello', { maxResults: 5 });
  assert.equal(out.provider, 'a');
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].title, 'A');
  assert.equal(out.cached, false);
});

test('skips a provider that returns an empty list and falls through', async () => {
  webSearch.setProviders([
    makeProvider({ id: 'empty', priority: 10, results: [] }),
    makeProvider({ id: 'filled', priority: 20, results: [{ title: 'X', url: 'https://x.test', snippet: 'x' }] }),
  ]);
  const out = await webSearch.search('q');
  assert.equal(out.provider, 'filled');
  assert.equal(out.attempts.length, 2);
  assert.equal(out.attempts[0].ok, true);
  assert.equal(out.attempts[0].count, 0);
});

test('falls through when a provider throws', async () => {
  webSearch.setProviders([
    makeProvider({ id: 'broken', priority: 10, throws: 'http 500 from upstream' }),
    makeProvider({ id: 'ok', priority: 20, results: [{ title: 'T', url: 'https://t.test', snippet: 't' }] }),
  ]);
  const out = await webSearch.search('q');
  assert.equal(out.provider, 'ok');
  assert.equal(out.attempts[0].ok, false);
  // Errors are bucketed into a fixed enum — raw upstream text never leaks.
  assert.equal(out.attempts[0].error, 'http_5xx');
});

test('audit-log never leaks query text via upstream error messages', async () => {
  const secretish = 'patient-record-XYZ-9999';
  // Provider that throws the kind of error node-fetch produces — with
  // the full request URL (containing the raw query) baked into the
  // message. The adapter MUST classify this away before auditing.
  webSearch.setProviders([
    {
      id: 'leaky', name: 'leaky', priority: 10,
      async search(q) {
        throw new Error(`request to https://api.example.com/search?q=${encodeURIComponent(q)} failed, reason: connect ECONNREFUSED`);
      },
    },
    {
      id: 'also-leaky', name: 'also-leaky', priority: 20,
      async search(q) {
        throw new Error(`network error fetching https://other.example.com/?q=${encodeURIComponent(q)}`);
      },
    },
  ]);
  const out = await webSearch.search(secretish);
  assert.deepEqual(out.results, []);
  assert.equal(out.provider, null);
  // Assert no attempt error string contains the raw query.
  for (const a of out.attempts) {
    assert.equal(String(a.error || '').includes(secretish), false, 'raw query leaked in attempts');
  }
  // And the audit record stringified must not contain it either.
  assert.equal(auditCaptured.length, 1);
  const dump = JSON.stringify(auditCaptured[0]);
  assert.equal(dump.includes(secretish), false, 'raw query leaked into audit log via upstream error');
});

test('falls through when a provider exceeds the per-provider timeout', async () => {
  webSearch.setProviders([
    makeProvider({ id: 'slow', priority: 10, delay: 1000, results: [{ title: 'late', url: 'https://late.test', snippet: '' }] }),
    makeProvider({ id: 'fast', priority: 20, results: [{ title: 'fast', url: 'https://fast.test', snippet: '' }] }),
  ]);
  const out = await webSearch.search('q', { timeoutMs: 100 });
  assert.equal(out.attempts[0].ok, false, `expected slow provider to fail, attempts=${JSON.stringify(out.attempts)}`);
  assert.match(out.attempts[0].error || '', /timeout|aborted/);
  assert.equal(out.provider, 'fast');
});

test('returns an empty result set (not 500) when every provider fails or is empty', async () => {
  webSearch.setProviders([
    makeProvider({ id: 'empty', priority: 10, results: [] }),
    makeProvider({ id: 'broken', priority: 20, throws: 'down' }),
  ]);
  const out = await webSearch.search('q');
  assert.deepEqual(out.results, []);
  assert.equal(out.provider, null);
  assert.equal(out.cached, false);
});

test('caches by (query, locale) and the second call returns cached=true', async () => {
  let calls = 0;
  webSearch.setProviders([
    {
      id: 'count',
      name: 'count',
      priority: 10,
      async search() {
        calls++;
        return [{ title: 'X', url: 'https://x.test', snippet: 'x', source: 'count' }];
      },
    },
  ]);
  const first = await webSearch.search(' Hello ', { locale: 'es-ES' });
  assert.equal(first.cached, false);
  assert.equal(calls, 1);
  // Different casing + surrounding whitespace should hit the same key.
  const second = await webSearch.search('hello', { locale: 'es-es' });
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
  // Different locale → different bucket.
  const third = await webSearch.search('hello', { locale: 'en' });
  assert.equal(third.cached, false);
  assert.equal(calls, 2);
});

test('normalises results to {title,url,snippet,source} and caps maxResults', async () => {
  webSearch.setProviders([
    makeProvider({
      id: 'multi',
      priority: 10,
      results: [
        { title: 'A', url: 'https://a.test', snippet: 'a' },
        { title: 'B', url: 'https://b.test', snippet: 'b' },
        { title: 'C', url: 'https://c.test', snippet: 'c' },
      ],
    }),
  ]);
  const out = await webSearch.search('q', { maxResults: 2 });
  assert.equal(out.results.length, 2);
  for (const r of out.results) {
    assert.equal(typeof r.title, 'string');
    assert.equal(typeof r.url, 'string');
    assert.equal(typeof r.snippet, 'string');
    assert.equal(r.source, 'multi');
  }
});

test('audit-log emits provider + queryLen but NOT the raw query', async () => {
  webSearch.setProviders([
    makeProvider({ id: 'a', priority: 10, results: [{ title: 'A', url: 'https://a.test', snippet: 'a' }] }),
  ]);
  const secretish = 'super-secret-payload-1234';
  await webSearch.search(secretish);
  assert.equal(auditCaptured.length, 1);
  const rec = auditCaptured[0];
  assert.equal(rec.event, 'web_search');
  assert.equal(rec.provider, 'a');
  assert.equal(rec.queryLen, secretish.length);
  // Stringify the whole record and assert the query string itself
  // never appears anywhere in it.
  const dump = JSON.stringify(rec);
  assert.equal(dump.includes(secretish), false, 'raw query leaked into audit log');
});

test('empty query short-circuits without touching providers', async () => {
  let touched = false;
  webSearch.setProviders([
    {
      id: 'spy', name: 'spy', priority: 10,
      async search() { touched = true; return []; },
    },
  ]);
  const out = await webSearch.search('   ');
  assert.deepEqual(out.results, []);
  assert.equal(out.provider, null);
  assert.equal(touched, false);
});

test('web_search tool returns structured JSON with normalised shape', async () => {
  webSearch.setProviders([
    makeProvider({ id: 't', priority: 10, results: [{ title: 'Tool', url: 'https://t.test', snippet: 'tool' }] }),
  ]);
  const obs = await agentTools.web_search.handler({ query: 'hi', maxResults: 3 });
  assert.equal(obs.provider, 't');
  assert.equal(obs.count, 1);
  assert.equal(obs.results[0].url, 'https://t.test');
  assert.equal(Array.isArray(obs.attempts), true);
});

test('web_search tool rejects missing query with a structured error', async () => {
  const obs = await agentTools.web_search.handler({});
  assert.equal(obs.error, 'missing "query"');
});

test('LRU evicts oldest beyond capacity', () => {
  const c = new webSearch._LruTtlCache({ max: 2, ttlMs: 60000 });
  c.set('a', null, { results: [{}], provider: 'x' });
  c.set('b', null, { results: [{}], provider: 'x' });
  c.set('c', null, { results: [{}], provider: 'x' });
  assert.equal(c.get('a', null), null, 'oldest "a" was evicted');
  assert.notEqual(c.get('b', null), null);
  assert.notEqual(c.get('c', null), null);
});

test('TTL expiry drops stale entries on read', async () => {
  const c = new webSearch._LruTtlCache({ max: 10, ttlMs: 20 });
  c.set('q', null, { results: [{}], provider: 'x' });
  assert.notEqual(c.get('q', null), null);
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(c.get('q', null), null);
});
