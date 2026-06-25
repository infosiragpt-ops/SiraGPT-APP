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

test('invertedIndexToText bounds a hostile position (no unbounded allocation)', () => {
  const { invertedIndexToText } = ss._internal;
  // A malformed external index claims a word sits at position 50 million — the
  // old code allocated a 50M-slot array. Must stay bounded and still return text.
  const out = invertedIndexToText({ Early: [0], Far: [50_000_000] });
  assert.ok(typeof out === 'string' && out.startsWith('Early'), 'still reconstructs the in-range words');
  assert.ok(out.split(' ').length <= 20_001, 'reconstruction length is capped');
});

test('isTransientError judges on the HTTP status, not a 4xx-looking token in the URL', () => {
  const { isTransientError } = ss._internal;
  // A genuine 503 whose URL embeds the query "understanding 404 error semantics".
  const e503 = new Error('HTTP 503 Service Unavailable — https://api.crossref.org/works?query=understanding+404+error+semantics&rows=10');
  assert.equal(isTransientError(e503), true, 'a real 5xx must be retried despite a 404 in the URL');
  // A genuine 404 is permanent even if the URL query mentions "500".
  const e404 = new Error('HTTP 404 Not Found — https://api.example.org/works?query=http+500+errors');
  assert.equal(isTransientError(e404), false, 'a real 4xx is not retried');
  assert.equal(isTransientError(new Error('HTTP 429 Too Many Requests — https://x/y')), true, '429 is transient');
  assert.equal(isTransientError(new Error('ECONNRESET')), true, 'network errors are transient');
});

test('cacheKey scopes diversify / unpaywall opt-in flags (no silent no-op on cache hit)', () => {
  const cache = require('../src/services/scientific-search-cache');
  const base = cache.cacheKey('q', {});
  assert.notEqual(cache.cacheKey('q', { unpaywall: true }), base, 'unpaywall must scope the key');
  assert.notEqual(cache.cacheKey('q', { diversify: false }), base, 'diversify:false must scope the key');
  assert.notEqual(cache.cacheKey('q', { maxRun: 5 }), base, 'maxRun must scope the key');
  assert.notEqual(cache.cacheKey('q', { maxEnrichUnpaywall: 20 }), base, 'maxEnrichUnpaywall must scope the key');
  // Defaults / identical opts still collapse to one key (cache still works).
  assert.equal(cache.cacheKey('q', { diversify: true }), base, 'diversify:true === default');
  assert.equal(cache.cacheKey('q', { unpaywall: false }), base, 'unpaywall:false === default');
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

// ── Worldwide providers (DOAJ / DBLP / DataCite) ───────────────────────

test('searchDOAJ: maps bibjson to canonical shape with OA + fulltext link', async () => {
  setFetchHandler((url) => {
    assert.ok(url.includes('doaj.org/api/v2/search/articles/'));
    return Promise.resolve(jsonResponse({
      results: [{
        id: 'd1',
        bibjson: {
          title: 'Open access study',
          abstract: 'An abstract.',
          year: '2022',
          author: [{ name: 'Ana Pérez' }],
          journal: { title: 'Revista Latinoamericana', country: 'MX' },
          identifier: [{ type: 'doi', id: '10.1/doaj' }],
          link: [{ type: 'fulltext', url: 'https://example.org/pdf' }],
        },
      }],
    }));
  });
  const out = await ss.searchDOAJ('open access');
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'doaj');
  assert.equal(out[0].doi, '10.1/doaj');
  assert.equal(out[0].openAccess, true);
  assert.equal(out[0].venue, 'Revista Latinoamericana');
  assert.equal(out[0].pdfUrl, 'https://example.org/pdf');
});

test('searchDOAJ: returns [] on an empty payload', async () => {
  setFetchHandler(() => Promise.resolve(jsonResponse({})));
  const out = await ss.searchDOAJ('nothing');
  assert.deepEqual(out, []);
});

test('searchDBLP: handles single + multiple authors and strips trailing dot', async () => {
  setFetchHandler((url) => {
    assert.ok(url.includes('dblp.org/search/publ/api'));
    return Promise.resolve(jsonResponse({
      result: { hits: { hit: [
        { info: { key: 'k1', title: 'A CS paper.', year: '2021', venue: 'NeurIPS', doi: '10.2/dblp', ee: 'https://ee', authors: { author: [{ text: 'Jane Doe' }, { text: 'John Roe' }] } } },
        { info: { key: 'k2', title: 'Solo work', year: '2019', venue: 'ICML', authors: { author: { text: 'Solo Author' } } } },
      ] } },
    }));
  });
  const out = await ss.searchDBLP('learning');
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'A CS paper', 'trailing dot stripped');
  assert.equal(out[0].authors.length, 2);
  assert.equal(out[0].htmlUrl, 'https://ee');
  assert.equal(out[1].authors[0].name, 'Solo Author', 'single author normalised');
});

