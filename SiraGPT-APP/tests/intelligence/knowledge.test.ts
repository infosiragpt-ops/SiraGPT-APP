import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createOpenAlexSource, type FetchLike } from '../../server/intelligence/knowledge/openalex.adapter';
import { createSemanticScholarSource } from '../../server/intelligence/knowledge/semantic-scholar.adapter';
import {
  createHybridRetriever,
  lexicalRerank,
} from '../../server/intelligence/knowledge/hybrid-retriever';
import type { KnowledgeSource, RetrievedChunk } from '../../server/intelligence/ports';

function jsonFetch(body: unknown): FetchLike {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

describe('intelligence/knowledge · OpenAlex', () => {
  it('reconstructs abstracts from the inverted index', async () => {
    const source = createOpenAlexSource({
      fetchImpl: jsonFetch({
        results: [
          {
            id: 'https://openalex.org/W1',
            title: 'On Primes',
            abstract_inverted_index: { there: [0], are: [1], infinitely: [2], many: [3], primes: [4] },
            cited_by_count: 10,
            primary_location: { landing_page_url: 'https://example.org/w1' },
          },
        ],
      }),
    });
    const chunks = await source.search({ query: 'primes' });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].text, 'there are infinitely many primes');
    assert.equal(chunks[0].source, 'openalex');
    assert.equal(chunks[0].url, 'https://example.org/w1');
  });

  it('returns [] on a non-ok response', async () => {
    const source = createOpenAlexSource({
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    });
    assert.deepEqual(await source.search({ query: 'x' }), []);
  });
});

describe('intelligence/knowledge · Semantic Scholar', () => {
  it('maps papers to chunks', async () => {
    const source = createSemanticScholarSource({
      fetchImpl: jsonFetch({
        data: [{ paperId: 'p1', title: 'Deep Nets', abstract: 'a study', url: 'http://s2/p1', citationCount: 7 }],
      }),
    });
    const chunks = await source.search({ query: 'deep nets' });
    assert.equal(chunks[0].text, 'a study');
    assert.equal(chunks[0].source, 'semantic-scholar');
  });
});

describe('intelligence/knowledge · hybrid retriever', () => {
  function source(name: string, chunks: RetrievedChunk[]): KnowledgeSource {
    return { name, search: async () => chunks };
  }

  it('merges, de-duplicates and grounds results', async () => {
    const retriever = createHybridRetriever({
      sources: [
        source('a', [
          { id: '1', text: 'alpha beta gamma', score: 5, source: 'a', url: 'http://x/1' },
          { id: '2', text: 'delta', score: 1, source: 'a', url: 'http://x/2' },
        ]),
        source('b', [
          // duplicate url of #1 with a lower score — should be de-duped
          { id: '1b', text: 'alpha beta gamma', score: 2, source: 'b', url: 'http://x/1' },
          { id: '3', text: 'epsilon', score: 3, source: 'b', url: 'http://x/3' },
        ]),
      ],
    });
    const res = await retriever.retrieve({ query: 'alpha beta' });
    const urls = res.chunks.map((c) => c.url);
    assert.equal(new Set(urls).size, urls.length); // no dup urls
    assert.ok(res.grounding.sources.length >= 1);
    // The alpha/beta doc should rank first given the query.
    assert.equal(res.chunks[0].text, 'alpha beta gamma');
  });

  it('survives a failing source', async () => {
    const bad: KnowledgeSource = {
      name: 'bad',
      search: async () => {
        throw new Error('boom');
      },
    };
    const good = source('good', [{ id: '1', text: 'ok', score: 1, source: 'good' }]);
    const retriever = createHybridRetriever({ sources: [bad, good] });
    const res = await retriever.retrieve({ query: 'ok' });
    assert.equal(res.chunks.length, 1);
  });

  it('lexicalRerank orders by relevance', () => {
    const ranked = lexicalRerank('quantum computing', [
      { id: '1', text: 'cooking recipes', score: 9, source: 's' },
      { id: '2', text: 'quantum computing advances', score: 1, source: 's' },
    ]);
    assert.equal(ranked[0].id, '2');
  });
});
