'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  orderProvidersForDiscipline,
  routeDiscipline,
} = require('../src/services/research/research-discipline-router');
const { analyzeQuery } = require('../src/services/research/research-query-intelligence');
const { runAgenticBatch } = require('../src/services/searchBrain/agenticBatch');
const { buildLiteratureReview } = require('../src/services/research/literature-review-engine');

test('discipline router prioritizes biomedical indexes and adds matched controlled terms', () => {
  const route = routeDiscipline('home blood pressure monitoring for adults with hypertension');
  assert.equal(route.id, 'health_sciences');
  assert.ok(['high', 'medium'].includes(route.confidence));
  assert.ok(route.controlledVocabulary.includes('arterial hypertension'));
  assert.ok(route.controlledVocabulary.includes('self-measured blood pressure'));

  const ordered = orderProvidersForDiscipline(
    ['openalex', 'crossref', 'pubmed', 'europepmc', 'scielo'],
    route,
  );
  assert.deepEqual(ordered.slice(0, 2), ['pubmed', 'europepmc']);
  assert.deepEqual(new Set(ordered), new Set(['openalex', 'crossref', 'pubmed', 'europepmc', 'scielo']));
});

test('query intelligence exposes education routing without removing literal intent', () => {
  const plan = analyzeQuery('aprendizaje en estudiantes de educacion superior');
  assert.equal(plan.discipline.id, 'education');
  assert.ok(plan.discipline.controlledVocabulary.includes('tertiary education'));
  assert.ok(plan.searchQueries[0].includes('aprendizaje'));
  assert.ok(plan.searchQueries.some((query) => /tertiary education/i.test(query)));
});

test('explicit discipline override is auditable and general fallback stays neutral', () => {
  const explicit = analyzeQuery('impacto de modelos predictivos', { discipline: 'business_economics' });
  assert.equal(explicit.discipline.id, 'business_economics');
  assert.equal(explicit.discipline.confidence, 'explicit');
  assert.equal(explicit.discipline.explicit, true);

  const general = analyzeQuery('quantumfoobar zetaomega');
  assert.equal(general.discipline.id, 'general');
  assert.deepEqual(general.discipline.controlledVocabulary, []);
});

test('agentic search automatically orders default providers for the detected discipline', async () => {
  const generator = runAgenticBatch({
    query: 'clinical hypertension treatment in adult patients',
    target: 10,
    batchSize: 5,
    topK: 2,
    resolveDois: false,
    deps: {
      retrieve: async () => [],
      rerank: async ({ results }) => ({ results, reranked: false }),
      sleep: async () => {},
    },
  });
  const first = await generator.next();
  assert.equal(first.value.type, 'start');
  assert.equal(first.value.discipline.id, 'health_sciences');
  assert.deepEqual(first.value.providers.slice(0, 2), ['pubmed', 'europepmc']);
  assert.equal(first.value.limits.requestedTarget, 10);
  await generator.return();
});

test('literature review applies the same discipline routing to its provider fan-out', async () => {
  let observedProviders = [];
  const review = await buildLiteratureReview('hypertension treatment in clinical patients', {
    resolveDois: false,
    searchImpl: async (_query, opts) => {
      observedProviders = opts.providers;
      return { papers: [], errors: [], providers: opts.providers };
    },
  });
  assert.equal(review.query.discipline.id, 'health_sciences');
  assert.deepEqual(observedProviders.slice(0, 2), ['pubmed', 'europepmc']);
  assert.ok(observedProviders.includes('openalex'));
  assert.ok(observedProviders.includes('crossref'));
  assert.ok(observedProviders.includes('semanticscholar'));
});

test('deep retrieval paginates until target and returns an auditable stop reason', async () => {
  const offsets = [];
  const events = [];
  for await (const event of runAgenticBatch({
    query: 'quantumfoobar zetaomega',
    target: 25,
    batchSize: 5,
    topK: 3,
    providers: ['openalex'],
    resolveDois: false,
    deps: {
      retrieve: async ({ offset, maxResults }) => {
        offsets.push(offset);
        return Array.from({ length: maxResults }, (_, index) => ({
          source: 'openalex',
          title: `Quantumfoobar zetaomega evidence ${offset + index}`,
          abstract: 'Quantumfoobar zetaomega evidence with reproducible methods and results.',
          year: 2024,
          doi: `10.1234/deep.${offset + index}`,
          citationCount: 100 - offset - index,
        }));
      },
      rerank: async ({ results }) => ({ results, reranked: false }),
      sleep: async () => {},
    },
  })) events.push(event);

  assert.deepEqual(offsets, [0, 5, 10, 15, 20]);
  const collected = events.find((event) => event.type === 'collection_done');
  assert.equal(collected.totalCollected, 25);
  assert.equal(collected.stopReason, 'target_reached');
  assert.equal(collected.roundsExecuted, 5);
  assert.equal(collected.providerStats.openalex.calls, 5);
  assert.equal(collected.providerStats.openalex.received, 25);

  const done = events.find((event) => event.type === 'done');
  assert.equal(done.stats.searchAudit.target, 25);
  assert.equal(done.stats.searchAudit.targetReached, true);
  assert.equal(done.stats.searchAudit.stopReason, 'target_reached');
  assert.equal(done.stats.searchAudit.providers.openalex.selected, 3);
  assert.equal(typeof done.stats.searchAudit.providers.openalex.meanSelectedQuality, 'number');
});

test('deep retrieval hard-clamps requested candidates to one thousand', async () => {
  const generator = runAgenticBatch({
    query: 'quantumfoobar zetaomega',
    target: 5000,
    batchSize: 50,
    topK: 1,
    providers: ['openalex'],
    resolveDois: false,
    deps: { retrieve: async () => [], sleep: async () => {} },
  });
  const first = await generator.next();
  assert.equal(first.value.type, 'start');
  assert.equal(first.value.target, 1000);
  assert.equal(first.value.limits.requestedTarget, 1000);
  assert.ok(first.value.limits.maxCandidates >= 1000);
  await generator.return();
});