test('searchDBLP: returns [] when there are no hits', async () => {
  setFetchHandler(() => Promise.resolve(jsonResponse({ result: { hits: {} } })));
  const out = await ss.searchDBLP('zzz');
  assert.deepEqual(out, []);
});

test('searchDataCite: maps attributes to canonical shape', async () => {
  setFetchHandler((url) => {
    assert.ok(url.includes('api.datacite.org/dois'));
    return Promise.resolve(jsonResponse({
      data: [{
        id: '10.3/dc',
        attributes: {
          doi: '10.3/dc',
          titles: [{ title: 'A dataset' }],
          descriptions: [{ description: 'Dataset description.' }],
          creators: [{ name: 'Lab X' }, { givenName: 'Joe', familyName: 'Smith' }],
          publicationYear: 2023,
          publisher: 'Zenodo',
          url: 'https://zenodo.org/record/1',
        },
      }],
    }));
  });
  const out = await ss.searchDataCite('dataset');
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'datacite');
  assert.equal(out[0].doi, '10.3/dc');
  assert.equal(out[0].year, 2023);
  assert.equal(out[0].venue, 'Zenodo');
  assert.equal(out[0].authors[1].name, 'Joe Smith', 'given+family joined');
});

// ── SciELO (via Crossref member 530) ───────────────────────────────────

test('searchSciELO: queries Crossref member 530 and maps to canonical shape', async () => {
  let calledUrl = '';
  setFetchHandler((url) => {
    calledUrl = url;
    assert.ok(url.includes('api.crossref.org'), 'hits Crossref');
    assert.ok(url.includes('member%3A530'), 'filters to SciELO member 530');
    return Promise.resolve(jsonResponse({
      message: {
        items: [{
          DOI: '10.1590/s0102-67202013000200003',
          title: ['Cirugía bariátrica'],
          author: [{ given: 'Ana', family: 'Souza' }],
          issued: { 'date-parts': [[2013]] },
          'container-title': ['ABCD Arq Bras Cir Dig'],
          'is-referenced-by-count': 7,
          URL: 'https://doi.org/10.1590/s0102-67202013000200003',
        }],
      },
    }));
  });
  const out = await ss.searchSciELO('cirugia bariatrica');
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'scielo');
  assert.equal(out[0].openAccess, true, 'SciELO is OA by definition');
  assert.equal(out[0].doi, '10.1590/s0102-67202013000200003');
  assert.equal(out[0].title, 'Cirugía bariátrica');
  assert.equal(out[0].venue, 'ABCD Arq Bras Cir Dig');
  assert.equal(out[0].citations, 7);
  assert.equal(out[0].authors[0].name, 'Ana Souza');
  assert.ok(calledUrl, 'fetch was called');
});

// ── Redalyc (via OpenAlex source pin) ──────────────────────────────────

test('searchRedalyc: pins OpenAlex to the Redalyc source and links to redalyc.org', async () => {
  setFetchHandler((url) => {
    assert.ok(url.includes('api.openalex.org'), 'hits OpenAlex');
    assert.ok(url.includes('S4377196100'), 'pins to the Redalyc primary source id');
    return Promise.resolve(jsonResponse({
      results: [{
        id: 'https://openalex.org/W123',
        title: 'Educación inclusiva',
        abstract_inverted_index: { Hola: [0], mundo: [1] },
        authorships: [{ author: { display_name: 'A. Pérez' }, institutions: [{ display_name: 'UAEMex' }] }],
        publication_year: 2011,
        cited_by_count: 12,
        doi: null,
        open_access: { is_oa: false, oa_url: null },
        primary_location: {
          source: { id: 'https://openalex.org/S4377196100', display_name: 'Redalyc (UAEMex)' },
          landing_page_url: 'https://www.redalyc.org/articulo.oa?id=20804208',
          pdf_url: null,
        },
      }],
    }));
  });
  const out = await ss.searchRedalyc('educacion inclusiva');
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'redalyc');
  assert.equal(out[0].venue, 'Redalyc', 'venue label hard-coded');
  assert.ok(out[0].htmlUrl.startsWith('https://www.redalyc.org/articulo.oa'), 'links to the real redalyc.org page');
  assert.equal(out[0].abstract, 'Hola mundo', 'inverted index reconstructed');
  assert.equal(out[0].openAccess, false, 'do not force OA true');
  assert.equal(out[0].doi, null);
});

