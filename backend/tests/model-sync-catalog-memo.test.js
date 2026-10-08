'use strict';

/**
 * ensureStaticCatalogModels({ maxAgeMs }) — the hot read paths (admin models
 * page, IMAGE/VIDEO pickers, every video generation) reuse a recent finished
 * pass instead of re-running one UPDATE per catalog model (~280 sequential
 * writes, ~6.5 s on `GET /api/admin/models` in production 2026-10-08).
 * Without `maxAgeMs` (admin «Sync models») a pass always runs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ModelSyncService, STATIC_CATALOG_MEMO_MS } = require('../src/services/model-sync-service');

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function buildService({ now, failFirst = false } = {}) {
  let findManyCalls = 0;
  let attempts = 0;
  const service = new ModelSyncService({
    now,
    prismaClient: {
      aiModel: {
        async findMany() {
          findManyCalls++;
          attempts++;
          if (failFirst && attempts === 1) throw new Error('transient DB blip');
          return [];
        },
        async update() { return {}; },
        async create() { return {}; },
        async updateMany() { return { count: 0 }; },
      },
    },
  });
  return { service, calls: () => findManyCalls };
}

test('memo constant is exported and positive', () => {
  assert.equal(STATIC_CATALOG_MEMO_MS, 10 * 60_000);
  assert.equal(ModelSyncService.STATIC_CATALOG_MEMO_MS, STATIC_CATALOG_MEMO_MS);
});

test('a finished pass is reused within maxAgeMs and re-run once it expires', async () => {
  const clock = fakeClock();
  const { service, calls } = buildService({ now: clock.now });

  const first = await service.ensureStaticCatalogModels({ types: ['IMAGE'], maxAgeMs: 10_000 });
  assert.equal(calls(), 1);

  clock.advance(5_000);
  const second = await service.ensureStaticCatalogModels({ types: ['IMAGE'], maxAgeMs: 10_000 });
  assert.equal(calls(), 1, 'a pass younger than maxAgeMs must be reused');
  assert.strictEqual(second, first, 'the memoized result object is returned as-is');

  clock.advance(5_001);
  await service.ensureStaticCatalogModels({ types: ['IMAGE'], maxAgeMs: 10_000 });
  assert.equal(calls(), 2, 'an expired pass re-runs');
});

test('without maxAgeMs every call runs a pass (admin «Sync models» semantics)', async () => {
  const clock = fakeClock();
  const { service, calls } = buildService({ now: clock.now });

  await service.ensureStaticCatalogModels({ types: ['IMAGE'] });
  await service.ensureStaticCatalogModels({ types: ['IMAGE'] });
  assert.equal(calls(), 2);

  // A memo written by a maxAgeMs caller does not short-circuit a plain call.
  await service.ensureStaticCatalogModels({ types: ['IMAGE'], maxAgeMs: 60_000 });
  assert.equal(calls(), 2, 'the plain pass just above satisfies the memo');
  await service.ensureStaticCatalogModels({ types: ['IMAGE'] });
  assert.equal(calls(), 3, 'a call without maxAgeMs always runs');
});

test('memo is keyed by the requested types', async () => {
  const clock = fakeClock();
  const { service, calls } = buildService({ now: clock.now });

  await service.ensureStaticCatalogModels({ types: ['IMAGE'], maxAgeMs: 60_000 });
  await service.ensureStaticCatalogModels({ types: ['VIDEO'], maxAgeMs: 60_000 });
  assert.equal(calls(), 2, 'different type sets are different passes');
  await service.ensureStaticCatalogModels({ types: ['VIDEO'], maxAgeMs: 60_000 });
  assert.equal(calls(), 2);
});

test('failures are never memoized', async () => {
  const clock = fakeClock();
  const { service, calls } = buildService({ now: clock.now, failFirst: true });

  await assert.rejects(
    () => service.ensureStaticCatalogModels({ types: ['IMAGE'], maxAgeMs: 60_000 }),
    /transient DB blip/,
  );
  await service.ensureStaticCatalogModels({ types: ['IMAGE'], maxAgeMs: 60_000 });
  assert.equal(calls(), 2, 'the failed attempt did not populate the memo');
  await service.ensureStaticCatalogModels({ types: ['IMAGE'], maxAgeMs: 60_000 });
  assert.equal(calls(), 2, 'the successful pass is memoized');
});

test('concurrent callers still share one in-flight pass and then the memo', async () => {
  const clock = fakeClock();
  const { service, calls } = buildService({ now: clock.now });
  const [a, b] = await Promise.all([
    service.ensureStaticCatalogModels({ types: ['IMAGE'], maxAgeMs: 60_000 }),
    service.ensureStaticCatalogModels({ types: ['IMAGE'], maxAgeMs: 60_000 }),
  ]);
  assert.deepEqual(a, b);
  assert.equal(calls(), 1);
});

test('hot read paths pass the memo window; the admin sync button does not', () => {
  const admin = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin.js'), 'utf8');
  const ai = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
  const memoCalls = (src) => (src.match(/ensureStaticCatalogModels\(\{[^}]*maxAgeMs: modelSyncService\.STATIC_CATALOG_MEMO_MS/g) || []).length;
  assert.ok(memoCalls(admin) >= 2, 'GET /models and GET /models/stats reuse a recent pass');
  assert.ok(memoCalls(ai) >= 3, 'the chat catalog, IMAGE and VIDEO pickers reuse a recent pass');
  const syncStart = admin.indexOf("router.post('/models/sync'");
  const syncRoute = admin.slice(syncStart, admin.indexOf('\nrouter.', syncStart + 1));
  assert.ok(syncRoute.includes('ensureStaticCatalogModels('), 'the sync route still calls the service');
  assert.doesNotMatch(syncRoute, /maxAgeMs/, 'the admin «Sync models» button always runs a pass');
});
