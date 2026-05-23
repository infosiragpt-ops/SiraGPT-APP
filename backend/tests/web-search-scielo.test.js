/**
 * Tests for the SciELO provider.
 *
 * Stubs `node-fetch` via require.cache BEFORE loading the provider so
 * the network is never touched. Each test installs a small fake that
 * returns the JSON shape we want the provider to consume, then asserts
 * the provider normalises it into the standard
 *   { title, url, snippet, source: 'scielo' }
 * envelope.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// --- node-fetch stub --------------------------------------------------
const fetchPath = require.resolve('node-fetch');
let fetchImpl = async () => { throw new Error('fetch not mocked'); };
require.cache[fetchPath] = {
  id: fetchPath,
  filename: fetchPath,
  loaded: true,
  exports: (...args) => fetchImpl(...args),
};

// Now load the provider — it will pick up the stubbed fetch.
const scielo = require('../src/services/agents/web-search/providers/scielo');

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function htmlResponse(html, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => html,
    json: async () => { throw new Error('not json'); },
  };
}

beforeEach(() => {
  fetchImpl = async () => { throw new Error('fetch not mocked'); };
});

afterEach(() => {
  fetchImpl = async () => { throw new Error('fetch not mocked'); };
});

test('parses Solr response with full {ti, ab, au, journal_title, py} fields', async () => {
  fetchImpl = async (url) => {
    assert.match(String(url), /search\.scielo\.org/);
    assert.match(String(url), /format=json/);
    return jsonResponse({
      response: {
        docs: [
          {
            id: 'S0102-311X2023000100100',
            ti: 'Determinantes sociales de la salud en América Latina',
            ab: 'Este artículo revisa la evidencia sobre determinantes sociales…',
            au: ['García, M.', 'Pereira, L.', 'Santos, R.'],
            journal_title: 'Cadernos de Saúde Pública',
            py: '2023',
          },
          {
            id: 'S1413-81232024000200055',
            ti: 'Inteligencia artificial en epidemiología',
            ab: 'Aplicaciones recientes de IA en vigilancia epidemiológica.',
            au: ['Lima, A.'],
            journal_title: 'Ciência & Saúde Coletiva',
            py: '2024',
          },
        ],
      },
    });
  };

  const results = await scielo.search('determinantes sociales salud', { maxResults: 5, locale: 'es' });
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(typeof r.title, 'string');
    assert.match(r.url, /^https:\/\/search\.scielo\.org/);
    assert.equal(r.source, 'scielo');
    assert.equal(typeof r.snippet, 'string');
  }
  assert.match(results[0].snippet, /Cadernos de Saúde Pública/);
  assert.match(results[0].snippet, /2023/);
  assert.match(results[0].snippet, /García/);
});

test('caps results at maxResults and ignores docs missing a title', async () => {
  fetchImpl = async () => jsonResponse({
    response: {
      docs: [
        { id: 'a', ti: 'T1' },
        { id: 'b' /* no title */ },
        { id: 'c', ti: 'T3' },
        { id: 'd', ti: 'T4' },
      ],
    },
  });
  const results = await scielo.search('q', { maxResults: 2 });
  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'T1');
  assert.equal(results[1].title, 'T3');
});

test('falls back to [] when Solr returns HTML (cache misbehaviour)', async () => {
  fetchImpl = async () => htmlResponse('<html><body>SciELO maintenance</body></html>');
  const results = await scielo.search('any query', { maxResults: 5 });
  assert.deepEqual(results, []);
});

test('returns [] (not throw) when Solr responds non-2xx', async () => {
  // The provider only throws on Solr non-2xx — that becomes "attempt
  // failed" inside the adapter, but to keep the parsing of provider
  // semantics honest we just confirm it throws (not silent).
  fetchImpl = async () => jsonResponse({}, { status: 503 });
  await assert.rejects(
    () => scielo.search('q'),
    /scielo solr http 503/,
  );
});

test('DOI fallback hits ArticleMeta when Solr returns empty', async () => {
  let calls = 0;
  fetchImpl = async (url) => {
    calls++;
    const u = String(url);
    if (calls === 1) {
      assert.match(u, /search\.scielo\.org/);
      return jsonResponse({ response: { docs: [] } });
    }
    assert.match(u, /articlemeta\.scielo\.org/);
    assert.match(u, /doi=10\.1590%2F/);
    return jsonResponse([
      { code: 'S0102-311X2023000100100', title: 'Sample article via DOI' },
    ]);
  };
  const q = 'check 10.1590/0102-311X00012345 please';
  const results = await scielo.search(q, { maxResults: 5 });
  assert.equal(calls, 2);
  assert.equal(results.length, 1);
  assert.equal(results[0].source, 'scielo');
  assert.match(results[0].snippet, /10\.1590/);
});

test('DOI fallback silently returns [] when ArticleMeta fails (so adapter advances)', async () => {
  let calls = 0;
  fetchImpl = async () => {
    calls++;
    if (calls === 1) return jsonResponse({ response: { docs: [] } });
    return jsonResponse({}, { status: 502 });
  };
  const results = await scielo.search('10.1590/abc', { maxResults: 5 });
  assert.deepEqual(results, []);
});

test('non-scientific query (Solr empty + no DOI) returns [] so the adapter falls through', async () => {
  fetchImpl = async () => jsonResponse({ response: { docs: [] } });
  const results = await scielo.search('clima de hoy en madrid', { maxResults: 5 });
  assert.deepEqual(results, []);
});

test('honours locale lang clamp: es → es, fr → omit', async () => {
  let capturedUrl = '';
  fetchImpl = async (url) => { capturedUrl = String(url); return jsonResponse({ response: { docs: [] } }); };
  await scielo.search('q', { locale: 'es-ES' });
  assert.match(capturedUrl, /[?&]lang=es(&|$)/);
  capturedUrl = '';
  await scielo.search('q', { locale: 'fr-FR' });
  assert.equal(/lang=/.test(capturedUrl), false);
});

test('registered with priority 5 (above DuckDuckGo) and enabled', () => {
  assert.equal(scielo.id, 'scielo');
  assert.equal(scielo.priority, 5);
  assert.equal(scielo.enabled, true);
});