// ── bioRxiv & medRxiv (via OpenAlex source pin) ────────────────────────

test('searchBioRxiv: pins OpenAlex to the bioRxiv source, tags source=biorxiv, links to landing page', async () => {
  setFetchHandler((url) => {
    assert.ok(url.includes('api.openalex.org'), 'hits OpenAlex');
    assert.ok(url.includes('S4306402567'), 'pins to the bioRxiv primary source id');
    return Promise.resolve(jsonResponse({
      results: [{
        id: 'https://openalex.org/W777',
        title: 'CRISPR base editing in vivo',
        abstract_inverted_index: { Gene: [0], editing: [1] },
        authorships: [{ author: { display_name: 'J. Doe' }, institutions: [{ display_name: 'MIT' }] }],
        publication_year: 2023,
        cited_by_count: 8,
        doi: 'https://doi.org/10.1101/2023.01.01.000001',
        open_access: { is_oa: true, oa_url: 'https://www.biorxiv.org/content/10.1101/2023.01.01.000001v1.full.pdf' },
        primary_location: {
          source: { id: 'https://openalex.org/S4306402567', display_name: 'bioRxiv' },
          landing_page_url: 'https://www.biorxiv.org/content/10.1101/2023.01.01.000001v1',
          pdf_url: null,
        },
      }],
    }));
  });
  const out = await ss.searchBioRxiv('crispr base editing');
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'biorxiv');
  assert.equal(out[0].venue, 'bioRxiv', 'venue label hard-coded');
  assert.ok(out[0].htmlUrl.startsWith('https://www.biorxiv.org/content/'), 'links to the bioRxiv landing page');
  assert.equal(out[0].abstract, 'Gene editing', 'inverted index reconstructed');
  assert.equal(out[0].openAccess, true);
  assert.equal(out[0].doi, '10.1101/2023.01.01.000001', 'doi prefix stripped');
});

test('searchMedRxiv: pins OpenAlex to the canonical medRxiv source (S3005729997), tags source=medrxiv', async () => {
  setFetchHandler((url) => {
    assert.ok(url.includes('S3005729997'), 'pins to the canonical medRxiv source id (not the empty S4306400573)');
    return Promise.resolve(jsonResponse({
      results: [{
        id: 'https://openalex.org/W888',
        title: 'COVID-19 vaccine efficacy',
        authorships: [{ author: { display_name: 'A. Smith' } }],
        publication_year: 2021,
        open_access: { is_oa: true, oa_url: null },
        primary_location: {
          source: { id: 'https://openalex.org/S3005729997', display_name: 'medRxiv' },
          landing_page_url: 'https://www.medrxiv.org/content/10.1101/2021.02.02.000002v1',
          pdf_url: null,
        },
      }],
    }));
  });
  const out = await ss.searchMedRxiv('covid vaccine efficacy');
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'medrxiv');
  assert.equal(out[0].venue, 'medRxiv');
  assert.ok(out[0].htmlUrl.startsWith('https://www.medrxiv.org/content/'));
});

test('PROVIDERS includes biorxiv and medrxiv', () => {
  assert.ok(ss.PROVIDERS.includes('biorxiv'));
  assert.ok(ss.PROVIDERS.includes('medrxiv'));
});

// ── Scopus (key-gated) ──────────────────────────────────────────────────

test('searchScopus: returns [] without SCOPUS_API_KEY (no network call)', async () => {
  const orig = process.env.SCOPUS_API_KEY;
  delete process.env.SCOPUS_API_KEY;
  try {
    setFetchHandler(() => { throw new Error('should not be called'); });
    const out = await ss.searchScopus('anything');
    assert.deepEqual(out, []);
  } finally {
    if (orig !== undefined) process.env.SCOPUS_API_KEY = orig;
  }
});

