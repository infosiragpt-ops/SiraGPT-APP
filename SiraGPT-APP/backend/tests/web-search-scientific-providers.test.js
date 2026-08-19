/**
 * Tests for the four scientific providers:
 *   crossref, pubmed, openalex, arxiv.
 *
 * Same pattern as web-search-scielo.test.js: stub node-fetch via
 * require.cache BEFORE loading the providers, then feed crafted
 * payloads and assert the normalised shape.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const fetchPath = require.resolve('node-fetch');
let fetchImpl = async () => { throw new Error('fetch not mocked'); };
require.cache[fetchPath] = {
  id: fetchPath,
  filename: fetchPath,
  loaded: true,
  exports: (...args) => fetchImpl(...args),
};

const crossref = require('../src/services/agents/web-search/providers/crossref');
const pubmed = require('../src/services/agents/web-search/providers/pubmed');
const openalex = require('../src/services/agents/web-search/providers/openalex');
const arxiv = require('../src/services/agents/web-search/providers/arxiv');

function json(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}
function text(s, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => s,
    json: async () => { throw new Error('not json'); },
  };
}

beforeEach(() => { fetchImpl = async () => { throw new Error('fetch not mocked'); }; });

// ─── crossref ────────────────────────────────────────────────────────

test('crossref: parses items, prefers DOI link, fills meta + abstract', async () => {
  let capturedUrl = '';
  fetchImpl = async (url) => {
    capturedUrl = String(url);
    return json({
      message: {
        items: [
          {
            DOI: '10.1038/s41586-020-2649-2',
            title: ['Array programming with NumPy'],
            author: [{ given: 'Charles', family: 'Harris' }, { given: 'K.', family: 'Millman' }],
            'container-title': ['Nature'],
            'published-print': { 'date-parts': [[2020, 9, 17]] },
            abstract: '<p>NumPy is the primary array programming library…</p>',
          },
          {
            DOI: '10.1016/j.cell.2020.02.052',
            title: ['Some other paper'],
            URL: 'https://doi.org/10.1016/j.cell.2020.02.052',
          },
        ],
      },
    });
  };
  const out = await crossref.search('numpy', { maxResults: 5 });
  assert.match(capturedUrl, /api\.crossref\.org\/works/);
  assert.match(capturedUrl, /mailto=/);
  assert.equal(out.length, 2);
  assert.equal(out[0].source, 'crossref');
  assert.equal(out[0].url, 'https://doi.org/10.1038/s41586-020-2649-2');
  assert.match(out[0].snippet, /Nature/);
  assert.match(out[0].snippet, /2020/);
  assert.match(out[0].snippet, /Charles Harris/);
  // HTML stripped from abstract.
  assert.equal(/<p>/.test(out[0].snippet), false);
});

test('crossref: skips items without title or URL/DOI', async () => {
  fetchImpl = async () => json({ message: { items: [
    { title: ['only title, no DOI/URL'] },
    { DOI: '10.x/y' /* no title */ },
    { DOI: '10.z/w', title: ['Good one'] },
  ]}});
  const out = await crossref.search('q');
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Good one');
});

test('crossref: throws on non-2xx so adapter classifies as http_5xx/4xx', async () => {
  fetchImpl = async () => json({}, { status: 503 });
  await assert.rejects(() => crossref.search('q'), /crossref http 503/);
});

// ─── pubmed ──────────────────────────────────────────────────────────

test('pubmed: chains esearch → esummary and builds PubMed URL', async () => {
  const calls = [];
  fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('esearch.fcgi')) {
      return json({ esearchresult: { idlist: ['33421321', '12345678'] } });
    }
    return json({
      result: {
        uids: ['33421321', '12345678'],
        33421321: {
          title: 'COVID-19 vaccine efficacy',
          source: 'NEJM',
          pubdate: '2021 Jan',
          authors: [{ name: 'Polack F' }, { name: 'Thomas S' }],
          articleids: [{ idtype: 'doi', value: '10.1056/NEJMoa2034577' }],
        },
        12345678: {
          title: 'Another paper',
          source: 'Lancet',
          pubdate: '2022 Mar',
        },
      },
    });
  };
  const out = await pubmed.search('covid vaccine', { maxResults: 5 });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /esearch\.fcgi/);
  assert.match(calls[1], /esummary\.fcgi/);
  assert.match(calls[1], /id=33421321%2C12345678|id=33421321,12345678/);
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'https://pubmed.ncbi.nlm.nih.gov/33421321/');
  assert.equal(out[0].source, 'pubmed');
  assert.match(out[0].snippet, /NEJM/);
  assert.match(out[0].snippet, /2021/);
  assert.match(out[0].snippet, /Polack F/);
  assert.match(out[0].snippet, /10\.1056\/NEJMoa2034577/);
});

test('pubmed: empty esearch idlist returns [] without calling esummary', async () => {
  let calls = 0;
  fetchImpl = async () => { calls++; return json({ esearchresult: { idlist: [] } }); };
  const out = await pubmed.search('not biomedical at all');
  assert.deepEqual(out, []);
  assert.equal(calls, 1);
});

