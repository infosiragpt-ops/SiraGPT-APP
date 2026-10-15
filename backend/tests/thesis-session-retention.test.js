'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const request = require('supertest');

const {
  buildRouteTestApp,
  installAuthSessionMock,
  mockResolvedModule,
  reloadModule,
} = require('./http-test-utils');

const HOUR = 60 * 60 * 1000;

function session(userId, status, updatedAtMs, extra = {}) {
  const iso = new Date(updatedAtMs).toISOString();
  return {
    status,
    progress: status === 'completed' ? 100 : 40,
    message: status,
    userId,
    topics: ['t'],
    searchResults: [],
    thesisContent: null,
    createdAt: iso,
    lastUpdated: iso,
    ...extra,
  };
}

describe('thesis sessions: TTL sweep + cap', () => {
  let auth;
  let route;
  let INTERNAL;
  let savedEnv;
  const restoreMocks = [];

  beforeEach(() => {
    savedEnv = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      SIRAGPT_THESIS_SESSION_TTL_MS: process.env.SIRAGPT_THESIS_SESSION_TTL_MS,
      SIRAGPT_THESIS_SESSION_MAX: process.env.SIRAGPT_THESIS_SESSION_MAX,
    };
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
    delete process.env.SIRAGPT_THESIS_SESSION_TTL_MS;
    delete process.env.SIRAGPT_THESIS_SESSION_MAX;
    auth = installAuthSessionMock({ id: 'thesis-ttl-user' });
    route = reloadModule('../src/routes/thesis');
    INTERNAL = route.INTERNAL;
  });

  afterEach(async () => {
    auth.restore();
    while (restoreMocks.length) await restoreMocks.pop()();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('the sweep timer never keeps the process alive', () => {
    assert.equal(INTERNAL.thesisSessionSweepTimer.hasRef(), false);
  });

  test('TTL and cap are env-configurable; junk or too-small values fall back', () => {
    assert.equal(INTERNAL.THESIS_SESSION_TTL_MS, 24 * HOUR);
    assert.equal(INTERNAL.THESIS_SESSION_MAX, 500);
    process.env.SIRAGPT_THESIS_SESSION_TTL_MS = '120000';
    process.env.SIRAGPT_THESIS_SESSION_MAX = '7';
    let reloaded = reloadModule('../src/routes/thesis').INTERNAL;
    assert.equal(reloaded.THESIS_SESSION_TTL_MS, 120000);
    assert.equal(reloaded.THESIS_SESSION_MAX, 7);
    process.env.SIRAGPT_THESIS_SESSION_TTL_MS = '5'; // below the 60 s floor
    process.env.SIRAGPT_THESIS_SESSION_MAX = 'abc';
    reloaded = reloadModule('../src/routes/thesis').INTERNAL;
    assert.equal(reloaded.THESIS_SESSION_TTL_MS, 24 * HOUR);
    assert.equal(reloaded.THESIS_SESSION_MAX, 500);
  });

  test('an expired finished session is evicted and its routes answer the existing 404 shapes', async () => {
    const now = Date.now();
    const id = 'thesis-thesis-ttl-user-1-old';
    INTERNAL.thesisSessions.set(id, session('thesis-ttl-user', 'completed', now - 25 * HOUR, {
      documentPath: '/nowhere/Thesis.docx',
      documentFilename: 'Thesis.docx',
    }));

    assert.equal(INTERNAL.sweepThesisSessions(now), 1);
    assert.equal(INTERNAL.thesisSessions.has(id), false);

    const app = buildRouteTestApp('/api/thesis', route);
    const status = await request(app).get(`/api/thesis/status/${id}`).set('Authorization', auth.authHeader);
    assert.equal(status.status, 404);
    assert.equal(status.body.error, 'Session not found');
    assert.match(status.body.message, /expired/);
    assert.equal(status.body.requestedSessionId, id);

    const download = await request(app).get(`/api/thesis/download/${id}`).set('Authorization', auth.authHeader);
    assert.equal(download.status, 404);
    assert.deepEqual(download.body, { error: 'Session not found' });

    const shot = await request(app).get(`/api/thesis/screenshots/${id}/a.png`);
    assert.equal(shot.status, 404);
    assert.deepEqual(shot.body, { error: 'Screenshot not found' });
  });

  test('a finished session inside the TTL is kept and still served', async () => {
    const now = Date.now();
    const id = 'thesis-thesis-ttl-user-2-fresh';
    INTERNAL.thesisSessions.set(id, session('thesis-ttl-user', 'error', now - HOUR));
    assert.equal(INTERNAL.sweepThesisSessions(now), 0);
    const res = await request(buildRouteTestApp('/api/thesis', route))
      .get(`/api/thesis/status/${id}`)
      .set('Authorization', auth.authHeader);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'error');
  });

  test('a running session is never evicted, however old, nor by the cap', () => {
    const now = Date.now();
    INTERNAL.thesisSessions.set('running-status', session('u', 'generating', now - 365 * 24 * HOUR));
    // Terminal status but the background job has not settled yet.
    INTERNAL.thesisSessions.set('running-inflight', session('u', 'completed', now - 365 * 24 * HOUR));
    INTERNAL.thesisJobsInFlight.add('running-inflight');

    assert.equal(INTERNAL.sweepThesisSessions(now, { maxSessions: 0 }), 0);
    assert.equal(INTERNAL.thesisSessions.size, 2);
  });

  test('the cap evicts the oldest finished sessions first and keeps running ones', () => {
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      INTERNAL.thesisSessions.set(`done-${i}`, session('u', 'completed', now - (10 - i) * 60_000));
    }
    INTERNAL.thesisSessions.set('busy', session('u', 'searching', now - 20 * 60_000));

    assert.equal(INTERNAL.sweepThesisSessions(now, { maxSessions: 3 }), 3);
    assert.deepEqual([...INTERNAL.thesisSessions.keys()].sort(), ['busy', 'done-3', 'done-4']);
  });

  test('compaction keeps what the status route needs and drops the bulk', async () => {
    const id = 'thesis-thesis-ttl-user-3-compact';
    const results = Array.from({ length: 9 }, (_, i) => ({
      source: 'DuckDuckGo', url: `https://e.test/${i}`, topic: 't', content: 'x'.repeat(30_000), detailedContent: 'y'.repeat(50_000),
    }));
    const s = session('thesis-ttl-user', 'completed', Date.now(), { searchResults: results, thesisContent: 'z'.repeat(200_000) });
    INTERNAL.thesisSessions.set(id, s);
    INTERNAL.compactThesisSession(s);

    assert.equal(s.thesisContent, null);
    assert.deepEqual(s.searchResults[0], { source: 'DuckDuckGo', url: 'https://e.test/0', topic: 't' });
    const res = await request(buildRouteTestApp('/api/thesis', route))
      .get(`/api/thesis/status/${id}`)
      .set('Authorization', auth.authHeader);
    assert.equal(res.body.sourcesCount, 9);
    assert.equal(res.body.searchResults.length, 6);
  });

  test('POST /generate enforces the cap before inserting and compacts the session when the job ends', async () => {
    // Offline background job: no browser, no LLM, no document write.
    restoreMocks.push(mockResolvedModule(require.resolve('playwright'), {
      chromium: { launch: async () => { throw new Error('no browser in tests'); } },
    }));
    class OfflineOpenAI { constructor() { this.chat = { completions: { create: async () => { throw new Error('offline'); } } }; } }
    restoreMocks.push(mockResolvedModule(require.resolve('openai'), OfflineOpenAI));
    restoreMocks.push(mockResolvedModule(require.resolve('../src/services/document-service'), {
      createDocument: async () => ({ filePath: '/tmp/none.docx', safeFilename: 'none.docx' }),
    }));
    process.env.SIRAGPT_THESIS_SESSION_MAX = '3';
    route = reloadModule('../src/routes/thesis');
    INTERNAL = route.INTERNAL;

    const now = Date.now();
    for (let i = 0; i < 3; i += 1) {
      INTERNAL.thesisSessions.set(`done-${i}`, session('u', 'completed', now - (10 - i) * 60_000));
    }

    const res = await request(buildRouteTestApp('/api/thesis', route))
      .post('/api/thesis/generate')
      .set('Authorization', auth.authHeader)
      .send({ topics: ['Gestión de inventarios en pymes agroindustriales'] });
    assert.equal(res.status, 200);
    const { sessionId } = res.body;
    // The job mkdirs uploads/screenshots/<sessionId> before launching the browser.
    restoreMocks.push(() => fs.rm(path.join(__dirname, '../uploads/screenshots', sessionId), { recursive: true, force: true }));

    assert.equal(INTERNAL.thesisSessions.size, 3);
    assert.equal(INTERNAL.thesisSessions.has('done-0'), false);
    assert.ok(INTERNAL.thesisJobsInFlight.has(sessionId));

    const deadline = Date.now() + 10_000;
    while (INTERNAL.thesisJobsInFlight.has(sessionId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(INTERNAL.thesisJobsInFlight.has(sessionId), false);
    const finished = INTERNAL.thesisSessions.get(sessionId);
    assert.equal(finished.status, 'completed');
    assert.equal(finished.thesisContent, null);
  });
});