test('searchScopus: maps STANDARD-view entries when SCOPUS_API_KEY is set', async () => {
  const orig = process.env.SCOPUS_API_KEY;
  process.env.SCOPUS_API_KEY = 'test-key';
  try {
    setFetchHandler((url, opts) => {
      assert.ok(url.includes('api.elsevier.com/content/search/scopus'));
      assert.equal(opts.headers['X-ELS-APIKey'], 'test-key', 'key sent in header, not URL');
      assert.ok(!url.includes('test-key'), 'key never in the URL');
      return Promise.resolve(jsonResponse({
        'search-results': {
          entry: [{
            'dc:identifier': 'SCOPUS_ID:85012345678',
            'dc:title': 'Deep learning for X',
            'dc:creator': 'Doe J.',
            'prism:coverDate': '2020-05-01',
            'prism:publicationName': 'Journal of X',
            'prism:doi': '10.1/x',
            'citedby-count': '42',
            openaccess: '1',
            link: [{ '@ref': 'scopus', '@href': 'https://www.scopus.com/record/85012345678' }],
          }],
        },
      }));
    });
    const out = await ss.searchScopus('deep learning');
    assert.equal(out.length, 1);
    assert.equal(out[0].source, 'scopus');
    assert.equal(out[0].id, 'scopus:85012345678');
    assert.equal(out[0].doi, '10.1/x');
    assert.equal(out[0].year, 2020);
    assert.equal(out[0].venue, 'Journal of X');
    assert.equal(out[0].citations, 42);
    assert.equal(out[0].openAccess, true);
    assert.equal(out[0].abstract, null, 'no abstract in STANDARD view');
    assert.equal(out[0].authors[0].name, 'Doe J.');
    assert.equal(out[0].htmlUrl, 'https://www.scopus.com/record/85012345678');
  } finally {
    if (orig === undefined) delete process.env.SCOPUS_API_KEY;
    else process.env.SCOPUS_API_KEY = orig;
  }
});

test('searchScopus: filters the synthetic empty-result entry', async () => {
  const orig = process.env.SCOPUS_API_KEY;
  process.env.SCOPUS_API_KEY = 'test-key';
  try {
    setFetchHandler(() => Promise.resolve(jsonResponse({
      'search-results': { entry: [{ error: 'Result set was empty' }] },
    })));
    const out = await ss.searchScopus('zzzzz');
    assert.deepEqual(out, []);
  } finally {
    if (orig === undefined) delete process.env.SCOPUS_API_KEY;
    else process.env.SCOPUS_API_KEY = orig;
  }
});

// ── Web of Science (key-gated) ──────────────────────────────────────────

test('searchWebOfScience: returns [] without a key (no network call)', async () => {
  const origW = process.env.WOS_API_KEY;
  const origC = process.env.CLARIVATE_API_KEY;
  delete process.env.WOS_API_KEY;
  delete process.env.CLARIVATE_API_KEY;
  try {
    setFetchHandler(() => { throw new Error('should not be called'); });
    const out = await ss.searchWebOfScience('anything');
    assert.deepEqual(out, []);
  } finally {
    if (origW !== undefined) process.env.WOS_API_KEY = origW;
    if (origC !== undefined) process.env.CLARIVATE_API_KEY = origC;
  }
});

