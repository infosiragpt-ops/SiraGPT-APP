'use strict';

/**
 * Tests for scientific-search.js — mocks global.fetch so the unit tests run
 * offline. Each provider is exercised with a fixture payload that mirrors
 * the real API response shape (atom XML for arXiv, JSON for the rest).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ss = require('../src/services/scientific-search');
const searchCache = require('../src/services/scientific-search-cache');

// ── Fetch stub helpers ─────────────────────────────────────────────────

const originalFetch = global.fetch;
let fetchHandler = null;

function setFetchHandler(handler) {
  fetchHandler = handler;
  global.fetch = async (url, opts) => {
    if (!fetchHandler) throw new Error('no fetch handler set');
    return fetchHandler(String(url), opts || {});
  };
}

function jsonResponse(body) {
  return {
    ok: true, status: 200, statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
function textResponse(body) {
  return {
    ok: true, status: 200, statusText: 'OK',
    json: async () => { throw new Error('not json'); },
    text: async () => body,
  };
}
function errorResponse(status) {
  return {
    ok: false, status, statusText: 'Error',
    json: async () => ({}),
    text: async () => '',
  };
}

test.afterEach(() => {
  fetchHandler = null;
  global.fetch = originalFetch;
  searchCache.clear();
});

// ── Internal helpers ───────────────────────────────────────────────────

test('normaliseDoi strips https://doi.org/ prefix and lowercases', () => {
  const { normaliseDoi } = ss._internal;
  assert.equal(normaliseDoi('https://doi.org/10.1234/AbC'), '10.1234/abc');
  assert.equal(normaliseDoi('http://dx.doi.org/10.5/foo'), '10.5/foo');
  assert.equal(normaliseDoi('10.X/Y'), '10.x/y');
  assert.equal(normaliseDoi(null), null);
  assert.equal(normaliseDoi(''), null);
});

test('normaliseTitle removes punctuation and collapses whitespace', () => {
  const { normaliseTitle } = ss._internal;
  assert.equal(normaliseTitle('Hello,   World!'), 'hello world');
  assert.equal(normaliseTitle('Deep-Learning: A Survey'), 'deep learning a survey');
});

test('dedupeByDoi merges duplicate DOIs preferring richer metadata', () => {
  const { dedupeByDoi } = ss._internal;
  const a = { doi: '10.1/x', title: 'A', abstract: null, openAccess: false };
  const b = { doi: '10.1/X', title: 'A2', abstract: 'long abstract', openAccess: true, pdfUrl: 'u' };
  const out = dedupeByDoi([a, b]);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'A2', 'should keep the richer entry');
});

test('dedupeByDoi falls back to normalised title when DOIs missing', () => {
  const { dedupeByDoi } = ss._internal;
  const a = { doi: null, title: 'Deep Learning: A Survey', abstract: null };
  const b = { doi: null, title: 'deep-learning a survey', abstract: 'x' };
  const out = dedupeByDoi([a, b]);
  assert.equal(out.length, 1);
});

test('invertedIndexToText reconstructs sentence from OpenAlex inverted index', () => {
  const { invertedIndexToText } = ss._internal;
  const idx = { 'Hello': [0], 'world': [1], '!': [2] };
  assert.equal(invertedIndexToText(idx), 'Hello world !');
});

test('rankPapers orders open-access > more citations > newer > shorter title', () => {
  const { rankPapers } = ss._internal;
  const papers = [
    { title: 'AAA', openAccess: false, citations: 100, year: 2020 },
    { title: 'BBB', openAccess: true,  citations: 50,  year: 2018 },
    { title: 'CCCC', openAccess: true, citations: 50,  year: 2018 },
    { title: 'DD',  openAccess: true,  citations: 50,  year: 2020 },
  ];
  const out = rankPapers(papers);
  // DD: OA + 50 + 2020 → first.   BBB: OA + 50 + 2018 + len=3 → 2nd.
  // CCCC: OA + 50 + 2018 + len=4 → 3rd.  AAA: not OA → last.
  assert.equal(out[0].title, 'DD');
  assert.equal(out[1].title, 'BBB');
  assert.equal(out[2].title, 'CCCC');
  assert.equal(out[3].title, 'AAA');
});

test('parseAtomFeed extracts arXiv entries from atom XML', () => {
  const { parseAtomFeed } = ss._internal;
  const xml = `
    <feed>
      <entry>
        <id>http://arxiv.org/abs/2401.00001v1</id>
        <title>Deep Learning Survey</title>
        <summary>This is the abstract text.</summary>
        <published>2024-01-15T00:00:00Z</published>
        <author><name>Alice Smith</name></author>
        <author><name>Bob Jones</name></author>
        <link title="pdf" href="http://arxiv.org/pdf/2401.00001v1.pdf"/>
        <link rel="alternate" href="http://arxiv.org/abs/2401.00001v1"/>
        <arxiv:doi>10.5/foo</arxiv:doi>
      </entry>
    </feed>
  `;
  const entries = parseAtomFeed(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, 'arxiv');
  assert.equal(entries[0].title, 'Deep Learning Survey');
  assert.equal(entries[0].year, 2024);
  assert.equal(entries[0].authors.length, 2);
  assert.equal(entries[0].authors[0].name, 'Alice Smith');
  assert.equal(entries[0].pdfUrl, 'http://arxiv.org/pdf/2401.00001v1.pdf');
  assert.equal(entries[0].doi, '10.5/foo');
  assert.equal(entries[0].openAccess, true);
});

test('parseAtomFeed handles multiple entries', () => {
  const xml = `
    <feed>
      <entry><id>http://arxiv.org/abs/1</id><title>One</title><published>2023-01-01</published></entry>
      <entry><id>http://arxiv.org/abs/2</id><title>Two</title><published>2024-01-01</published></entry>
    </feed>
  `;
  const entries = ss._internal.parseAtomFeed(xml);
  assert.equal(entries.length, 2);
});

// ── Per-provider tests ─────────────────────────────────────────────────

test('searchArxiv: returns parsed entries from atom response', async () => {
  setFetchHandler((url) => {
    assert.ok(url.includes('export.arxiv.org/api/query'));
    assert.ok(url.includes('search_query=all%3Aquantum'));
    return Promise.resolve(textResponse(`
      <feed><entry>
        <id>http://arxiv.org/abs/X</id>
        <title>Q paper</title>
        <published>2024-01-01</published>
        <author><name>A</name></author>
      </entry></feed>
    `));
  });
  const out = await ss.searchArxiv('quantum');
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Q paper');
  assert.equal(out[0].source, 'arxiv');
});

test('searchSemanticScholar: maps API JSON to canonical Paper shape', async () => {
  setFetchHandler((url) => {
    assert.ok(url.includes('api.semanticscholar.org/graph/v1/paper/search'));
    assert.ok(url.includes('query=transformers'));
    return Promise.resolve(jsonResponse({
      data: [
        {
          paperId: 'abc',
          title: 'Attention is all you need',
          abstract: 'The dominant sequence transduction models...',
          year: 2017,
          venue: 'NeurIPS',
          authors: [{ name: 'Vaswani', affiliations: ['Google'] }],
          externalIds: { DOI: '10.x/att' },
          openAccessPdf: { url: 'https://x/y.pdf' },
          citationCount: 100000,
          isOpenAccess: true,
          url: 'https://semanticscholar.org/p/abc',
        },
      ],
    }));
  });
  const out = await ss.searchSemanticScholar('transformers');
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Attention is all you need');
  assert.equal(out[0].doi, '10.x/att');
  assert.equal(out[0].citations, 100000);
  assert.equal(out[0].openAccess, true);
  assert.equal(out[0].authors[0].affiliation, 'Google');
});

test('searchOpenAlex: parses works + inverted-index abstract', async () => {
  setFetchHandler((url) => {
    assert.ok(url.includes('api.openalex.org/works'));
    return Promise.resolve(jsonResponse({
      results: [
        {
          id: 'https://openalex.org/W1',
          doi: 'https://doi.org/10.5/y',
          title: 'A study',
          abstract_inverted_index: { 'Hello': [0], 'world': [1] },
          authorships: [{ author: { display_name: 'Alice' }, institutions: [{ display_name: 'MIT' }] }],
          publication_year: 2023,
          host_venue: { display_name: 'Nature' },
          cited_by_count: 7,
          open_access: { is_oa: true, oa_url: 'https://x/z.pdf' },
        },
      ],
    }));
  });
  const out = await ss.searchOpenAlex('deep learning');
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'A study');
  assert.equal(out[0].doi, '10.5/y');
  assert.equal(out[0].abstract, 'Hello world');
  assert.equal(out[0].authors[0].affiliation, 'MIT');
  assert.equal(out[0].citations, 7);
});

test('searchCrossRef: parses works + extracts abstract HTML', async () => {
  setFetchHandler(() => Promise.resolve(jsonResponse({
    message: {
      items: [{
        DOI: '10.99/cross',
        title: ['CrossRef paper'],
        abstract: '<p>This is <i>abstract</i></p>',
        author: [{ given: 'Ana', family: 'López', affiliation: [{ name: 'UDP' }] }],
        issued: { 'date-parts': [[2022, 6]] },
        'container-title': ['Journal of X'],
        'is-referenced-by-count': 5,
        URL: 'https://doi.org/10.99/cross',
      }],
    },
  })));
  const out = await ss.searchCrossRef('x');
  assert.equal(out.length, 1);
  assert.equal(out[0].doi, '10.99/cross');
  assert.equal(out[0].abstract, 'This is abstract');
  assert.equal(out[0].year, 2022);
  assert.equal(out[0].authors[0].name, 'Ana López');
});

test('searchPubMed: chains esearch + esummary', async () => {
  let callCount = 0;
  setFetchHandler((url) => {
    callCount += 1;
    if (callCount === 1) {
      assert.ok(url.includes('esearch.fcgi'));
      return Promise.resolve(jsonResponse({ esearchresult: { idlist: ['100', '200'] } }));
    }
    if (callCount === 2) {
      assert.ok(url.includes('esummary.fcgi'));
      assert.ok(url.includes('id=100%2C200') || url.includes('id=100,200'));
      return Promise.resolve(jsonResponse({
        result: {
          '100': { uid: '100', title: 'P1', authors: [{ name: 'A' }], articleids: [{ idtype: 'doi', value: '10.1/p1' }] },
          '200': { uid: '200', title: 'P2', authors: [{ name: 'B' }], articleids: [] },
        },
      }));
    }
    throw new Error('unexpected call');
  });
  const out = await ss.searchPubMed('virus');
  assert.equal(out.length, 2);
  assert.equal(out[0].doi, '10.1/p1');
  assert.equal(out[1].doi, null);
});

test('searchEuropePMC: maps result list to canonical shape', async () => {
  setFetchHandler(() => Promise.resolve(jsonResponse({
    resultList: {
      result: [{
        id: '12345',
        pmid: '12345',
        doi: '10.2/eu',
        title: 'EuroPMC paper',
        abstractText: 'Abstract here',
        authorList: { author: [{ firstName: 'Lee', lastName: 'Choi' }] },
        pubYear: '2021',
        journalTitle: 'Eur J',
        citedByCount: 12,
        isOpenAccess: 'Y',
        fullTextUrlList: { fullTextUrl: [{ documentStyle: 'pdf', url: 'https://x.pdf' }] },
      }],
    },
  })));
  const out = await ss.searchEuropePMC('protein');
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'EuroPMC paper');
  assert.equal(out[0].openAccess, true);
  assert.equal(out[0].pdfUrl, 'https://x.pdf');
});

test('searchCore: returns empty array without CORE_API_KEY set', async () => {
  const orig = process.env.CORE_API_KEY;
  delete process.env.CORE_API_KEY;
  try {
    // Even if fetch is set, it should never be called
    setFetchHandler(() => { throw new Error('should not be called'); });
    const out = await ss.searchCore('anything');
    assert.deepEqual(out, []);
  } finally {
    if (orig !== undefined) process.env.CORE_API_KEY = orig;
  }
});

test('searchCore: hits API when CORE_API_KEY is set', async () => {
  const orig = process.env.CORE_API_KEY;
  process.env.CORE_API_KEY = 'test-key';
  try {
    setFetchHandler((url, opts) => {
      assert.ok(url.includes('api.core.ac.uk/v3/search/works'));
      assert.equal(opts.headers?.Authorization, 'Bearer test-key');
      return Promise.resolve(jsonResponse({
        results: [{ id: 'c1', title: 'CORE paper', doi: '10.5/c', yearPublished: 2020 }],
      }));
    });
    const out = await ss.searchCore('open access');
    assert.equal(out.length, 1);
    assert.equal(out[0].title, 'CORE paper');
    assert.equal(out[0].openAccess, true);
  } finally {
    if (orig === undefined) delete process.env.CORE_API_KEY;
    else process.env.CORE_API_KEY = orig;
  }
});

// ── Unified search ─────────────────────────────────────────────────────

test('search: fans out to all configured providers and merges results', async () => {
  setFetchHandler((url) => {
    if (url.includes('arxiv.org')) {
      return Promise.resolve(textResponse(`<feed><entry>
        <id>http://arxiv.org/abs/X</id>
        <title>Shared paper</title>
        <published>2024-01-01</published>
        <arxiv:doi>10.shared/A</arxiv:doi>
      </entry></feed>`));
    }
    if (url.includes('semanticscholar.org')) {
      return Promise.resolve(jsonResponse({ data: [{ paperId: 'p1', title: 'Shared paper', externalIds: { DOI: '10.shared/A' }, isOpenAccess: true, citationCount: 42 }] }));
    }
    if (url.includes('openalex.org')) {
      return Promise.resolve(jsonResponse({ results: [{ id: 'W2', title: 'Different paper', publication_year: 2023 }] }));
    }
    if (url.includes('crossref.org')) return Promise.resolve(jsonResponse({ message: { items: [] } }));
    if (url.includes('eutils.ncbi')) return Promise.resolve(jsonResponse({ esearchresult: { idlist: [] } }));
    if (url.includes('europepmc.org')) return Promise.resolve(jsonResponse({ resultList: { result: [] } }));
    if (url.includes('core.ac.uk')) return Promise.resolve(jsonResponse({ results: [] }));
    return Promise.resolve(jsonResponse({}));
  });
  const out = await ss.search('test query');
  // The shared DOI entries (arxiv + semanticscholar) should dedupe to 1.
  // OpenAlex contributed 1 different. Total = 2.
  assert.equal(out.papers.length, 2);
  // The deduped entry should have the richer metadata (semanticscholar's citationCount + OA)
  const shared = out.papers.find((p) => p.title.toLowerCase().includes('shared'));
  assert.ok(shared);
  assert.equal(shared.citations, 42);
});

test('search: returns errors array when a provider fails but others succeed', async () => {
  setFetchHandler((url) => {
    if (url.includes('arxiv.org')) {
      return Promise.resolve(textResponse('<feed></feed>'));
    }
    if (url.includes('openalex.org')) {
      return Promise.resolve(errorResponse(500));
    }
    // Make all others succeed empty
    return Promise.resolve(jsonResponse({}));
  });
  const out = await ss.search('x');
  assert.ok(out.errors.some((e) => e.provider === 'openalex'));
});

test('search: empty query returns empty result + input error', async () => {
  setFetchHandler(() => { throw new Error('should not call fetch'); });
  const out = await ss.search('');
  assert.equal(out.papers.length, 0);
  assert.equal(out.errors[0].provider, 'input');
});

test('search: subset providers limits the fan-out', async () => {
  let calls = 0;
  setFetchHandler((url) => {
    calls += 1;
    if (url.includes('arxiv.org')) return Promise.resolve(textResponse('<feed></feed>'));
    return Promise.resolve(jsonResponse({}));
  });
  await ss.search('x', { providers: ['arxiv'] });
  assert.equal(calls, 1, 'only arxiv should be called');
});

test('search: rejects unknown providers silently', async () => {
  setFetchHandler((url) => {
    if (url.includes('arxiv.org')) return Promise.resolve(textResponse('<feed></feed>'));
    return Promise.resolve(jsonResponse({}));
  });
  const out = await ss.search('x', { providers: ['arxiv', 'unknown_provider'] });
  assert.deepEqual(out.providers, ['arxiv']);
});

test('search: per-provider timeout collected as error', async () => {
  const cache = require('../src/services/scientific-search-cache');
  cache.clear();
  setFetchHandler(() => new Promise(() => { /* never resolves */ }));
  const out = await ss.search('timeout-probe-query', { providers: ['arxiv'], timeoutMs: 50 });
  assert.equal(out.papers.length, 0);
  assert.ok(out.errors[0].message.toLowerCase().includes('timed out'));
});

test('User-Agent includes mailto when SIRAGPT_RESEARCH_EMAIL is set', () => {
  const orig = process.env.SIRAGPT_RESEARCH_EMAIL;
  process.env.SIRAGPT_RESEARCH_EMAIL = 'test@siragpt.com';
  try {
    const ua = ss._internal.userAgent();
    assert.ok(ua.includes('mailto:test@siragpt.com'));
  } finally {
    if (orig === undefined) delete process.env.SIRAGPT_RESEARCH_EMAIL;
    else process.env.SIRAGPT_RESEARCH_EMAIL = orig;
  }
});

test('User-Agent omits mailto when SIRAGPT_RESEARCH_EMAIL is unset', () => {
  const orig = process.env.SIRAGPT_RESEARCH_EMAIL;
  delete process.env.SIRAGPT_RESEARCH_EMAIL;
  try {
    const ua = ss._internal.userAgent();
    assert.equal(ua.includes('mailto:'), false);
  } finally {
    if (orig !== undefined) process.env.SIRAGPT_RESEARCH_EMAIL = orig;
  }
});
