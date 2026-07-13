'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { identityKeyFor, mergeReferenceData, sourceToData } = require('../src/services/research/research-library');
const { toBibTeX, toRIS } = require('../src/services/research/reference-export');
const { auditReferences } = require('../src/services/research/reference-audit');
const { buildCitationGraph } = require('../src/services/research/citation-graph');
const { identity, syncToMendeley, syncToZotero } = require('../src/services/research/reference-manager-sync');
const request = require('supertest');
const { buildRouteTestApp, installAuthSessionMock, reloadModule } = require('./http-test-utils');
const prisma = require('../src/config/database');

const references = [{
  id: 'r1',
  title: 'Clinical management of arterial hypertension',
  doi: 'https://doi.org/10.1000/ABC.1',
  authors: [{ name: 'María García' }, { name: 'John Smith' }],
  year: 2024,
  venue: 'Clinical Evidence',
  tags: ['hypertension'],
  url: 'https://example.org/paper',
}];

test('scientific reference identity canonicalizes DOI and falls back to title plus year', () => {
  assert.equal(identityKeyFor(references[0]), 'doi:10.1000/abc.1');
  assert.equal(identity(references[0]), '10.1000/abc.1');
  assert.equal(identityKeyFor({ title: 'Árboles y salud', year: 2024 }), identityKeyFor({ title: 'Arboles y salud', year: 2024 }));
});

test('source normalization and merge preserve richer metadata and union tags/providers', () => {
  const incoming = sourceToData({ ...references[0], source: 'pubmed', sources: ['crossref'], abstract: 'Detailed abstract.' }, { userId: 'u1', tags: ['saved'] });
  const merged = mergeReferenceData({ ...incoming, abstract: 'Short', tags: ['old'], sources: ['openalex'], citationCount: 3 }, { ...incoming, citationCount: 20 });
  assert.equal(incoming.doi, '10.1000/abc.1');
  assert.deepEqual(incoming.sources.sort(), ['crossref', 'pubmed']);
  assert.equal(merged.abstract, 'Detailed abstract.');
  assert.equal(merged.citationCount, 20);
  assert.deepEqual(merged.tags.sort(), ['hypertension', 'old', 'saved']);
  assert.ok(merged.sources.includes('openalex'));
});

test('BibTeX and RIS exports preserve DOI, authors, title and tags', () => {
  const bib = toBibTeX(references);
  const ris = toRIS(references);
  assert.match(bib, /@article\{/);
  assert.match(bib, /doi = \{10\.1000\/ABC\.1\}/i);
  assert.match(bib, /author = \{María García and John Smith\}/);
  assert.match(ris, /TY  - JOUR/);
  assert.match(ris, /AU  - María García/);
  assert.match(ris, /DO  - 10\.1000\/ABC\.1/i);
});

test('reference audit reports used, unused, orphan, invalid DOI and duplicates', () => {
  const result = auditReferences('García et al. (2024) found benefits [1]. Another claim [4].', [
    references[0],
    { id: 'r2', title: 'Unused', authors: [{ name: 'Ana Ruiz' }], year: 2020, doi: 'not-a-doi' },
    { ...references[0], id: 'r3' },
  ]);
  assert.ok(result.usedReferenceIds.includes('r1'));
  assert.ok(result.unusedReferenceIds.includes('r2'));
  assert.ok(result.orphanCitations.some((citation) => citation.token === '[4]'));
  assert.equal(result.invalidDois[0].referenceId, 'r2');
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.passed, false);
});

