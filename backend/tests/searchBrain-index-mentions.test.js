'use strict';

// Prod 2026-09-27: «busca papers sobre telemedicina en arxiv» searched «arxiv»
// as a topic across 16 indexes and ranked arXiv's blog posts and FAQs among
// the top results. A named index picks the providers and leaves the topic.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractIndexMentions } = require('../src/services/searchBrain/index-mentions');
const { REGISTRY } = require('../src/services/searchBrain/providers');
const { runAgenticBatch } = require('../src/services/searchBrain/agenticBatch');

test('named indexes become providers and leave the topic query', () => {
  for (const [query, providers, topicQuery] of [
    ['busca papers sobre telemedicina en arxiv', ['arxiv'], 'busca papers sobre telemedicina'],
    ['busca artículos de telemedicina en arXiv y PubMed', ['arxiv', 'pubmed'], 'busca artículos de telemedicina'],
    ['papers on federated learning from Semantic Scholar', ['semantic'], 'papers on federated learning'],
    ['estudios en la base de datos SciELO sobre anemia', ['scielo'], 'estudios sobre anemia'],
    ['busca en Scopus revisiones sobre diabetes tipo 2', ['scopus'], 'busca revisiones sobre diabetes tipo 2'],
    ['bioRxiv preprints sobre CRISPR', ['biorxiv'], 'preprints sobre CRISPR'],
    ['artículos en web of science sobre educación superior', ['wos'], 'artículos sobre educación superior'],
  ]) {
    assert.deepEqual(extractIndexMentions(query, REGISTRY), { providers, topicQuery }, query);
  }
});

test('ordinary words and unregistered names are left alone', () => {
  for (const query of ['telemedicina rural en el Perú', 'core concepts of machine learning', 'arxivista del siglo XIX']) {
    assert.deepEqual(extractIndexMentions(query, REGISTRY), { providers: [], topicQuery: query }, query);
  }
  assert.deepEqual(extractIndexMentions('papers en arxiv', {}), { providers: [], topicQuery: 'papers en arxiv' });
});

test('the batch searches only the named index and never the index name', async () => {
  const calls = [];
  const events = [];
  for await (const event of runAgenticBatch({
    query: 'busca papers sobre telemedicina en arxiv',
    target: 10,
    batchSize: 5,
    topK: 3,
    resolveDois: false,
    deps: {
      retrieve: async ({ source, query }) => {
        calls.push({ provider: source, searchQuery: String(query) });
        return [];
      },
      rerank: async ({ results }) => ({ results, reranked: false }),
      sleep: async () => {},
    },
  })) events.push(event);
  const start = events.find((event) => event.type === 'start');
  assert.deepEqual(start.providers, ['arxiv']);
  assert.ok(start.queries.length > 0 && start.queries.every((q) => !/arxiv/i.test(q)), start.queries.join(' | '));
  assert.ok(calls.length > 0 && calls.every((call) => call.provider === 'arxiv'));
  assert.ok(calls.every((call) => !/arxiv/i.test(call.searchQuery)));
});

test('explicit providers from the caller still win over the query text', async () => {
  const events = [];
  for await (const event of runAgenticBatch({
    query: 'papers sobre telemedicina en arxiv',
    providers: ['pubmed'],
    target: 10,
    batchSize: 5,
    topK: 3,
    resolveDois: false,
    deps: { retrieve: async () => [], rerank: async ({ results }) => ({ results, reranked: false }), sleep: async () => {} },
  })) events.push(event);
  assert.deepEqual(events.find((event) => event.type === 'start').providers, ['pubmed']);
});
