'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { DATABASE_CATALOG, DIRECT, catalogSummary } = require('../src/services/scientific-databases-catalog');
const { PROVIDERS } = require('../src/services/scientific-search');

test('catalog exposes 60+ scientific databases', () => {
  assert.ok(DATABASE_CATALOG.length >= 60, `expected >=60, got ${DATABASE_CATALOG.length}`);
});

test('every catalog entry is well-formed', () => {
  for (const d of DATABASE_CATALOG) {
    assert.ok(d.id && typeof d.id === 'string', `bad id: ${JSON.stringify(d)}`);
    assert.ok(d.name && typeof d.name === 'string', `bad name: ${JSON.stringify(d)}`);
    assert.ok(d.discipline && typeof d.discipline === 'string', `bad discipline: ${d.id}`);
    assert.ok(['direct', 'federated'].includes(d.access), `bad access: ${d.id}`);
    assert.ok(typeof d.via === 'string' && d.via.length > 0, `bad via: ${d.id}`);
  }
});

test('catalog ids are unique', () => {
  const ids = DATABASE_CATALOG.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate database id in catalog');
});

test('the 16 direct entries mirror scientific-search PROVIDERS exactly', () => {
  const directIds = DIRECT.map((d) => d.id).sort();
  assert.deepEqual(directIds, [...PROVIDERS].sort(), 'direct catalog drifted from PROVIDERS');
  assert.equal(directIds.length, 16);
});

test('federated entries name their aggregator route', () => {
  const federated = DATABASE_CATALOG.filter((d) => d.access === 'federated');
  const routes = new Set(['openalex', 'crossref', 'core', 'datacite', 'pubmed']);
  for (const d of federated) {
    assert.ok(routes.has(d.via), `federated ${d.id} has unknown via '${d.via}'`);
  }
});

test('catalogSummary counts add up', () => {
  const s = catalogSummary();
  assert.equal(s.total, DATABASE_CATALOG.length);
  assert.equal(s.direct + s.federated, s.total);
  assert.equal(s.direct, 16);
});