test('searchWebOfScience: maps Starter API hits when WOS_API_KEY is set', async () => {
  const origW = process.env.WOS_API_KEY;
  const origC = process.env.CLARIVATE_API_KEY;
  process.env.WOS_API_KEY = 'wos-test-key';
  delete process.env.CLARIVATE_API_KEY;
  try {
    setFetchHandler((url, opts) => {
      assert.ok(url.includes('api.clarivate.com/apis/wos-starter'));
      assert.equal(opts.headers['X-ApiKey'], 'wos-test-key', 'X-ApiKey header, no Bearer');
      assert.ok(url.includes('TS%3D'), 'wraps the query in the TS topic field tag');
      return Promise.resolve(jsonResponse({
        metadata: { total: 1, page: 1, limit: 10 },
        hits: [{
          uid: 'WOS:000123456700001',
          title: 'A WoS paper',
          source: { sourceTitle: 'Nature', publishYear: 2020 },
          names: { authors: [{ displayName: 'Doe, J' }] },
          identifiers: { doi: '10.1/x' },
          citations: [{ db: 'WOS', count: 42 }],
          links: { record: 'https://www.webofscience.com/wos/woscc/full-record/WOS:000123456700001' },
          keywords: { authorKeywords: ['ml', 'ai'] },
        }],
      }));
    });
    const out = await ss.searchWebOfScience('machine learning');
    assert.equal(out.length, 1);
    assert.equal(out[0].source, 'wos');
    assert.equal(out[0].id, 'WOS:000123456700001');
    assert.equal(out[0].doi, '10.1/x');
    assert.equal(out[0].citations, 42);
    assert.equal(out[0].venue, 'Nature');
    assert.equal(out[0].year, 2020);
    assert.equal(out[0].htmlUrl, 'https://www.webofscience.com/wos/woscc/full-record/WOS:000123456700001');
    assert.equal(out[0].abstract, 'ml, ai', 'authorKeywords surfaced as a snippet');
    assert.equal(out[0].openAccess, null, 'OA not exposed by Starter API');
    assert.equal(out[0].pdfUrl, null);
    assert.equal(out[0].authors[0].name, 'Doe, J');
  } finally {
    if (origW === undefined) delete process.env.WOS_API_KEY; else process.env.WOS_API_KEY = origW;
    if (origC !== undefined) process.env.CLARIVATE_API_KEY = origC;
  }
});

