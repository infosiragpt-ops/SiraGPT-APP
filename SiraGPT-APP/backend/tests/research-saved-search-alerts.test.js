'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildRouteTestApp, installAuthSessionMock, reloadModule } = require('./http-test-utils');
const prisma = require('../src/config/database');
const scientificSearch = require('../src/services/scientific-search');

const {
  applySavedSearchFilters,
  executeSavedSearch,
  nextRunForSchedule,
  normalizeSavedSearchFilters,
  paperIdentity,
  runDueSavedSearches,
} = require('../src/services/research/saved-search-alerts');

const papers = [
  { title: 'Older review', doi: 'https://doi.org/10.1000/OLD', year: 2019, citations: 80, openAccess: true, source: 'pubmed', studyType: 'systematic_review', peerReviewStatus: 'confirmed', integrityStatus: 'clear' },
  { title: 'Recent trial', doi: '10.1000/new', year: 2025, citations: 12, openAccess: false, source: 'openalex', studyType: 'rct', peerReviewStatus: 'confirmed', integrityStatus: 'clear' },
  { title: 'Retracted item', doi: '10.1000/bad', year: 2026, citations: 500, openAccess: true, source: 'crossref', studyType: 'cohort', peerReviewStatus: 'confirmed', integrityStatus: 'retracted' },
];

test('saved scientific filters are bounded, provider-aware and deterministic', () => {
  const filters = normalizeSavedSearchFilters({
    yearFrom: 2020,
    yearTo: 2035,
    openAccess: false,
    providers: ['OpenAlex', 'unknown'],
    sort: 'date',
    limit: 500,
  });
  assert.equal(filters.yearFrom, 2020);
  assert.equal(filters.yearTo, new Date().getUTCFullYear() + 1);
  assert.deepEqual(filters.providers, ['openalex']);
  assert.equal(filters.limit, 50);
  assert.deepEqual(applySavedSearchFilters(papers, filters).map((paper) => paper.title), ['Recent trial']);
});

test('saved scientific results sort by evidence without promoting retracted work', () => {
  const sorted = applySavedSearchFilters(papers, { sort: 'evidence', limit: 10 });
  assert.equal(sorted[0].title, 'Older review');
  assert.equal(sorted.at(-1).title, 'Retracted item');
  assert.equal(paperIdentity(papers[0]), 'doi:10.1000/old');
  assert.equal(nextRunForSchedule('manual'), null);
  assert.equal(nextRunForSchedule('weekly', new Date('2026-07-01T00:00:00Z')).toISOString(), '2026-07-08T00:00:00.000Z');
});

test('first alert run creates a baseline and a later run notifies only new literature', async () => {
  const notifications = [];
  let row = {
    id: 'saved-1',
    userId: 'user-1',
    name: 'Hipertensión',
    query: 'arterial hypertension randomized trial',
    filters: { limit: 10 },
    kind: 'scientific',
    schedule: 'daily',
    active: true,
    notifyInApp: true,
    lastRunAt: null,
    resultIdentities: null,
  };
  const prisma = {
    savedSearch: {
      update: async ({ data }) => { row = { ...row, ...data }; return row; },
    },
    notification: {
      create: async ({ data }) => { notifications.push(data); return { id: `n-${notifications.length}`, ...data }; },
    },
  };
  const baseline = await executeSavedSearch(prisma, row, {
    now: new Date('2026-07-01T00:00:00Z'),
    searchImpl: async () => ({ papers: papers.slice(0, 1), errors: [], providers: ['pubmed'] }),
  });
  assert.equal(baseline.baseline, true);
  assert.equal(baseline.newPapers.length, 0);
  assert.equal(notifications.length, 0);

  const second = await executeSavedSearch(prisma, row, {
    now: new Date('2026-07-02T00:00:00Z'),
    searchImpl: async () => ({ papers: papers.slice(0, 2), errors: [], providers: ['pubmed', 'openalex'] }),
  });
  assert.equal(second.baseline, false);
  assert.deepEqual(second.newPapers.map((paper) => paper.title), ['Recent trial']);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, 'research_alert');
  assert.equal(notifications[0].metadata.newCount, 1);
});