test('citation graph expands references and citing works through OpenAlex', async () => {
  const fetchImpl = async (url) => {
    if (/filter=cites(?::|%3A)W123/.test(String(url))) {
      return { ok: true, json: async () => ({ results: [{ id: 'https://openalex.org/W999', display_name: 'Citing work', publication_year: 2025, cited_by_count: 8 }] }) };
    }
    return { ok: true, json: async () => ({ id: 'https://openalex.org/W123', display_name: references[0].title, publication_year: 2024, doi: 'https://doi.org/10.1000/abc.1', cited_by_count: 10, referenced_works: ['https://openalex.org/W456'] }) };
  };
  const graph = await buildCitationGraph(references, { fetchImpl, env: {}, limit: 1 });
  assert.ok(graph.nodes.some((node) => node.id === 'W123' && node.role === 'seed'));
  assert.ok(graph.nodes.some((node) => node.id === 'W456' && node.role === 'reference'));
  assert.ok(graph.nodes.some((node) => node.id === 'W999' && node.role === 'citing'));
  assert.ok(graph.edges.some((edge) => edge.from === 'W123' && edge.to === 'W456'));
  assert.ok(graph.edges.some((edge) => edge.from === 'W999' && edge.to === 'W123'));
});

test('Zotero sync creates a collection and skips existing DOI duplicates', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/collections')) return { ok: true, json: async () => ({ successful: { 0: { key: 'COLL1' } } }) };
    if (String(url).includes('/items?')) return { ok: true, json: async () => ([{ key: 'EXISTING1', data: { DOI: '10.1000/abc.1', title: references[0].title, date: '2024', collections: [] } }]) };
    return { ok: true, json: async () => ({ successful: { 0: { key: 'ITEM1' } } }) };
  };
  const result = await syncToZotero([...references, { ...references[0], id: 'r2', doi: '10.1000/new.2', title: 'New paper' }], { apiKey: 'secret', userId: '42', fetchImpl });
  assert.equal(result.collectionKey, 'COLL1');
  assert.equal(result.created, 1);
  assert.equal(result.linkedExisting, 1);
  assert.equal(result.skippedDuplicates, 1);
  assert.ok(calls.every((call) => call.options.headers['Zotero-API-Key'] === 'secret'));
});

test('Mendeley sync deduplicates documents and adds each record to a folder', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/folders')) return { ok: true, json: async () => ({ id: 'F1' }) };
    if (String(url).includes('/documents?')) return { ok: true, json: async () => ([{ id: 'D1', title: references[0].title, year: 2024, identifiers: { doi: '10.1000/abc.1' } }]) };
    return { ok: true, json: async () => ({ id: 'D2' }) };
  };
  const result = await syncToMendeley([...references, { ...references[0], id: 'r2', doi: '10.1000/new.2', title: 'New paper' }], { accessToken: 'secret', fetchImpl });
  assert.equal(result.folderId, 'F1');
  assert.equal(result.created, 1);
  assert.equal(result.skippedDuplicates, 1);
  assert.ok(calls.some((call) => call.url.endsWith('/folders/F1/documents')));
});