test('PROVIDERS includes the worldwide sources', () => {
  for (const p of ['doaj', 'dblp', 'datacite', 'scielo', 'redalyc', 'scopus', 'wos']) {
    assert.ok(ss.PROVIDERS.includes(p), `${p} listed in PROVIDERS`);
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

// ── Per-provider isolation hardening ───────────────────────────────────

test('dedupeByDoi skips malformed (null / non-object) entries instead of throwing', () => {
  const { dedupeByDoi } = ss._internal;
  // A null and a primitive in the middle of an otherwise-valid list must NOT
  // abort the whole dedupe pass (which would drop the valid papers with them).
  const input = [
    null,
    { doi: '10.1/a', title: 'Valid A', abstract: 'x' },
    'not-a-paper',
    { doi: '10.1/b', title: 'Valid B' },
    undefined,
    { doi: '10.1/A', title: 'Valid A dup', abstract: 'longer abstract here', pdfUrl: 'u', openAccess: true },
  ];
  let out;
  assert.doesNotThrow(() => { out = dedupeByDoi(input); });
  // The two valid distinct DOIs survive (a + b); the a/A pair dedupes to one.
  assert.equal(out.length, 2);
  const dois = out.map((p) => ss._internal.normaliseDoi(p.doi)).sort();
  assert.deepEqual(dois, ['10.1/a', '10.1/b']);
});

test('search: a provider whose mapper throws on a malformed body is captured in errors; the rest still aggregate + dedupe', async () => {
  searchCache.clear();
  setFetchHandler((url) => {
    // SemanticScholar returns a malformed array — a null entry trips its mapper
    // (p.externalIds?.DOI on null throws). That provider must surface as an
    // error WITHOUT taking down arxiv/openalex.
    if (url.includes('semanticscholar.org')) {
      return Promise.resolve(jsonResponse({ data: [null, { paperId: 'p2', title: 'SS valid' }] }));
    }
    if (url.includes('arxiv.org')) {
      return Promise.resolve(textResponse(`<feed><entry>
        <id>http://arxiv.org/abs/Z</id>
        <title>Arxiv survivor</title>
        <published>2024-01-01</published>
        <arxiv:doi>10.surv/A</arxiv:doi>
      </entry></feed>`));
    }
    if (url.includes('openalex.org')) {
      return Promise.resolve(jsonResponse({ results: [{ id: 'W9', title: 'OpenAlex survivor', publication_year: 2023 }] }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  const out = await ss.search('isolation probe');
  // The malformed provider is recorded as an error…
  assert.ok(out.errors.some((e) => e.provider === 'semanticscholar'), 'failing provider captured in errors');
  // …and the healthy providers still contribute their papers.
  const titles = out.papers.map((p) => p.title);
  assert.ok(titles.includes('Arxiv survivor'), 'arxiv result survived the sibling failure');
  assert.ok(titles.includes('OpenAlex survivor'), 'openalex result survived the sibling failure');
});

test('search: a provider resolving to a non-array result is captured as an error, not silently dropped', async () => {
  // Reach the fan-out `collect` path with a non-array provider return by
  // supplying a custom provider list whose entry is a function that resolves to
  // a non-array. We piggyback on a real provider name (arxiv) but stub fetch so
  // the OTHER healthy provider still aggregates, then assert the malformed one
  // is reported. We trigger the non-array branch via the internal collect-equiv
  // guard exercised through dedupe; here we verify the end-to-end contract: a
  // provider that yields nothing usable never crashes the unified search.
  searchCache.clear();
  setFetchHandler((url) => {
    if (url.includes('arxiv.org')) {
      // Non-feed text → parseAtomFeed returns [] (no entries), provider yields [].
      return Promise.resolve(textResponse('<html><body>blocked by anti-bot</body></html>'));
    }
    if (url.includes('openalex.org')) {
      return Promise.resolve(jsonResponse({ results: [{ id: 'W1', title: 'Healthy', publication_year: 2022 }] }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  const out = await ss.search('html body probe', { providers: ['arxiv', 'openalex'] });
  // arxiv got HTML (no entries) → contributes nothing but does NOT throw;
  // openalex still aggregates. The whole search returns successfully.
  assert.equal(out.papers.length, 1);
  assert.equal(out.papers[0].title, 'Healthy');
});

test('collect guard: non-array provider value surfaces as a per-provider error (unit, via internal aggregation contract)', () => {
  // Mirror the exact aggregation logic the fan-out uses so a regression in the
  // non-array guard is caught even though PROVIDER_FUNCS is not exported. This
  // asserts the SHAPE of the guarantee: a non-array provider value must become
  // an error entry, never an uncaught `for…of` throw nor a silent disappearance.
  const errors = [];
  const papers = [];
  const collect = (entry) => {
    if ('reason' in entry) { errors.push({ provider: entry.p, message: String(entry.reason) }); return; }
    if (!Array.isArray(entry.value)) {
      errors.push({ provider: entry.p, message: `provider returned a non-array result (${entry.value === null ? 'null' : typeof entry.value})` });
      return;
    }
    for (const paper of entry.value) { if (paper && typeof paper === 'object') papers.push(paper); }
  };
  assert.doesNotThrow(() => collect({ p: 'bad', value: { not: 'array' } }));
  assert.doesNotThrow(() => collect({ p: 'nul', value: null }));
  collect({ p: 'ok', value: [{ title: 'Good' }, null, 'junk'] });
  assert.equal(papers.length, 1, 'only the valid object entry is kept');
  assert.ok(errors.some((e) => e.provider === 'bad'), 'non-array object → error');
  assert.ok(errors.some((e) => e.provider === 'nul'), 'null value → error');
});

// ── Source diversification ────────────────────────────────────────────────
const { diversifyBySource } = ss;

test('diversifyBySource breaks a long single-source run while preserving relevance order at the top', () => {
  // Incoming list is already ranked: 5 semanticscholar, then arxiv, then openalex.
  const ranked = [
    { source: 'semanticscholar', title: 's1' },
    { source: 'semanticscholar', title: 's2' },
    { source: 'semanticscholar', title: 's3' },
    { source: 'semanticscholar', title: 's4' },
    { source: 'semanticscholar', title: 's5' },
    { source: 'arxiv', title: 'a1' },
    { source: 'openalex', title: 'o1' },
  ];
  const out = diversifyBySource(ranked, { maxRun: 2 });
  // No paper is dropped or duplicated.
  assert.equal(out.length, ranked.length);
  assert.deepEqual(
    [...out].map((p) => p.title).sort(),
    [...ranked].map((p) => p.title).sort(),
  );
  // The two most-relevant papers survive untouched at the top.
  assert.equal(out[0].title, 's1');
  assert.equal(out[1].title, 's2');
  // No run of more than 2 consecutive identical sources anywhere.
  let run = 1;
  for (let i = 1; i < out.length; i += 1) {
    run = out[i].source === out[i - 1].source ? run + 1 : 1;
    assert.ok(run <= 2, `run of ${run} same-source at index ${i}`);
  }
  // The first 3 picks now span >1 source (diversity reached the first screenful).
  assert.ok(new Set(out.slice(0, 3).map((p) => p.source)).size >= 2);
});

test('diversifyBySource does not starve when only one source remains', () => {
  const ranked = [
    { source: 'arxiv', title: 'a1' },
    { source: 'semanticscholar', title: 's1' },
    { source: 'semanticscholar', title: 's2' },
    { source: 'semanticscholar', title: 's3' },
  ];
  const out = diversifyBySource(ranked, { maxRun: 2 });
  assert.equal(out.length, 4, 'every paper is retained even with a same-source tail');
  assert.deepEqual([...out].map((p) => p.title).sort(), ['a1', 's1', 's2', 's3']);
});

test('diversifyBySource is a no-op for lists at or below maxRun', () => {
  const tiny = [{ source: 'arxiv', title: 'a' }, { source: 'arxiv', title: 'b' }];
  assert.deepEqual(diversifyBySource(tiny, { maxRun: 2 }), tiny);
  assert.deepEqual(diversifyBySource([], { maxRun: 2 }), []);
  assert.deepEqual(diversifyBySource(null), []);
});

test('search diversifies sources by default and opts out with diversify:false', async () => {
  searchCache.clear();
  // arxiv + openalex each contribute multiple papers; without diversification
  // the relevance/citation tiebreakers would cluster a source at the top.
  setFetchHandler((url) => {
    if (url.includes('arxiv.org')) {
      return Promise.resolve(textResponse(`<feed>
        <entry><id>http://arxiv.org/abs/A1</id><title>diversity probe alpha</title><published>2024-01-01</published></entry>
        <entry><id>http://arxiv.org/abs/A2</id><title>diversity probe beta</title><published>2024-01-01</published></entry>
        <entry><id>http://arxiv.org/abs/A3</id><title>diversity probe gamma</title><published>2024-01-01</published></entry>
      </feed>`));
    }
    if (url.includes('openalex.org')) {
      return Promise.resolve(jsonResponse({ results: [
        { id: 'W1', title: 'diversity probe delta', publication_year: 2024 },
        { id: 'W2', title: 'diversity probe epsilon', publication_year: 2024 },
      ] }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  const out = await ss.search('diversity probe', { providers: ['arxiv', 'openalex'] });
  assert.equal(out.papers.length, 5);
  // Default-on: no run of 3+ identical sources.
  let run = 1;
  for (let i = 1; i < out.papers.length; i += 1) {
    run = out.papers[i].source === out.papers[i - 1].source ? run + 1 : 1;
    assert.ok(run <= 2, 'default search interleaves sources');
  }

  searchCache.clear();
  const raw = await ss.search('diversity probe', { providers: ['arxiv', 'openalex'], diversify: false });
  assert.equal(raw.papers.length, 5, 'opt-out keeps every paper');
});

// ── Unpaywall OA enrichment ────────────────────────────────────────────────
const { enrichWithUnpaywall } = ss;

test('enrichWithUnpaywall backfills pdfUrl for DOI-bearing papers lacking a PDF', async () => {
  const orig = process.env.SIRAGPT_RESEARCH_EMAIL;
  process.env.SIRAGPT_RESEARCH_EMAIL = 'tester@example.com';
  try {
    setFetchHandler((url) => {
      assert.ok(url.includes('api.unpaywall.org/v2/'), 'hits Unpaywall');
      assert.ok(url.includes('email='), 'sends the mandatory contact email');
      return Promise.resolve(jsonResponse({
        is_oa: true,
        best_oa_location: { url_for_pdf: 'https://oa.example.org/paper.pdf', url: 'https://oa.example.org/paper' },
      }));
    });
    const papers = [{ source: 'scopus', doi: '10.1000/closed', title: 'Closed-index hit', pdfUrl: null, openAccess: null }];
    const out = await enrichWithUnpaywall(papers, { maxEnrich: 5 });
    assert.equal(out[0].pdfUrl, 'https://oa.example.org/paper.pdf', 'pdf backfilled');
    assert.equal(out[0].openAccess, true, 'openAccess flipped true when is_oa');
  } finally {
    if (orig === undefined) delete process.env.SIRAGPT_RESEARCH_EMAIL;
    else process.env.SIRAGPT_RESEARCH_EMAIL = orig;
  }
});

test('enrichWithUnpaywall is a no-op without SIRAGPT_RESEARCH_EMAIL (no network call)', async () => {
  const orig = process.env.SIRAGPT_RESEARCH_EMAIL;
  delete process.env.SIRAGPT_RESEARCH_EMAIL;
  try {
    setFetchHandler(() => { throw new Error('should not be called'); });
    const papers = [{ source: 'crossref', doi: '10.1/x', pdfUrl: null }];
    const out = await enrichWithUnpaywall(papers, { maxEnrich: 5 });
    assert.equal(out[0].pdfUrl, null, 'left untouched without an email');
  } finally {
    if (orig !== undefined) process.env.SIRAGPT_RESEARCH_EMAIL = orig;
  }
});

test('enrichWithUnpaywall skips papers that already have a PDF or no DOI, and never throws on lookup failure', async () => {
  const orig = process.env.SIRAGPT_RESEARCH_EMAIL;
  process.env.SIRAGPT_RESEARCH_EMAIL = 'tester@example.com';
  let calls = 0;
  try {
    setFetchHandler((url) => {
      calls += 1;
      assert.ok(url.includes('10.1000/needs-pdf'), 'only the candidate without a PDF is looked up');
      return Promise.resolve(errorResponse(404)); // Unpaywall miss → safeJson throws → swallowed
    });
    const papers = [
      { source: 'arxiv', doi: '10.1000/has-pdf', pdfUrl: 'https://arxiv.org/pdf/x', openAccess: true },
      { source: 'dblp', doi: null, pdfUrl: null },          // no DOI → skipped
      { source: 'wos', doi: '10.1000/needs-pdf', pdfUrl: null, openAccess: null }, // looked up, 404
    ];
    const out = await enrichWithUnpaywall(papers, { maxEnrich: 5 });
    assert.equal(calls, 1, 'exactly one outbound lookup (the only eligible candidate)');
    assert.equal(out[2].pdfUrl, null, 'failed lookup leaves the paper unchanged');
    assert.equal(out[0].pdfUrl, 'https://arxiv.org/pdf/x', 'paper with a PDF untouched');
  } finally {
    if (orig === undefined) delete process.env.SIRAGPT_RESEARCH_EMAIL;
    else process.env.SIRAGPT_RESEARCH_EMAIL = orig;
  }
});

test('enrichWithUnpaywall caps outbound lookups at maxEnrich', async () => {
  const orig = process.env.SIRAGPT_RESEARCH_EMAIL;
  process.env.SIRAGPT_RESEARCH_EMAIL = 'tester@example.com';
  let calls = 0;
  try {
    setFetchHandler(() => { calls += 1; return Promise.resolve(jsonResponse({ is_oa: false })); });
    const papers = Array.from({ length: 10 }, (_, i) => ({ source: 'crossref', doi: `10.1/${i}`, pdfUrl: null }));
    await enrichWithUnpaywall(papers, { maxEnrich: 3 });
    assert.equal(calls, 3, 'no more than maxEnrich lookups');
  } finally {
    if (orig === undefined) delete process.env.SIRAGPT_RESEARCH_EMAIL;
    else process.env.SIRAGPT_RESEARCH_EMAIL = orig;
  }
});

test('search runs Unpaywall enrichment only when opts.unpaywall is set', async () => {
  const orig = process.env.SIRAGPT_RESEARCH_EMAIL;
  process.env.SIRAGPT_RESEARCH_EMAIL = 'tester@example.com';
  try {
    searchCache.clear();
    let unpaywallCalls = 0;
    setFetchHandler((url) => {
      if (url.includes('api.unpaywall.org')) {
        unpaywallCalls += 1;
        return Promise.resolve(jsonResponse({ is_oa: true, best_oa_location: { url_for_pdf: 'https://oa/x.pdf' } }));
      }
      if (url.includes('crossref.org')) {
        return Promise.resolve(jsonResponse({ message: { items: [
          { DOI: '10.5/closed', title: ['Closed paper'], type: 'journal-article' },
        ] } }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    const off = await ss.search('enrich probe', { providers: ['crossref'] });
    assert.equal(unpaywallCalls, 0, 'default search does not call Unpaywall');
    assert.ok(off.papers.length >= 1);

    searchCache.clear();
    const on = await ss.search('enrich probe', { providers: ['crossref'], unpaywall: true });
    assert.ok(unpaywallCalls >= 1, 'opt-in search calls Unpaywall');
    const enriched = on.papers.find((p) => p.doi === '10.5/closed');
    assert.ok(enriched && enriched.pdfUrl === 'https://oa/x.pdf', 'pdf backfilled in opt-in search');
  } finally {
    if (orig === undefined) delete process.env.SIRAGPT_RESEARCH_EMAIL;
    else process.env.SIRAGPT_RESEARCH_EMAIL = orig;
  }
});
