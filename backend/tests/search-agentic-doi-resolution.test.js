'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runAgenticBatch, buildSummaryMarkdown } = require('../src/services/searchBrain/agenticBatch');

test('agentic search resolves DOI only after ranking and exposes validation events', async () => {
  let retrievalCalls = 0;
  let resolverCalls = 0;
  const events = [];
  const papers = Array.from({ length: 5 }, (_, index) => ({
    source: 'openalex',
    title: `Telemedicine evidence ${index}`,
    authors: [`Author ${index}`],
    year: 2024,
    journal: 'Evidence Journal',
    doi: `10.1234/telemedicine.${index}`,
    abstract: 'Telemedicine evidence for adult patients.',
    citationCount: 10 - index,
  }));

  for await (const event of runAgenticBatch({
    query: 'telemedicine evidence',
    target: 10,
    batchSize: 5,
    topK: 2,
    providers: ['openalex'],
    deps: {
      retrieve: async () => (++retrievalCalls === 1 ? papers : []),
      rerank: async ({ results }) => ({ results, reranked: false }),
      resolveDois: async (selected) => {
        resolverCalls++;
        return selected.map((paper) => ({
          ...paper,
          doiResolutionStatus: 'resolved',
          doiResolvedUrl: `https://publisher.example/${paper.doi}`,
        }));
      },
      sleep: async () => {},
    },
  })) events.push(event);

  assert.equal(resolverCalls, 1);
  assert.ok(events.some((event) => event.type === 'validation_start'));
  assert.equal(events.find((event) => event.type === 'validation_done').resolved, 2);
  assert.ok(events.find((event) => event.type === 'selected').sources.every((source) => source.doiResolutionStatus === 'resolved'));
  assert.equal(events.find((event) => event.type === 'done').stats.resolvedDoiCount, 2);
});

test('summary distinguishes resolved DOI from syntax-only DOI', () => {
  const markdown = buildSummaryMarkdown({
    query: 'evidence',
    totalCollected: 2,
    dedupedCount: 2,
    providerStats: { openalex: { contributed: 2 } },
    top: [
      { title: 'Resolved', authors: ['A'], doi: '10.1234/a', doiStatus: 'format_valid', doiResolutionStatus: 'resolved', sources: ['openalex'], sourceCount: 1 },
      { title: 'Syntax only', authors: ['B'], doi: '10.1234/b', doiStatus: 'format_valid', sources: ['openalex'], sourceCount: 1 },
    ],
  });
  assert.match(markdown, /DOI resuelto en línea/);
  assert.match(markdown, /resolución no confirmada/);
  assert.match(markdown, /1 DOI fueron resueltos en línea/);
});

test('agentic chat applies PICO screening and emits a PRISMA audit payload', async () => {
  const events = [];
  const papers = [
    {
      source: 'pubmed', title: 'Telemedicina para adultos con diabetes', year: 2024,
      abstract: 'Adultos con diabetes recibieron telemedicina y mejoraron el control glucémico.',
      doi: '10.1234/current', journal: 'Clinical Evidence',
    },
    {
      source: 'pubmed', title: 'Estudio histórico de diabetes', year: 2017,
      abstract: 'Adultos con diabetes recibieron telemedicina.', doi: '10.1234/old',
    },
  ];
  for await (const event of runAgenticBatch({
    query: 'Revisión sistemática PICO entre 2020 y 2026; Población: adultos con diabetes; Intervención: telemedicina; Comparación: atención habitual; Resultado: control glucémico',
    target: 10,
    batchSize: 5,
    topK: 2,
    providers: ['pubmed'],
    resolveDois: false,
    deps: {
      retrieve: async () => papers,
      rerank: async ({ results }) => ({ results, reranked: false }),
      sleep: async () => {},
    },
  })) events.push(event);

  const start = events.find((event) => event.type === 'start');
  const review = events.find((event) => event.type === 'systematic_review');
  const selected = events.find((event) => event.type === 'selected');
  assert.equal(start.protocol.framework, 'pico');
  assert.match(start.queries[0], /"adultos con diabetes" AND "telemedicina"/);
  assert.equal(review.prisma.screening.recordsExcluded, 1);
  assert.ok(review.prisma.deduplication.duplicatesRemoved > 0);
  assert.equal(selected.sources.length, 1);
  assert.equal(selected.sources[0].riskOfBias.requiresFullTextAssessment, true);
  assert.match(events.find((event) => event.type === 'summary').markdown, /Flujo PRISMA preliminar/);
});