test('due alert runner bounds work and records isolated failures', async () => {
  const updates = [];
  const due = [
    { id: 'ok', userId: 'u1', name: 'OK', query: 'ok', filters: {}, kind: 'scientific', schedule: 'daily', active: true, notifyInApp: false, lastRunAt: new Date(), resultIdentities: [] },
    { id: 'bad', userId: 'u1', name: 'Bad', query: 'bad', filters: {}, kind: 'scientific', schedule: 'weekly', active: true, notifyInApp: false, lastRunAt: new Date(), resultIdentities: [] },
  ];
  const prisma = {
    savedSearch: {
      findMany: async ({ take }) => due.slice(0, take),
      update: async ({ where, data }) => { updates.push({ id: where.id, data }); return { ...due.find((item) => item.id === where.id), ...data }; },
    },
    notification: { create: async () => ({}) },
  };
  const result = await runDueSavedSearches(prisma, {
    now: new Date('2026-07-03T00:00:00Z'),
    limit: 2,
    searchImpl: async (query) => {
      if (query === 'bad') throw new Error('provider unavailable');
      return { papers: [], errors: [], providers: [] };
    },
  });
  assert.deepEqual(result, { due: 2, completed: 1, failed: 1, newPapers: 0 });
  assert.match(updates.find((entry) => entry.id === 'bad').data.lastError, /provider unavailable/);
});

test('saved-search routes create, list, update, run and delete an owned scientific alert', async (t) => {
  const auth = installAuthSessionMock();
  let row = null;
  const originals = {
    create: prisma.savedSearch.create,
    findMany: prisma.savedSearch.findMany,
    findFirst: prisma.savedSearch.findFirst,
    findUnique: prisma.savedSearch.findUnique,
    update: prisma.savedSearch.update,
    delete: prisma.savedSearch.delete,
    notificationCreate: prisma.notification.create,
    search: scientificSearch.search,
  };
  t.after(() => {
    auth.restore();
    prisma.savedSearch.create = originals.create;
    prisma.savedSearch.findMany = originals.findMany;
    prisma.savedSearch.findFirst = originals.findFirst;
    prisma.savedSearch.findUnique = originals.findUnique;
    prisma.savedSearch.update = originals.update;
    prisma.savedSearch.delete = originals.delete;
    prisma.notification.create = originals.notificationCreate;
    scientificSearch.search = originals.search;
  });
  prisma.savedSearch.create = async ({ data }) => {
    row = { id: 'saved-route-1', lastRunAt: null, resultIdentities: null, lastResultCount: 0, lastNewCount: 0, createdAt: new Date(), updatedAt: new Date(), ...data };
    return row;
  };
  prisma.savedSearch.findMany = async () => row ? [row] : [];
  prisma.savedSearch.findFirst = async ({ where }) => row?.id === where.id && row?.userId === where.userId ? row : null;
  prisma.savedSearch.findUnique = async ({ where }) => row?.id === where.id ? row : null;
  prisma.savedSearch.update = async ({ data }) => { row = { ...row, ...data, updatedAt: new Date() }; return row; };
  prisma.savedSearch.delete = async () => { const deleted = row; row = null; return deleted; };
  prisma.notification.create = async ({ data }) => ({ id: 'notification-1', ...data });
  scientificSearch.search = async () => ({ papers: papers.slice(0, 2), errors: [], providers: ['pubmed', 'openalex'] });

  const app = buildRouteTestApp('/api/search', reloadModule('../src/routes/search'));
  const created = await request(app).post('/api/search/saved').set('Authorization', auth.authHeader).send({
    name: 'Ensayos de hipertensión',
    query: 'arterial hypertension randomized trial',
    kind: 'scientific',
    schedule: 'daily',
    filters: { yearFrom: 2020, sort: 'evidence' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.kind, 'scientific');
  assert.equal(created.body.schedule, 'daily');

  const listed = await request(app).get('/api/search/saved?kind=scientific').set('Authorization', auth.authHeader);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.items.length, 1);

  const updated = await request(app).patch('/api/search/saved/saved-route-1').set('Authorization', auth.authHeader).send({ schedule: 'weekly', active: true });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.schedule, 'weekly');

  const executed = await request(app).post('/api/search/saved/saved-route-1/run').set('Authorization', auth.authHeader).send({});
  assert.equal(executed.status, 200);
  assert.equal(executed.body.papers.length, 1);
  assert.equal(executed.body.baseline, true);

  const deleted = await request(app).delete('/api/search/saved/saved-route-1').set('Authorization', auth.authHeader);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.ok, true);
});