test('pubmed: esearch non-2xx throws', async () => {
  fetchImpl = async () => json({}, { status: 500 });
  await assert.rejects(() => pubmed.search('q'), /pubmed esearch http 500/);
});

// ─── openalex ────────────────────────────────────────────────────────

test('openalex: parses results and rebuilds inverted-index abstract', async () => {
  fetchImpl = async (url) => {
    assert.match(String(url), /api\.openalex\.org\/works/);
    assert.match(String(url), /mailto=/);
    return json({
      results: [
        {
          id: 'https://openalex.org/W2741809807',
          doi: 'https://doi.org/10.1038/s41586-020-2649-2',
          title: 'Array programming with NumPy',
          abstract_inverted_index: { Array: [0], programming: [1], with: [2], NumPy: [3], is: [4], fast: [5] },
          authorships: [{ author: { display_name: 'Charles R. Harris' } }],
          publication_year: 2020,
          primary_location: { source: { display_name: 'Nature' } },
        },
        {
          id: 'https://openalex.org/W123',
          title: 'OA-only paper',
          open_access: { is_oa: true, oa_url: 'https://example.org/paper.pdf' },
        },
      ],
    });
  };
  const out = await openalex.search('numpy', { maxResults: 5 });
  assert.equal(out.length, 2);
  assert.equal(out[0].source, 'openalex');
  assert.equal(out[0].url, 'https://doi.org/10.1038/s41586-020-2649-2');
  assert.match(out[0].snippet, /Nature/);
  assert.match(out[0].snippet, /Array programming with NumPy is fast/);
  // Second item has no DOI → falls back to oa_url.
  assert.equal(out[1].url, 'https://example.org/paper.pdf');
});

test('openalex: rebuildAbstract returns empty for missing index', () => {
  assert.equal(openalex._rebuildAbstract(null), '');
  assert.equal(openalex._rebuildAbstract({}), '');
});

test('openalex: non-2xx throws', async () => {
  fetchImpl = async () => json({}, { status: 429 });
  await assert.rejects(() => openalex.search('q'), /openalex http 429/);
});

// ─── arxiv ───────────────────────────────────────────────────────────

const ARXIV_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <updated>2024-01-23T10:00:00Z</updated>
    <published>2024-01-23T10:00:00Z</published>
    <title>Attention Is All You Need &amp; More</title>
    <summary>We propose a new attention mechanism for transformers.</summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2402.00001v2</id>
    <published>2024-02-01T10:00:00Z</published>
    <title>Second paper</title>
    <summary>Another abstract.</summary>
    <author><name>Single Author</name></author>
  </entry>
</feed>`;

test('arxiv: parses Atom XML, rewrites http→https, decodes entities', async () => {
  fetchImpl = async (url) => {
    assert.match(String(url), /export\.arxiv\.org\/api\/query/);
    assert.match(String(url), /search_query=all%3A/);
    return text(ARXIV_XML);
  };
  const out = await arxiv.search('transformers', { maxResults: 5 });
  assert.equal(out.length, 2);
  assert.equal(out[0].source, 'arxiv');
  assert.equal(out[0].url, 'https://arxiv.org/abs/2401.12345v1');
  assert.equal(out[0].title, 'Attention Is All You Need & More');
  assert.match(out[0].snippet, /arXiv/);
  assert.match(out[0].snippet, /2024/);
  assert.match(out[0].snippet, /Ashish Vaswani/);
  assert.match(out[0].snippet, /attention mechanism/);
});

test('arxiv: returns [] when XML has no entries', async () => {
  fetchImpl = async () => text('<feed xmlns="http://www.w3.org/2005/Atom"></feed>');
  const out = await arxiv.search('nothing', { maxResults: 5 });
  assert.deepEqual(out, []);
});

test('arxiv: ignores entries with non-arxiv id', async () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry><id>http://example.org/foo</id><title>Foreign</title><summary>x</summary></entry>
    <entry><id>http://arxiv.org/abs/9999.99999</id><title>Real</title><summary>x</summary></entry>
  </feed>`;
  fetchImpl = async () => text(xml);
  const out = await arxiv.search('q');
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Real');
});

test('arxiv: non-2xx throws', async () => {
  fetchImpl = async () => text('', { status: 503 });
  await assert.rejects(() => arxiv.search('q'), /arxiv http 503/);
});

// ─── registry metadata ───────────────────────────────────────────────

test('scientific providers carry the expected priority + enabled metadata', () => {
  assert.equal(crossref.priority, 3);
  assert.equal(pubmed.priority, 4);
  assert.equal(openalex.priority, 6);
  assert.equal(arxiv.priority, 7);
  for (const p of [crossref, pubmed, openalex, arxiv]) {
    assert.equal(p.enabled, true);
    assert.equal(typeof p.search, 'function');
  }
});