test('research-library route saves, lists, exports and audits owned references', async (t) => {
  const auth = installAuthSessionMock();
  const refs = [];
  const collections = [];
  const originals = {
    collectionUpsert: prisma.researchCollection.upsert,
    collectionFindFirst: prisma.researchCollection.findFirst,
    collectionFindMany: prisma.researchCollection.findMany,
    referenceFindUnique: prisma.researchReference.findUnique,
    referenceFindMany: prisma.researchReference.findMany,
    referenceCreate: prisma.researchReference.create,
    referenceUpdate: prisma.researchReference.update,
    referenceCount: prisma.researchReference.count,
    itemUpsert: prisma.researchCollectionItem.upsert,
    conflictCount: prisma.researchReferenceConflict.count,
    conflictUpsert: prisma.researchReferenceConflict.upsert,
  };
  t.after(() => {
    auth.restore();
    prisma.researchCollection.upsert = originals.collectionUpsert;
    prisma.researchCollection.findFirst = originals.collectionFindFirst;
    prisma.researchCollection.findMany = originals.collectionFindMany;
    prisma.researchReference.findUnique = originals.referenceFindUnique;
    prisma.researchReference.findMany = originals.referenceFindMany;
    prisma.researchReference.create = originals.referenceCreate;
    prisma.researchReference.update = originals.referenceUpdate;
    prisma.researchReference.count = originals.referenceCount;
    prisma.researchCollectionItem.upsert = originals.itemUpsert;
    prisma.researchReferenceConflict.count = originals.conflictCount;
    prisma.researchReferenceConflict.upsert = originals.conflictUpsert;
  });
  prisma.researchCollection.upsert = async ({ where, create }) => {
    let row = collections.find((item) => item.userId === where.userId_name.userId && item.name === where.userId_name.name);
    if (!row) { row = { id: `c${collections.length + 1}`, ...create, createdAt: new Date(), updatedAt: new Date() }; collections.push(row); }
    return row;
  };
  prisma.researchCollection.findFirst = async ({ where }) => collections.find((item) => item.id === where.id && item.userId === where.userId) || null;
  prisma.researchCollection.findMany = async () => collections.map((item) => ({ ...item, _count: { items: refs.filter((ref) => ref.collectionItems?.some((entry) => entry.collectionId === item.id)).length } }));
  prisma.researchReference.findUnique = async ({ where }) => refs.find((item) => item.userId === where.userId_identityKey.userId && item.identityKey === where.userId_identityKey.identityKey) || null;
  prisma.researchReference.findMany = async ({ where = {}, take } = {}) => {
    let rows = refs.filter((item) => !where.userId || item.userId === where.userId);
    if (where.status) rows = rows.filter((item) => item.status === where.status);
    if (where.id?.in) rows = rows.filter((item) => where.id.in.includes(item.id));
    if (where.id?.not) rows = rows.filter((item) => item.id !== where.id.not);
    if (where.titleKey) rows = rows.filter((item) => item.titleKey === where.titleKey);
    if (where.collectionItems?.some?.collectionId) rows = rows.filter((item) => item.collectionItems?.some((entry) => entry.collectionId === where.collectionItems.some.collectionId));
    return rows.slice(0, take || rows.length);
  };
  prisma.researchReference.create = async ({ data }) => { const row = { id: `r${refs.length + 1}`, status: 'active', createdAt: new Date(), updatedAt: new Date(), collectionItems: [], ...data }; refs.push(row); return row; };
  prisma.researchReference.update = async ({ where, data }) => { const row = refs.find((item) => item.id === where.id); Object.assign(row, data, { updatedAt: new Date() }); return row; };
  prisma.researchReference.count = async ({ where } = {}) => (await prisma.researchReference.findMany({ where })).length;
  prisma.researchCollectionItem.upsert = async ({ where, create }) => {
    const ref = refs.find((item) => item.id === where.collectionId_referenceId.referenceId);
    if (ref && !ref.collectionItems.some((item) => item.collectionId === create.collectionId)) ref.collectionItems.push({ collectionId: create.collectionId });
    return create;
  };
  prisma.researchReferenceConflict.count = async () => 0;
  prisma.researchReferenceConflict.upsert = async ({ create }) => create;

  const app = buildRouteTestApp('/api/research-library', reloadModule('../src/routes/research-library'));
  const save = await request(app).post('/api/research-library/references').set('Authorization', auth.authHeader).send({ sources: references, collectionName: 'Tesis' });
  assert.equal(save.status, 201);
  assert.equal(save.body.created, 1);
  assert.equal(save.body.collection.name, 'Tesis');

  const list = await request(app).get('/api/research-library').set('Authorization', auth.authHeader);
  assert.equal(list.status, 200);
  assert.equal(list.body.references.length, 1);
  assert.equal(list.body.collections[0]._count.items, 1);

  const exported = await request(app).post('/api/research-library/export').set('Authorization', auth.authHeader).send({ collectionId: 'c1', format: 'bibtex' });
  assert.equal(exported.status, 200);
  assert.match(exported.text, /@article/);

  const audit = await request(app).post('/api/research-library/audit').set('Authorization', auth.authHeader).send({ text: 'García et al. (2024) [1].', referenceIds: ['r1'] });
  assert.equal(audit.status, 200);
  assert.equal(audit.body.counts.used, 1);
});
